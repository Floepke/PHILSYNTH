import assert from 'node:assert/strict';
import { MidiQueue } from '../src/midiqueue.js';
import { createMidiScheduler } from '../src/midischedule.js';

function harness() {
  const ctx = { currentTime: 0 };
  const clocks = new Set();
  const calls = [];
  const target = Object.fromEntries(['noteOn', 'noteMod', 'noteOff'].map(type => [
    type, (...args) => calls.push({ type, args, at: ctx.currentTime }),
  ]));
  const midi = createMidiScheduler(ctx, {
    onClock(fn) { clocks.add(fn); return () => clocks.delete(fn); },
  }, () => [target]);
  const at = (time) => { ctx.currentTime = time; for (const tick of clocks) tick(time); };
  return { midi, calls, target, at, clocks, ctx };
}

// Equal deadlines are FIFO; arbitrary removals preserve both heap directions. Compare every
// pop with a stable sorted reference, using duplicate deadlines and removal of the last item.
{
  const queue = new MidiQueue();
  let seed = 41;
  const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0);
  const reference = [];
  let comparisons = 0;
  const before = queue.before.bind(queue);
  queue.before = (a, b) => { comparisons++; return before(a, b); };
  for (let i = 0; i < 4000; i++) {
    const item = queue.push({ due: random() % 100 });
    reference.push(item);
    if (i % 3 === 0) {
      const index = random() % reference.length;
      const [remove] = reference.splice(index, 1);
      queue.remove(remove);
      queue.remove(remove); // harmless twice
    }
    if (i % 7 === 0) {
      reference.sort((a, b) => a.due - b.due || a.order - b.order);
      assert.equal(queue.pop(), reference.shift());
    }
  }
  reference.sort((a, b) => a.due - b.due || a.order - b.order);
  for (const item of reference) assert.equal(queue.pop(), item);
  assert.equal(queue.pop(), undefined);
  assert.ok(comparisons < 200000, `heap work must be logarithmic, not a linear insertion scan (${comparisons})`);
  const old = queue.push({ due: 2 });
  queue.clear();
  queue.push({ due: 1 });
  queue.remove(old);
  assert.equal(queue.pop().due, 1);
}

// A short note retains both its delayed start and release. Earlier/later delays across notes
// sort by deadline, and a delayed release keeps offline export alive.
{
  const h = harness();
  h.midi.noteOn(1, 60.25, 0.7, 0.3, 1, 10);
  h.at(0.1);
  h.midi.noteOff(1);
  h.midi.noteOn(2, 64.5, 0.4, 0.1, 0.2, 20);
  assert.equal(h.midi.hasPending, true);
  h.at(0.3);
  assert.deepEqual(h.calls.map(e => e.args[1]), [64.5]);
  assert.equal(h.calls[0].args[4], 20.2);
  h.at(1);
  assert.deepEqual(h.calls.map(e => e.type), ['noteOn', 'noteOn']);
  assert.equal(h.calls[1].args[4], 11);
  assert.equal(h.midi.hasPending, true);
  h.at(1.1);
  assert.deepEqual(h.calls.map(e => e.type), ['noteOn', 'noteOn', 'noteOff']);
  assert.equal(h.midi.hasPending, false, 'a sounding held note alone is not pending');
  h.midi.destroy();
  assert.equal(h.clocks.size, 0);
}

// STRUM's unscheduled notes may be bent/released before their chord batch is flushed.
{
  const h = harness();
  const note = h.midi.noteOn(1, 60, 0.8, 0, null);
  h.midi.noteMod(1, 61.2, 0.4);
  h.midi.noteOff(1);
  h.midi.schedule(note, 0.5);
  h.midi.schedule(note, 0);
  h.at(0.5);
  assert.deepEqual(h.calls.map(e => e.type), ['noteOn', 'noteMod', 'noteOff']);
  assert.ok(h.calls.every(e => e.args[0] === h.calls[0].args[0]));
  assert.equal(h.midi.hasPending, false);
  h.midi.destroy();
}

