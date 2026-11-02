// Run: node test/lfo.test.mjs   (runs the real LFO DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';

const SR = 48000;
const Proc = await loadKernel('lfo.dsp.js', SR);

const l = new Proc();
const msg = (data) => l.port.onmessage({ data });
const values = [];
l.port.postMessage = (v) => values.push(v);
msg({ type: 'rate', value: 10 });
msg({ type: 'wave', value: 2 });
for (let b = 0; b < 100; b++) l.process([], [[new Float32Array(128)]]);
msg({ type: 'wave', value: 4 }); // Random
const start = values.length;
for (let b = 0; b < 3000; b++) l.process([], [[new Float32Array(128)]]); // 8 s = 80 cycles
const r = values.slice(start);

assert.ok(r.every((v) => v >= 0 && v <= 1), 'stays in 0..1');
const maxStep = Math.max(...r.slice(1).map((v, i) => Math.abs(v - r[i])));
// smoothstep slope ≤ 1.5 per cycle; one post = 256 samples = 0.0533 cycles at 10 Hz
assert.ok(maxStep < 1.5 * (256 * 10 / SR) + 1e-9, `smooth, no jumps (max step ${maxStep})`);
// a new target every cycle: the values at cycle boundaries differ and cover the range
const ends = r.filter((_, i) => i % 19 === 0);
assert.ok(Math.max(...r) - Math.min(...r) > 0.6, 'random targets spread over the range');
assert.ok(new Set(ends.map((v) => v.toFixed(3))).size > 30, 'keeps moving to new targets');

// Freq Unit MIDI Pitch: follows the newest held note (pitch curve too), falls back, keeps the last
{
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'freq', value: 3 });
  m({ type: 'param', id: 'unit', value: 4 });
  assert.equal(k.rate, 0, 'stands still before the first note');
  m({ type: 'noteOn', id: 1, pitch: 33 }); // A1 = 55 Hz
  assert.equal(k.rate, 55);
  m({ type: 'noteOn', id: 2, pitch: 45 });
  assert.equal(k.rate, 110, 'newest note wins');
  m({ type: 'noteMod', notes: [[2, 57, 1]] });
  assert.equal(k.rate, 220, 'follows its pitch curve');
  m({ type: 'noteMod', notes: [[1, 21, 1]] });
  assert.equal(k.rate, 220, 'older notes do not change it');
  m({ type: 'noteOff', id: 2 });
  assert.equal(k.rate, 27.5, 'the previous held note takes over');
  m({ type: 'noteOff', id: 1 });
  assert.equal(k.rate, 27.5, 'none held: keeps the last pitch');
  const p0 = k.phase;
  for (let b = 0; b < 375; b++) k.process([], [[new Float32Array(128)]]); // 1 s
  assert.ok(Math.abs(((k.phase - p0 + 1) % 1) - ((27.5 * 375 * 128 / SR) % 1)) < 1e-6, 'phase advances at the note frequency');
  m({ type: 'param', id: 'unit', value: 0 });
  assert.equal(k.rate, 3, 'Hz: Frequency again');
}

console.log('lfo tests passed');
