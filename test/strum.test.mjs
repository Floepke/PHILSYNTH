import assert from 'node:assert/strict';
import strum from '../src/modules/strum.js';
import multimidi from '../src/modules/multimidi.js';
import { getModule } from '../src/modules/index.js';
import { Transport } from '../src/transport.js';
import { emptySong, addClip } from '../src/song.js';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function setup(def = strum, rand = () => 0.5) {
  const clocks = new Set();
  const ctx = { currentTime: 0 };
  const log = [];
  const target = {
    noteOn(id, pitch, velocity, phase, time) { log.push({ type: 'on', id, pitch, velocity, phase, time, at: ctx.currentTime }); },
    noteMod(id, pitch, velocity) { log.push({ type: 'mod', id, pitch, velocity, at: ctx.currentTime }); },
    noteOff(id) { log.push({ type: 'off', id, at: ctx.currentTime }); },
    allOff() { assert.fail('panic must release only the processor’s own notes'); },
  };
  const dsp = {
    create() { return { param() {}, destroy() {} }; },
    onClock(fn) { clocks.add(fn); return () => clocks.delete(fn); },
  };
  const inst = def.create(ctx, def, { dsp }, { rand });
  let targets = [target];
  inst.getMidiTargets = () => targets;
  const tick = (at) => { ctx.currentTime = at; for (const fn of clocks) fn(at); };
  return { inst, ctx, dsp, log, target, clocks, tick, setTargets: (list) => { targets = list; } };
}
const batch = async (inst, time = 10, pitches = [67, 60, 64]) => {
  pitches.forEach((p, i) => inst.noteOn(i + 1, p, 0.8, 0.25, time));
  await Promise.resolve();
};

assert.equal(getModule('STRUM'), strum);
assert.equal(strum.params.find(p => p.id === 'duration').max, 5000);
assert.equal(multimidi.params.find(p => p.id === 'randomDelay').max, 5000);
assert.equal(multimidi.params.find(p => p.id === 'randomDelay').default, 0);

for (const [type, pitches] of [[0, [60, 64, 67]], [1, [67, 64, 60]], [2, [64, 67, 60]]]) {
  const s = setup(strum, () => 0);
  s.inst.setParam('strumType', type);
  s.inst.setParam('duration', 1000);
  await batch(s.inst);
  assert.deepEqual(s.log.map(e => e.pitch), [pitches[0]]);
  s.tick(0.499);
  assert.equal(s.log.length, 1);
  s.tick(0.5);
  s.tick(1);
  assert.deepEqual(s.log.map(e => e.pitch), pitches);
  assert.deepEqual(s.log.map(e => e.time), [10, 10.5, 11]);
  assert.ok(s.log.every(e => e.velocity === 0.8 && e.phase === 0.25));
  assert.equal(new Set(s.log.map(e => e.id)).size, 3);
  s.inst.destroy();
  assert.equal(s.clocks.size, 0);
}

// Humanization varies interior spacing, but keeps order and exact duration bounds.
{
  const s = setup(strum, () => 1 - 1e-10);
  s.inst.setParam('duration', 5000);
  s.inst.setParam('humanize', 1);
  await batch(s.inst);
  s.tick(2.5);
  assert.equal(s.log.length, 1);
  s.tick(3.625);
  assert.equal(s.log.length, 2);
  s.tick(5);
  assert.equal(s.log.length, 3);
  near(s.log[1].time, 13.625);
  near(s.log[2].time, 15);
  s.inst.destroy();
}

// Unequal onsets in a single delivery tick are independent, not falsely interpreted as chords.
{
  const s = setup();
  s.inst.noteOn(1, 60, 1, 0, 1);
  s.inst.noteOn(2, 64, 1, 0, 1.001);
  await Promise.resolve();
  assert.equal(s.log.length, 2, 'single notes pass with no strum delay');
  s.inst.destroy();
}
// Batch collection also works on a synchronous offline audio clock, without microtask yields.
{
  const s = setup();
  s.inst.setParam('duration', 1000);
  s.inst.noteOn(1, 67, 1, 0, 0);
  s.inst.noteOn(2, 60, 1, 0, 0);
  s.tick(0.005);
  assert.deepEqual(s.log.map(e => e.pitch), [60]);
  s.tick(1.005);
  assert.deepEqual(s.log.map(e => e.pitch), [60, 67]);
  s.inst.destroy();
}
{
  const s = setup();
  s.inst.setParam('duration', 0);
  await batch(s.inst);
  assert.deepEqual(s.log.map(e => e.pitch), [60, 64, 67]);
  assert.ok(s.log.every(e => e.at === 0));
  s.inst.destroy();
}

// Release and velocity updates keep the same offset as their delayed note.
{
  const s = setup();
  s.inst.setParam('duration', 1000);
  await batch(s.inst);
  s.tick(0.1);
  s.inst.noteMod(1, 68, 0.4);
  s.inst.noteOff(1);
  s.tick(1);
  assert.equal(s.log.at(-1).type, 'on');
  s.tick(1.1);
  const id = s.log.find(e => e.type === 'on' && e.pitch === 67).id;
  assert.deepEqual(s.log.slice(-2).map(e => [e.type, e.id]), [['mod', id], ['off', id]]);
  s.inst.destroy();
}

