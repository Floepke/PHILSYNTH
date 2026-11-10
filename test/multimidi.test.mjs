import assert from 'node:assert/strict';
import multimidi, { Drifter } from '../src/modules/multimidi.js';
import { curvePolyline, defaultCurve, sampleAt } from '../src/curve.js';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';
import { emptySong, addClip } from '../src/song.js';
import { renderSong } from '../src/render.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

for (const bipolar of [false, true]) {
  const random = [0.2, 0.8, 0.4];
  let draws = 0;
  const drift = new Drifter(bipolar, () => random[draws++]);
  const value = (v) => bipolar ? v * 2 - 1 : v;
  near(drift.value, value(0.2));
  near(drift.step(0.25, 1), value(0.35));
  near(drift.step(0.25, 1), value(0.5));
  near(drift.step(0.25, 1), value(0.65));
  near(drift.step(1, 0), value(0.65));
  near(drift.step(0, 1), value(0.65));
  assert.equal(draws, 2, 'Hold and zero elapsed time consume no random values');
  drift.step(0.25, 1);
  assert.equal(draws, 3, 'cycle timing still selects a new random destination');
  near(drift.step(0.25, 1), value(0.5875));
}
const customState = () => {
  const state = multimidi.defaultState();
  state.velocityMap[60] = 0.25;
  state.velocityMap[61] = 0.75;
  state.velocityCurve = { points: [{ x: 0, y: 0, r: 0 }, { x: 0.5, y: 0.25, r: 0 }, { x: 1, y: 1, r: 0 }] };
  return state;
};

function setup() {
  const clocks = new Set(), events = [];
  const ctx = { currentTime: 0 };
  const inst = multimidi.create(ctx, multimidi, { dsp: {
    create: () => ({ param() {}, destroy() {} }),
    onClock(fn) { clocks.add(fn); return () => clocks.delete(fn); },
  } }, { rand: () => 0.5 });
  inst.getMidiTargets = () => [{
    noteOn(id, pitch, velocity) { events.push({ type: 'on', id, pitch, velocity }); },
    noteMod(id, pitch, velocity) { events.push({ type: 'mod', id, pitch, velocity }); },
    noteOff(id) { events.push({ type: 'off', id }); },
  }];
  const tick = (time) => { ctx.currentTime = time; for (const fn of clocks) fn(time); };
  return { inst, events, tick, clocks };
}

assert.deepEqual(multimidi.defaultState().velocityMap, new Array(128).fill(1));
assert.deepEqual(multimidi.defaultState().velocityCurve, defaultCurve());
assert.deepEqual(multimidi.normalizeState(null), multimidi.defaultState(), 'old projects retain identity velocity mapping');
const repaired = multimidi.normalizeState({ velocityMap: [-1, 2, NaN, '0.5'], velocityCurve: { points: [] } });
assert.deepEqual(repaired.velocityMap.slice(0, 5), [0, 1, 1, 1, 1]);
assert.equal(repaired.velocityMap.length, 128);
assert.deepEqual(repaired.velocityCurve, defaultCurve());
const independent = multimidi.defaultState();
independent.velocityMap[60] = 0;
assert.equal(multimidi.defaultState().velocityMap[60], 1, 'defaults are not shared');

{
  const { inst, events, tick, clocks } = setup();
  for (let key = 0; key < 128; key++) inst.noteOn(key, key, key / 127);
  events.forEach((event, key) => near(event.velocity, key / 127));
  inst.allOff();
  events.length = 0;
  inst.setState(customState());
  inst.setParam('velocity', 0.8);
  inst.setParam('transpose', 12);
  inst.setParam('finetune', 0.5);
  inst.setParam('overtone', 1);
  inst.noteOn(200, 60, 0.5);
  near(events[0].velocity, 0.25 * 0.25 * 0.8);
  near(events[0].pitch, 84.5);
  inst.noteOn(201, 61, 0.5);
  near(events[1].velocity, 0.25 * 0.75 * 0.8);
  inst.noteOn(202, 62, 0.5);
  near(events[2].velocity, 0.25 * 0.8);
  inst.noteMod(200, 60.5, 0.5);
  near(events.at(-1).velocity, 0.25 * 0.5 * 0.8);
  inst.noteMod(200, 60, 0.75);
  near(events.at(-1).velocity, 0.625 * 0.25 * 0.8);

  const changed = customState();
  changed.velocityMap[60] = 0.5;
  inst.setState(changed);
  tick(0.01);
  near(events.findLast((event) => event.type === 'mod' && event.id === events[0].id).velocity, 0.625 * 0.5 * 0.8);
  assert.equal(events.filter((event) => event.type === 'on').length, 3, 'mapping edits do not retrigger held notes');
  inst.setParam('velDrift', 0.4);
  tick(0.02);
  near(events.findLast((event) => event.type === 'mod' && event.id === events[0].id).velocity, 0.625 * 0.5 * 0.8 * 0.8);
  inst.setParam('velSense', 0);
  tick(0.03);
  near(events.findLast((event) => event.type === 'mod' && event.id === events[0].id).velocity, 0.5 * 0.8 * 0.8);
  inst.noteMod(200, 60, 0.01);
  near(events.findLast((event) => event.type === 'mod' && event.id === events[0].id).velocity, 0.5 * 0.8 * 0.8);
  inst.setParam('velocity', 0);
  tick(0.04);
  assert.equal(events.findLast((event) => event.type === 'mod').velocity, 0);
  inst.destroy();
  assert.equal(clocks.size, 0);
}

