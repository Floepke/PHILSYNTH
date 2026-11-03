// Run: node test/pitch2ctl.test.mjs   (PITCH2CTL: per-key map, kernel, panel editor helpers, patch)
import assert from 'node:assert/strict';

import { dspTestHost } from './dsphost.mjs';

globalThis.sampleRate = 48000;
const { default: P2C, defaultMap, rampMap, normalizeMap, mapAt, KEYS } = await import('../src/modules/pitch2ctl.dsp.js');
const { drawLine, keyAtX, valueAtY, layout, clampView, zoomView, MIN_SPAN } = await import('../src/modules/pitch2ctlview.js');
const { getModule } = await import('../src/modules/index.js');

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

// ---- definition: the map is module state, not controllers ----
const def = getModule('PITCH2CTL');
assert.ok(def.modulator && def.acceptsMidi && !def.liveMidi && !def.hasInput && def.hasOutput);
assert.deepEqual(def.params.map((p) => p.id), ['outController', 'outMin', 'outMax', 'noteOffAction', 'smooth']);
assert.equal(def.defaultState().map.length, 128);
assert.deepEqual(def.normalizeState({ map: [2, -1, 'x'] }).map.slice(0, 4), [1, 0, 0, 0], 'clamped, missing keys from the default');

// ---- map helpers ----
assert.equal(KEYS, 128);
const d = defaultMap();
assert.deepEqual([d[0], d[21], d[108], d[127]], [0, 0, 1, 1], 'default: the 88-key piano ramp A0..C8');
near(d[64], 43 / 87, 'straight line between', 1e-4);
assert.deepEqual(normalizeMap(null), d);
assert.deepEqual(rampMap(60, 60).slice(59, 61), [0, 1], 'a switch');
const m = Array.from({ length: 128 }, (_, p) => (p === 60 ? 0.2 : p === 61 ? 0.8 : 0));
assert.equal(mapAt(m, 60), 0.2);
assert.equal(mapAt(m, 61), 0.8);
near(mapAt(m, 60.5), 0.5, 'between two keys: linear');
near(mapAt(m, 60.25), 0.35, 'cents count');
assert.equal(mapAt(rampMap(0, 127), 127), 1, 'top key');
assert.equal(mapAt(rampMap(0, 127), 500), 1, 'above 127: the top key');
assert.equal(mapAt(rampMap(0, 127), -3), 0);

// ---- kernel ----
{
  const k = new P2C();
  assert.equal(P2C.modulator, true, 'a modulator kernel');
  k.message({ type: 'noteOn', id: 9, pitch: 64.5 });
  assert.equal(k.value, 0.5, 'default map: halfway A0..C8');
  k.message({ type: 'map', map: m });
  assert.equal(k.value, 0, 'a new map moves the sounding value');
  k.message({ type: 'allOff' });
  k.message({ type: 'noteOn', id: 1, pitch: 60, velocity: 0.9 });
  assert.equal(k.value, 0.2, 'the key value, not velocity');
  k.message({ type: 'noteMod', notes: [[1, 60.5, 0.1]] });
  near(k.value, 0.5, 'a glide moves smoothly between key values');
  k.message({ type: 'noteOn', id: 2, pitch: 61 });
  k.message({ type: 'noteMod', notes: [[1, 60, 1]] });
  assert.equal(k.value, 0.8, 'newest note wins');
  k.message({ type: 'noteOff', id: 2 });
  assert.equal(k.value, 0.8, 'Do Nothing holds');
  k.message({ type: 'map', map: m.map((v) => 1 - v) });
  near(k.value, 0.2, 'a held value follows the map');
  k.param('noteOffAction', 1);
  k.message({ type: 'noteOn', id: 3, pitch: 60 });
  k.message({ type: 'noteOff', id: 3 });
  assert.equal(k.value, 0, 'Control Down');
  k.message({ type: 'map', map: m });
  assert.equal(k.value, 0, 'after Control Down a new map does not move it back');
  k.param('noteOffAction', 2);
  k.message({ type: 'noteOn', id: 4, pitch: 30 });
  k.message({ type: 'allOff' });
  assert.equal(k.value, 1, 'Control Up on stop');
}
{
  // Smooth (inherited from VELOCITY2CTL): later values glide
  const k = new P2C();
  k.param('smooth', 1000);
  k.message({ type: 'map', map: rampMap(36, 96) });
  k.message({ type: 'noteOn', id: 1, pitch: 36 });
  assert.equal(k.value, 0, 'first note jumps');
  k.message({ type: 'noteOn', id: 2, pitch: 96 });
  assert.equal(k.value, 0);
  for (let i = 0; i < 375; i++) k.process();
  near(k.value, 1, 'arrives after one second', 1e-6);
}