// Note-off before the batch is flushed must not lose the short note or leave it stuck.
{
  const s = setup();
  s.inst.noteOn(1, 60, 1);
  s.inst.noteOff(1);
  await Promise.resolve();
  assert.deepEqual(s.log.map(e => e.type), ['on', 'off']);
  s.inst.destroy();
}
for (const action of ['allOff', 'destroy']) {
  const s = setup();
  await batch(s.inst);
  s.inst[action]();
  s.tick(10);
  assert.deepEqual(s.log.map(e => e.type), ['on', 'off'], action + ' cancels delayed chord members');
}
{
  const s = setup();
  await batch(s.inst);
  s.inst.releaseTarget(s.target);
  s.setTargets([]);
  s.tick(2);
  assert.deepEqual(s.log.map(e => e.type), ['on', 'off'], 'removed cable cancels pending target notes');
  s.inst.destroy();
}
{
  const s = setup();
  s.inst.noteOn(1, 60, 1);
  s.inst.allOff();
  await Promise.resolve();
  assert.equal(s.log.length, 0, 'panic before batch flush cancels everything');
  s.inst.destroy();
}

// MULTIMIDI samples an independent delay for every note, within the controller maximum.
{
  let next = 0;
  // Each note draws four drift values before its delay value.
  const draws = [0.5, 0.5, 0.5, 0.5, 0.2, 0.5, 0.5, 0.5, 0.5, 0.8];
  const s = setup(multimidi, () => draws[next++] ?? 0.5);
  s.inst.setParam('randomDelay', 5000);
  s.inst.noteOn(1, 60, 0.8, 0.3, 10);
  s.inst.noteOn(2, 64, 0.7, 0.4, 10);
  assert.equal(s.log.length, 0);
  s.tick(0.1);
  s.inst.noteOff(1);
  s.inst.setParam('randomDelay', 0);
  s.tick(1);
  assert.equal(s.log[0].pitch, 60);
  near(s.log[0].time, 11);
  s.tick(1.1);
  assert.equal(s.log[1].type, 'off');
  s.tick(4);
  assert.equal(s.log[2].pitch, 64);
  near(s.log[2].time, 14);
  s.inst.destroy();
}
{
  const s = setup(multimidi);
  s.inst.noteOn(1, 60, 1);
  assert.equal(s.log.length, 1, 'default zero delay preserves immediate MULTIMIDI behavior');
  s.inst.noteOff(1);
  assert.equal(s.log.at(-1).type, 'off', 'release at audio time zero is valid');
  s.inst.noteOff(1);
  assert.equal(s.log.filter(e => e.type === 'off').length, 1);
  s.inst.destroy();
}
for (const action of ['allOff', 'destroy', 'releaseTarget']) {
  const s = setup(multimidi);
  s.inst.setParam('randomDelay', 5000);
  s.inst.noteOn(1, 60, 1);
  s.inst[action](s.target);
  s.tick(6);
  assert.equal(s.log.length, 0, action + ' cancels pending random-delay notes');
  if (action !== 'destroy') s.inst.destroy();
}

// Sequencer integration: equal starts strum, nearby distinct starts do not join the chord.
{
  const s = setup();
  s.inst.setParam('duration', 1000);
  const song = emptySong();
  const clip = addClip(song, { start: 0, length: 4, target: 1 });
  clip.notes.push(...[67, 60, 64].map(pitch => ({ pitch, start: 0, length: 2, vel: 0.8 })),
    { pitch: 72, start: 0.001, length: 1, vel: 0.8 });
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: () => s.inst,
    now: () => 0, ticker: () => ({ start() {}, stop() {} }),
  });
  transport.play();
  transport.tick(5);
  await Promise.resolve();
  assert.deepEqual(s.log.map(e => e.pitch), [60, 72]);
  s.tick(0.5);
  s.tick(1);
  assert.deepEqual(s.log.map(e => e.pitch), [60, 72, 64, 67]);
  transport.stop();
  s.inst.allOff();
  s.inst.destroy();
}
console.log('STRUM and MULTIMIDI random delay tests passed');

// Stock registration, MIDI cables, controller persistence, duplication, and Patch forwarding.
{
  const { dsp } = dspTestHost();
  const ctx = { currentTime: 0 };
  const engine = { ctx, dsp, createPatch: sink => PatchRuntime.create(engine, sink) };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const outer = await root.addModule('PATCH');
  const inner = outer.inst.patch;
  const sm = await inner.addModule('STRUM', { values: { strumType: 1, duration: 5000, humanize: 0.5 } });
  const mm = await inner.addModule('MULTIMIDI', { values: { randomDelay: 3000 } });
  const osc = await inner.addModule('OSC');
  assert.ok(inner.connect(sm.id, mm.id));
  assert.ok(inner.connect(mm.id, osc.id));
  assert.equal(inner.connect(osc.id, sm.id), false, 'STRUM cannot receive audio');
  assert.equal(inner.connect(mm.id, sm.id), false, 'MIDI cycles are rejected');
  const data = root.toJSON();
  await root.load(data);
  assert.deepEqual(root.toJSON(), data, 'new controllers survive save/load');
  const loaded = root.modules.get(outer.id).inst.patch;
  const copy = await loaded.duplicate(sm.id);
  assert.deepEqual(copy.values, loaded.modules.get(sm.id).values, 'STRUM duplication retains all controllers');
  const log = [];
  const target = loaded.modules.get(sm.id).inst;
  const original = target.noteOn;
  target.noteOn = (...args) => { log.push(args); original(...args); };
  root.modules.get(outer.id).inst.noteOn(100, 60, 0.8, 0.2, 42);
  assert.equal(log[0][4], 42, 'Patch preserves exact onset metadata');
  root.destroy();
  assert.equal(dsp.clocks.size, 0, 'all new MIDI clocks unsubscribe on patch destruction');
}
console.log('STRUM patch integration tests passed');
