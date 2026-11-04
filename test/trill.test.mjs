import assert from 'node:assert/strict';
import trill, { nextKey, divisionSeconds, ORDERS } from '../src/modules/trill.js';
import { getModule } from '../src/modules/index.js';
import { DOCS } from '../src/moduledocs.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
function setup(rand = () => 0.5, bpm = 120) {
  const clocks = new Set();
  const ctx = { currentTime: 0 };
  const log = [];
  const target = {
    noteOn(id, pitch, velocity, phase, time) { log.push({ type: 'on', id, pitch, velocity, phase, time, at: ctx.currentTime }); },
    noteMod(id, pitch, velocity) { log.push({ type: 'mod', id, pitch, velocity }); },
    noteOff(id) { log.push({ type: 'off', id, at: ctx.currentTime }); },
    allOff() { assert.fail('panic releases only the trill’s own notes'); },
  };
  const dsp = {
    create() { return { param() {}, destroy() {} }; },
    onClock(fn) { clocks.add(fn); return () => clocks.delete(fn); },
  };
  const inst = trill.create(ctx, trill, { dsp }, { rand });
  inst.getMidiTargets = () => [target];
  inst.setBpm(bpm);
  inst.setParam('humanize', 0);
  // advance the audio clock in 1 ms steps (the real clock ticks about every 5 ms)
  const run = (to) => { while (ctx.currentTime < to - 1e-9) { ctx.currentTime = Math.round((ctx.currentTime + 0.001) * 1e6) / 1e6; for (const fn of [...clocks]) fn(ctx.currentTime); } };
  const ons = () => log.filter((e) => e.type === 'on');
  return { inst, ctx, log, clocks, run, ons, target };
}

assert.equal(getModule('TRILL'), trill);
assert.ok(DOCS.TRILL);
assert.deepEqual(trill.params.map((p) => p.id), ['order', 'separation', 'length', 'humanize']);
assert.deepEqual(ORDERS, ['random', 'up', 'down', 'up-down']);
assert.equal(trill.params[1].format(16), '1/16');
assert.equal(trill.acceptsMidi && trill.midiOut, true);

// whole-note divisions at the BPM: 120 BPM whole note = 2 s
near(divisionSeconds(16, 120), 0.125);
near(divisionSeconds(12, 120), 2 / 12);
near(divisionSeconds(1, 60), 4);
near(divisionSeconds(500, 120), 0.02, 1e-12); // clamped to 1/100
near(divisionSeconds(0, 120), 2);

// two keys: strict alternation on the exact grid, starting at once on the first key
{
  const s = setup();
  s.inst.setParam('separation', 16);
  s.inst.setParam('length', 32);
  s.inst.noteOn(1, 60, 0.8, 0.25);
  assert.equal(s.ons().length, 1, 'first key sounds immediately');
  assert.equal(s.ons()[0].phase, 0.25, 'first note keeps the key phase');
  s.inst.noteOn(2, 62, 0.6, 0);
  s.run(1);
  const ons = s.ons();
  assert.deepEqual(ons.map((e) => e.pitch), [60, 62, 60, 62, 60, 62, 60, 62, 60]);
  ons.forEach((e, i) => near(e.time, i * 0.125));
  assert.deepEqual(ons.map((e) => e.velocity), [0.8, 0.6, 0.8, 0.6, 0.8, 0.6, 0.8, 0.6, 0.8]);
  assert.ok(ons.slice(1).every((e) => e.phase === 0));
  assert.equal(new Set(ons.map((e) => e.id)).size, ons.length, 'own id per note');
  // every note is released after its length (1/32 = 62.5 ms)
  const offs = s.log.filter((e) => e.type === 'off');
  for (const on of ons.slice(0, -1)) near(offs.find((o) => o.id === on.id).at, on.time + 0.063, 0.0011);
  // release both keys: no new notes, the last note rings out, the clock stops
  s.inst.noteOff(1);
  s.inst.noteOff(2);
  s.run(1.2);
  assert.equal(s.ons().length, ons.length);
  assert.equal(s.log.filter((e) => e.type === 'off').length, ons.length);
  assert.equal(s.clocks.size, 0, 'no clock while idle');
  assert.equal(s.inst.hasPendingMidi, false);
}