// ---- panel editor helpers ----
{
  const zero = new Array(128).fill(0);
  const a = drawLine(zero, 10, 0, 14, 1);
  assert.deepEqual(a.slice(9, 16), [0, 0, 0.25, 0.5, 0.75, 1, 0], 'a stroke fills the keys in between');
  assert.deepEqual(drawLine(zero, 14, 1, 10, 0).slice(10, 15), [0, 0.25, 0.5, 0.75, 1], 'either direction');
  assert.equal(drawLine(zero, 5, 0.3, 5, 0.7)[5], 0.7, 'one key: the newest value');
  assert.equal(zero[12], 0, 'the map is not changed in place');
  assert.equal(keyAtX(0, 256), 0);
  assert.equal(keyAtX(3.9, 256), 1, 'columns of equal width');
  assert.equal(keyAtX(999, 256), 127);
  assert.equal(keyAtX(0, 240, 48, 24), 48, 'zoomed: the first visible key');
  assert.equal(keyAtX(239, 240, 48, 24), 71);
  assert.equal(keyAtX(15, 240, 48.5, 24), 50, 'scrolled by half a key');
  assert.deepEqual(clampView(-5, 24), { start: 0, span: 24 }, 'not before C-1');
  assert.deepEqual(clampView(120, 24), { start: 104, span: 24 }, 'not after G9');
  assert.deepEqual(clampView(0, 2), { start: 0, span: MIN_SPAN }, 'at most one octave across');
  assert.deepEqual(clampView(30, 500), { start: 0, span: 128 }, 'at least all keys');
  assert.deepEqual(zoomView({ start: 0, span: 128 }, 0.5, 0.5), { start: 32, span: 64 }, 'zoom in around the middle');
  const z = zoomView({ start: 32, span: 64 }, 0.5, 0.25);
  assert.equal(z.span, 32);
  near(z.start + 0.25 * z.span, 32 + 0.25 * 64, 'the key under the pointer stays in place');
  assert.deepEqual(zoomView({ start: 100, span: 28 }, 4, 1), { start: 16, span: 112 }, 'zooming out stays inside the keys');
  assert.deepEqual(zoomView({ start: 10, span: 28 }, 4, 0.5), { start: 0, span: 112 });
  const { top, gh, strip } = layout(256, 200);
  assert.equal(valueAtY(top, 200), 1, 'top: Out Max');
  assert.equal(valueAtY(top + gh, 200), 0, 'bottom: Out Min');
  assert.equal(valueAtY(strip + 10, 200), 0, 'clamped');
  near(valueAtY(top + gh / 4, 200), 0.75, 'linear');
}

// ---- in a patch: drives a controller, the map is saved and loaded with the project ----
{
  const ctx = { currentTime: 0 };
  const { dsp, render } = dspTestHost();
  const { PatchRuntime } = await import('../src/patch.js');
  const engine = { ctx, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const r = await PatchRuntime.create(engine, dsp.destination);
  const mm = await r.addModule('MULTIMIDI');
  const osc = await r.addModule('OSC');
  const p2c = await r.addModule('PITCH2CTL');
  assert.deepEqual(p2c.state.map, defaultMap(), 'a new module has the default map');
  assert.ok(r.connect(mm.id, p2c.id), 'MULTIMIDI -> PITCH2CTL (MIDI cable)');
  assert.ok(r.connect(p2c.id, osc.id), 'PITCH2CTL -> OSC (control cable)');
  assert.equal(r.connect(osc.id, p2c.id), false, 'no audio input');
  r.setParam(p2c.id, 'outController', 7); // OSC duty 0..100
  r.setState(p2c.id, { map: rampMap(48, 72) });
  r.setParam(osc.id, 'duty', 70);
  render(2);
  assert.equal(osc.values.duty, 70, 'nothing driven before the first note');
  mm.inst.noteOn(1, 60, 0.9);
  render(2);
  assert.equal(osc.values.duty, 50, 'C4 is halfway C3..C5');
  assert.equal(p2c.inst.playing.pitch, 60, 'the panel marks the playing note');
  r.setParam(p2c.id, 'outMin', 20);
  r.setParam(p2c.id, 'outMax', 60);
  render(1);
  assert.equal(osc.values.duty, 40, 'Out Min / Out Max trim the output');
  const custom = new Array(128).fill(0);
  custom[60] = 0.25;
  r.setState(p2c.id, { map: custom });
  render(1);
  assert.equal(osc.values.duty, 30, 'a drawn key value');
  mm.inst.noteOff(1);
  render(1);
  assert.equal(p2c.inst.playing, null);
  const saved = r.toJSON().modules.find((m) => m.type === 'PITCH2CTL');
  assert.equal(saved.state.map[60], 0.25, 'the map is saved');
  assert.equal(saved.values.lowKey, undefined, 'no key range controllers any more');
  const r2 = await PatchRuntime.create(engine, dsp.destination);
  const back = await r2.addModule('PITCH2CTL', { values: saved.values, state: saved.state });
  assert.equal(back.state.map[60], 0.25, 'and loaded');
  const old = await r2.addModule('PITCH2CTL', { values: { lowKey: 21, highKey: 108 } });
  assert.deepEqual(old.state.map, defaultMap(), 'a project from before the map: the same 88-key ramp');
}

console.log('pitch2ctl tests passed');