// Six seconds of release history remain available for late bends. A late update extends the
// expiry, but no updates are delivered after it expires; exact boundary, not the event epsilon.
{
  const h = harness();
  h.midi.noteOn(1, 60, 1);
  h.midi.noteOff(1);
  h.at(5.9);
  h.midi.noteMod(1, 61, 0.5);
  h.at(6);
  h.at(11.9 - 5e-10);
  h.midi.noteMod(1, 62, 0.4);
  assert.equal(h.calls.at(-1).args[1], 62);
  h.at(17.9);
  const count = h.calls.length;
  h.midi.noteMod(1, 63, 0.3);
  assert.equal(h.calls.length, count);
  h.midi.destroy();
}

// Reusing an input id cancels its old queued events and expiry without deleting the new note.
{
  const h = harness();
  h.midi.noteOn(1, 60, 1);
  h.midi.noteOff(1);
  h.at(1);
  h.midi.noteOn(1, 62, 1, 0, 0.5);
  h.midi.noteOn(1, 64, 1, 0, 0.25);
  h.at(1.25);
  h.at(6);
  h.midi.noteMod(1, 65, 0.5);
  h.at(6.25);
  assert.deepEqual(h.calls.filter(e => e.type === 'noteOn').map(e => e.args[1]), [60, 64]);
  assert.equal(h.calls.at(-1).args[1], 65);
  h.midi.destroy();
}

for (const action of ['allOff', 'releaseTarget', 'destroy']) {
  const h = harness();
  h.midi.noteOn(1, 60, 1);
  h.midi.noteOn(2, 62, 1, 0, 2);
  h.midi[action](h.target);
  h.at(3);
  assert.deepEqual(h.calls.map(e => e.type), ['noteOn', 'noteOff'], `${action}: release only the started note; no late start`);
  h.midi.destroy();
}

// Regression for the CPU hotspot: a tick or a single update must not inspect thousands of
// unrelated release-tail records. Count property reads instead of asserting wall-clock speed.
{
  const h = harness();
  const notes = [];
  for (let i = 0; i < 4000; i++) {
    notes.push(h.midi.noteOn(i, 60, 1));
    h.midi.noteOff(i);
  }
  let reads = 0;
  for (const note of notes) {
    const released = note.released;
    Object.defineProperty(note, 'released', { get() { reads++; return released; } });
  }
  h.at(1);
  h.midi.noteMod(0, 61, 0.5);
  assert.equal(h.midi.hasPending, false);
  assert.ok(reads < 10, `an individual update scanned release history (${reads} records)`);
  h.at(6);
  const count = h.calls.length;
  h.midi.noteMod(1, 62, 0.5);
  assert.equal(h.calls.length, count, 'unextended notes expired');
  h.at(7);
  h.midi.noteMod(0, 62, 0.5);
  assert.equal(h.calls.length, count, 'extended note expired too');
  h.midi.destroy();
}

// Immediate updates bypass the deadline heap; extending release history does not churn it.
{
  const h = harness();
  h.midi.noteOn(1, 60, 1);
  h.midi.noteOff(1);
  const push = MidiQueue.prototype.push;
  let pushes = 0;
  MidiQueue.prototype.push = function (item) { pushes++; return push.call(this, item); };
  try {
    for (let i = 0; i < 1000; i++) {
      h.at(i / 1000);
      h.midi.noteMod(1, 60 + i / 1000, 0.5);
    }
    assert.equal(pushes, 0, 'no event allocations in the heap or expiry rescheduling per immediate update');
    assert.equal(h.calls.filter(c => c.type === 'noteMod').length, 1000);
    h.at(6);
    assert.equal(pushes, 1, 'expiry is rescheduled only when its old deadline is reached');
    h.at(7);
    const count = h.calls.length;
    h.midi.noteMod(1, 70, 0.5);
    assert.equal(h.calls.length, count, 'lazy extension still expires at the correct deadline');
  } finally {
    MidiQueue.prototype.push = push;
    h.midi.destroy();
  }
}

// An immediate update cannot overtake queued equal-time starts from other notes.
{
  const h = harness();
  h.midi.noteOn(1, 60, 1);
  h.midi.noteOn(2, 64, 1, 0, 1);
  h.ctx.currentTime = 1; // No clock callback: the start is still in the queue.
  const count = h.calls.length;
  h.midi.noteMod(1, 61, 0.5);
  assert.deepEqual(h.calls.slice(count).map(c => c.type), ['noteOn', 'noteMod']);
  h.midi.destroy();
}

console.log('MIDI deadline queue and scheduler tests passed');