// BPM changes the speed
{
  const s = setup(() => 0.5, 60);
  s.inst.setParam('separation', 4);
  s.inst.noteOn(1, 60, 1);
  s.inst.noteOn(2, 64, 1);
  s.run(2.5);
  assert.deepEqual(s.ons().map((e) => e.time), [0, 1, 2]);
  s.inst.destroy();
}

// orders with three keys
for (const [order, start, want] of [
  [1, 64, [64, 67, 72, 60, 64, 67, 72, 60]],
  [2, 64, [64, 60, 72, 67, 64, 60, 72, 67]],
  [3, 64, [64, 67, 72, 67, 64, 60, 64, 67]],
]) {
  const s = setup();
  s.inst.setParam('order', order);
  s.inst.setParam('separation', 8); // 0.25 s
  s.inst.noteOn(1, start, 1);
  for (const [i, p] of [[2, 72], [3, 60], [4, 67]].filter(([, p]) => p !== start)) s.inst.noteOn(i, p, 1);
  s.run(1.9);
  assert.deepEqual(s.ons().map((e) => e.pitch), want, ORDERS[order]);
  s.inst.destroy();
}

// random: never the same note twice in a row, all held notes are used
{
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = setup(rand);
  s.inst.setParam('separation', 64);
  s.inst.setParam('length', 64);
  for (const [i, p] of [[1, 60], [2, 63], [3, 67], [4, 70]].entries()) s.inst.noteOn(p[0], p[1], 1, 0, i);
  s.run(3);
  const pitches = s.ons().map((e) => e.pitch);
  assert.ok(pitches.length > 80);
  for (let i = 1; i < pitches.length; i++) assert.notEqual(pitches[i], pitches[i - 1]);
  assert.deepEqual([...new Set(pitches)].sort(), [60, 63, 67, 70]);
  s.inst.destroy();
}
{
  const state = { dir: 1 };
  const keys = [{ inId: 1, pitch: 60, seq: 0 }, { inId: 2, pitch: 64, seq: 1 }];
  for (const o of [0, 1, 2, 3]) assert.equal(nextKey(keys, keys[0], o, state, () => 0.99).pitch, 64, 'two keys alternate in every order');
  assert.equal(nextKey([], null, 0, state), null);
}

// humanize: onsets stay within ±40 % of the separation around the grid (no drift), lengths and
// velocities vary within their bounds; at 0 % everything is exact (checked above)
{
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = setup(rand);
  s.inst.setParam('humanize', 1);
  s.inst.setParam('separation', 10); // 0.2 s
  s.inst.setParam('length', 20); // 0.1 s
  s.inst.noteOn(1, 60, 0.5);
  s.inst.noteOn(2, 62, 0.5);
  s.run(10);
  const ons = s.ons();
  assert.ok(ons.length >= 48);
  let moved = 0;
  ons.forEach((e, i) => {
    const err = e.time - i * 0.2;
    assert.ok(Math.abs(err) <= 0.08 + 1e-9, `onset ${i} off grid by ${err}`);
    if (Math.abs(err) > 0.05) moved++;
    assert.ok(e.velocity >= 0.4 - 1e-9 && e.velocity <= 0.6 + 1e-9);
    if (i) assert.ok(e.time > ons[i - 1].time);
  });
  assert.ok(moved > 10, 'humanize moves the notes');
  const offs = new Map(s.log.filter((e) => e.type === 'off').map((e) => [e.id, e.at]));
  const lens = ons.filter((e) => offs.has(e.id)).map((e) => offs.get(e.id) - e.time);
  assert.ok(lens.every((l) => l >= 0.07 - 0.0011 && l <= 0.13 + 0.0011));
  assert.ok(Math.max(...lens) - Math.min(...lens) > 0.04, 'lengths vary');
  s.inst.destroy();
}