// Fractional pitch clamps/interpolates at the map boundaries, and rounded response curves use
// the same polyline as the editor, including non-monotonic curves.
{
  const { inst, events } = setup();
  const state = customState();
  state.velocityMap[0] = 0;
  state.velocityMap[127] = 0.4;
  state.velocityCurve.points[1] = { x: 0.5, y: 1, r: 1 };
  inst.setState(state);
  for (const [id, pitch] of [[1, -12], [2, 60.5], [3, 140]]) {
    inst.noteOn(id, pitch, 0.5);
  }
  const response = sampleAt(curvePolyline(state.velocityCurve.points), 0.5);
  near(events[0].velocity, 0);
  near(events[1].velocity, response * 0.5);
  near(events[2].velocity, response * 0.4);
  inst.destroy();
}

// Delayed notes retain mapped velocity updates and releases in their original order.
{
  const { inst, events, tick } = setup();
  inst.setState(customState());
  inst.setParam('randomDelay', 100);
  inst.noteOn(1, 60, 0.5);
  assert.equal(events.length, 0);
  tick(0.01);
  inst.noteMod(1, 60, 1);
  tick(0.02);
  inst.noteOff(1);
  tick(0.05);
  near(events[0].velocity, 0.25 * 0.25);
  tick(0.06);
  near(events.at(-1).velocity, 0.25);
  tick(0.07);
  assert.deepEqual(events.map((e) => e.type), ['on', 'mod', 'off']);
  inst.destroy();
}

// Module state survives project load, Patch instances, and module copying.
{
  const { dsp } = dspTestHost();
  const engine = { dsp, ctx: { currentTime: 0 } };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const folder = await root.addModule('PATCH');
  const mm = await folder.inst.patch.addModule('MULTIMIDI', { state: customState() });
  root.setParam(folder.id, 'instances', 2);
  await folder.inst.sync();
  assert.deepEqual(folder.inst.clones[0].modules.get(mm.id).state, mm.state);
  const changed = customState();
  changed.velocityMap[60] = 0.125;
  folder.inst.patch.setState(mm.id, changed);
  await folder.inst.sync();
  assert.deepEqual(folder.inst.clones[0].modules.get(mm.id).state, changed);
  const copy = await root.addModule('MULTIMIDI', { state: changed });
  const saved = JSON.parse(JSON.stringify(root.toJSON()));
  const loaded = await PatchRuntime.create(engine, dsp.destination);
  await loaded.load(saved);
  assert.deepEqual(loaded.modules.get(copy.id).state, changed);
  assert.deepEqual(loaded.modules.get(folder.id).inst.patch.modules.get(mm.id).state, changed);
  const legacy = await loaded.addModule('MULTIMIDI');
  assert.deepEqual(legacy.state, multimidi.defaultState());
  root.destroy();
  loaded.destroy();
}

// Offline exports share the mapping implementation, not just live MIDI delivery.
{
  const { dsp } = dspTestHost();
  const root = await PatchRuntime.create({ dsp, ctx: { currentTime: 0 } }, dsp.destination);
  const mm = await root.addModule('MULTIMIDI');
  const osc = await root.addModule('OSC');
  root.connect(mm.id, osc.id);
  root.connect(osc.id, 0);
  const song = emptySong();
  addClip(song, { length: 1, target: mm.id }).notes.push({ pitch: 60, start: 0, length: 0.2, vel: 0.8 });
  const project = { patch: root.toJSON(), song };
  const normal = await renderSong(project, { sampleRate: 8000 });
  assert.ok(normal.peak > 0.01);
  project.patch.modules.find((m) => m.id === mm.id).state.velocityMap[60] = 0;
  const muted = await renderSong(project, { sampleRate: 8000 });
  assert.equal(muted.peak, 0, 'per-key trim silences only that key in offline export');
  root.destroy();
}

console.log('MULTIMIDI velocity mapping tests passed');
