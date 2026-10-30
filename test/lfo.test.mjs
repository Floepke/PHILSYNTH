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

console.log('lfo tests passed');