// overlapping lengths: a note that comes back cuts its previous copy first
{
  const s = setup();
  s.inst.setParam('separation', 16);
  s.inst.setParam('length', 2); // 1 s, much longer than the separation
  s.inst.noteOn(1, 60, 1);
  s.inst.noteOn(2, 62, 1);
  s.run(0.3);
  const [a, b, c] = s.ons();
  assert.deepEqual([a.pitch, b.pitch, c.pitch], [60, 62, 60]);
  const offA = s.log.findIndex((e) => e.type === 'off' && e.id === a.id);
  assert.ok(offA >= 0 && offA < s.log.indexOf(c), 'old 60 released before the new 60');
  assert.ok(!s.log.some((e) => e.type === 'off' && e.id === b.id), '62 still rings');
  s.inst.destroy();
  assert.ok(s.log.some((e) => e.type === 'off' && e.id === b.id), 'destroy releases sounding notes');
  assert.equal(s.clocks.size, 0);
}

// keys join and leave during the trill; a single key repeats; pitch bends follow
{
  const s = setup();
  s.inst.setParam('separation', 8);
  s.inst.noteOn(1, 60, 1);
  s.run(0.6);
  assert.deepEqual(s.ons().map((e) => e.pitch), [60, 60, 60], 'one key repeats');
  s.inst.noteOn(2, 65, 1);
  s.run(1.1);
  assert.deepEqual(s.ons().map((e) => e.pitch), [60, 60, 60, 65, 60]);
  s.inst.noteMod(2, 66, 0.5);
  s.run(1.3);
  assert.equal(s.ons().at(-1).pitch, 66);
  s.inst.noteMod(2, 67, 0.5);
  assert.deepEqual(s.log.at(-1), { type: 'mod', id: s.ons().at(-1).id, pitch: 67, velocity: 0.5 });
  s.inst.noteOff(1);
  s.run(1.8);
  assert.deepEqual(s.ons().slice(-2).map((e) => e.pitch), [67, 67]);
  s.inst.destroy();
}

// a new trill after releasing all keys starts again on its first key; panic stops everything
{
  const s = setup();
  s.inst.setParam('order', 1);
  s.inst.noteOn(1, 60, 1);
  s.inst.noteOn(2, 64, 1);
  s.run(0.2);
  s.inst.noteOff(1);
  s.inst.noteOff(2);
  s.run(0.5);
  const n = s.ons().length;
  s.inst.noteOn(3, 64, 1);
  s.inst.noteOn(4, 60, 1);
  assert.equal(s.ons().at(-1).pitch, 64);
  near(s.ons().at(-1).time, 0.5);
  s.run(0.6);
  assert.equal(s.ons().length, n + 2);
  s.inst.allOff();
  const count = s.log.length;
  assert.equal(s.clocks.size, 0);
  assert.equal(s.inst.hasPendingMidi, false);
  s.run(1);
  assert.equal(s.log.length, count, 'nothing after panic');
  const ids = s.ons().map((e) => e.id);
  const offs = new Set(s.log.filter((e) => e.type === 'off').map((e) => e.id));
  assert.ok(ids.every((id) => offs.has(id)), 'every note released');
}

// a bent sounding note is cut when its new pitch comes back
{
  const s = setup();
  s.inst.setParam('separation', 8);
  s.inst.setParam('length', 1);
  s.inst.noteOn(1, 60, 1);
  const a = s.ons()[0];
  s.inst.noteMod(1, 61, 1);
  s.run(0.25);
  const b = s.ons()[1];
  assert.equal(b.pitch, 61);
  const offA = s.log.findIndex((e) => e.type === 'off' && e.id === a.id);
  assert.ok(offA >= 0 && offA < s.log.indexOf(b));
  s.inst.destroy();
}

// a removed target gets note-offs for its sounding notes and nothing more
{
  const s = setup();
  s.inst.setParam('length', 1);
  s.inst.noteOn(1, 60, 1);
  s.inst.releaseTarget(s.target);
  assert.equal(s.log.at(-1).type, 'off');
  const count = s.log.length;
  s.inst.getMidiTargets = () => [];
  s.run(0.5);
  assert.equal(s.log.length, count);
  s.inst.destroy();
}

console.log('trill tests passed');
