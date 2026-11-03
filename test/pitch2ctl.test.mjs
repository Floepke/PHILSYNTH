// Run: node test/pitch2ctl.test.mjs   (PITCH2CTL: key range mapping, kernel, panel keyboard, patch)
import assert from 'node:assert/strict';

import { dspTestHost } from './dsphost.mjs';

globalThis.sampleRate = 48000;
const { default: P2C, pitchPos } = await import('../src/modules/pitch2ctl.dsp.js');
const { keyGeometry, keyAt, WHITE_KEYS } = await import('../src/modules/pitch2ctlview.js');
const { getModule } = await import('../src/modules/index.js');
const { keyLabel } = await import('../src/modules/pitch2ctl.js');

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

// ---- definition ----
const def = getModule('PITCH2CTL');
assert.ok(def.modulator && def.acceptsMidi && !def.liveMidi && !def.hasInput && def.hasOutput);
assert.deepEqual(def.params.map((p) => p.id), ['outController', 'outMin', 'outMax', 'lowKey', 'highKey', 'noteOffAction', 'smooth']);
const lowP = def.params.find((p) => p.id === 'lowKey');
const highP = def.params.find((p) => p.id === 'highKey');
assert.deepEqual([lowP.min, lowP.max, lowP.default, highP.default], [0, 127, 21, 108]);
assert.equal(keyLabel(60), 'C4 (60)');
assert.equal(keyLabel(0), 'C-1 (0)');
assert.equal(keyLabel(127), 'G9 (127)');

// ---- mapping ----
assert.equal(pitchPos(36, 36, 96), 0);
assert.equal(pitchPos(96, 36, 96), 1);
assert.equal(pitchPos(66, 36, 96), 0.5);
assert.equal(pitchPos(10, 36, 96), 0, 'below the range: Out Min');
assert.equal(pitchPos(120, 36, 96), 1, 'above the range: Out Max');
near(pitchPos(66.3, 36, 96), 30.3 / 60, 'cents count');
assert.equal(pitchPos(36, 96, 36), 1, 'flipped: Low Key above High Key');
assert.equal(pitchPos(96, 96, 36), 0);
assert.equal(pitchPos(59, 60, 60), 0, 'Low = High: a switch');
assert.equal(pitchPos(60, 60, 60), 1);

// ---- kernel ----
{
  const k = new P2C();
  assert.equal(P2C.modulator, true, 'a modulator kernel');
  assert.deepEqual([k.lowKey, k.highKey], [21, 108], 'starts at the 88-key piano range');
  k.message({ type: 'noteOn', id: 9, pitch: 64.5 });
  assert.equal(k.value, 0.5, 'halfway A0..C8');
  k.param('lowKey', 36);
  k.param('highKey', 96);
  k.message({ type: 'allOff' });
  k.message({ type: 'noteOn', id: 1, pitch: 66, velocity: 0.1 });
  assert.equal(k.value, 0.5, 'pitch, not velocity');
  k.message({ type: 'noteMod', notes: [[1, 81, 0.9]] });
  assert.equal(k.value, 0.75, 'pitch curve of the newest note');
  k.message({ type: 'noteOn', id: 2, pitch: 36 });
  k.message({ type: 'noteMod', notes: [[1, 96, 1]] });
  assert.equal(k.value, 0, 'newest note wins');
  k.param('lowKey', 24);
  k.param('highKey', 48);
  assert.equal(k.value, 0.5, 'a new range moves the held value');
  k.param('lowKey', 200);
  assert.equal(k.lowKey, 127, 'keys clamp to 0..127');
  k.param('lowKey', 24);
  k.message({ type: 'noteOff', id: 2 });
  assert.equal(k.value, 0.5, 'Do Nothing holds');
  k.param('highKey', 36);
  assert.equal(k.value, 1, 'a held value still follows the range');
  k.param('noteOffAction', 1);
  k.message({ type: 'noteOn', id: 3, pitch: 30 });
  k.message({ type: 'noteOff', id: 3 });
  assert.equal(k.value, 0, 'Control Down');
  k.param('highKey', 48);
  assert.equal(k.value, 0, 'after Control Down the range does not move it back');
  k.param('noteOffAction', 2);
  k.message({ type: 'noteOn', id: 4, pitch: 30 });
  k.message({ type: 'allOff' });
  assert.equal(k.value, 1, 'Control Up on stop');
}
{
  // Smooth (inherited from VELOCITY2CTL): later values glide
  const k = new P2C();
  k.param('smooth', 1000);
  k.param('lowKey', 36);
  k.param('highKey', 96);
  k.message({ type: 'noteOn', id: 1, pitch: 36 });
  assert.equal(k.value, 0, 'first note jumps');
  k.message({ type: 'noteOn', id: 2, pitch: 96 });
  assert.equal(k.value, 0);
  for (let i = 0; i < 375; i++) k.process();
  near(k.value, 1, 'arrives after one second', 1e-6);
}

// ---- panel keyboard geometry: 128 keys, 75 white ----
assert.equal(WHITE_KEYS, 75);
const W = 750;
assert.deepEqual(keyGeometry(0, W), { left: 0, width: 10, centre: 5 });
assert.equal(keyGeometry(1, W).centre, 10, 'C#-1 sits on the C/D border');
assert.ok(keyGeometry(1, W).width < 10);
const g127 = keyGeometry(127, W);
near(g127.left + g127.width, W, 'G9 ends at the right edge');
for (const p of [0, 1, 36, 60, 61, 96, 127]) assert.equal(keyAt(keyGeometry(p, W).centre, W, true), p, `keyAt finds ${p} (upper part)`);
assert.equal(keyAt(keyGeometry(1, W).centre, W, false), 2, 'lower part: the white key under the black one');
assert.equal(keyAt(3, W, true), 0, 'C left of the C# key');
assert.equal(keyAt(12, W, false), 2, 'below the black keys: D');
assert.equal(keyAt(-50, W), 0);
assert.equal(keyAt(W + 50, W), 127);

// ---- in a patch: drives a controller, saved like any module ----
{
  const ctx = { currentTime: 0 };
  const { dsp, render } = dspTestHost();
  const { PatchRuntime } = await import('../src/patch.js');
  const engine = { ctx, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const r = await PatchRuntime.create(engine, dsp.destination);
  const mm = await r.addModule('MULTIMIDI');
  const osc = await r.addModule('OSC');
  const p2c = await r.addModule('PITCH2CTL');
  assert.ok(r.connect(mm.id, p2c.id), 'MULTIMIDI -> PITCH2CTL (MIDI cable)');
  assert.ok(r.connect(p2c.id, osc.id), 'PITCH2CTL -> OSC (control cable)');
  assert.equal(r.connect(osc.id, p2c.id), false, 'no audio input');
  r.setParam(p2c.id, 'outController', 7); // OSC duty 0..100
  r.setParam(p2c.id, 'lowKey', 48);
  r.setParam(p2c.id, 'highKey', 72);
  r.setParam(osc.id, 'duty', 70);
  render(2);
  assert.equal(osc.values.duty, 70, 'nothing driven before the first note');
  mm.inst.noteOn(1, 60, 0.9);
  render(2);
  assert.equal(osc.values.duty, 50, 'C4 is halfway C3..C5');
  assert.equal(p2c.inst.playing.pitch, 60, 'the panel keyboard lights the playing note');
  r.setParam(p2c.id, 'outMin', 20);
  r.setParam(p2c.id, 'outMax', 60);
  render(1);
  assert.equal(osc.values.duty, 40, 'Out Min / Out Max trim the output');
  mm.inst.noteOn(2, 84, 0.9);
  render(1);
  assert.equal(osc.values.duty, 60, 'above High Key: Out Max');
  mm.inst.noteOff(2);
  render(1);
  assert.equal(p2c.inst.playing, null);
  const saved = r.toJSON().modules.find((m) => m.type === 'PITCH2CTL');
  assert.equal(saved.values.lowKey, 48);
  assert.equal(saved.values.highKey, 72);
}

console.log('pitch2ctl tests passed');
