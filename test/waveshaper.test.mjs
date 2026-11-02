// Run: node test/waveshaper.test.mjs   (runs the real WAVESHAPER DSP kernel)
// A silent input block (a source reporting silence, e.g. a half sine's zero half through a
// MODULATOR) must give the same samples as a block of real zeros: the oversampling and the built-in
// DC blocker fade out instead of jumping to 0 (a click). Silent again once settled.
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';

const SR = 48000;
const Proc = await loadKernel('waveshaper.dsp.js', SR);
const block = () => [[new Float32Array(128), new Float32Array(128)]];
const halfSine = (n) => Math.max(0, Math.sin((2 * Math.PI * 40 * n) / SR)); // 40 Hz: 600-sample zero half

assert.ok(!Proc.passive, 'not passive: it has memory, so the graph keeps running it on silent input');

for (const os of [0, 1, 2]) {
  const run = (gapAsSilence) => {
    const k = new Proc();
    k.port.onmessage({ data: { type: 'param', id: 'oversample', value: os } });
    const out = [];
    let n = 0;
    for (let b = 0; b < 200; b++) {
      const L = new Float32Array(128);
      for (let i = 0; i < 128; i++, n++) L[i] = halfSine(n);
      const o = block();
      const live = k.process(gapAsSilence && L.every((v) => v === 0) ? [[]] : [[L]], o);
      out.push(...(live === false ? new Float32Array(128) : o[0][0]));
    }
    return out;
  };
  const real = run(false);
  const gapped = run(true);
  assert.ok(Math.max(...real.map((v, i) => Math.abs(v - gapped[i]))) < 1e-6, `oversample ${os}: silent blocks = zeros, no click`);
  const maxStep = Math.max(...gapped.slice(1).map((v, i) => Math.abs(v - gapped[i])));
  assert.ok(maxStep < 0.05, `oversample ${os}: no jumps (${maxStep})`);
}

// rings out after the input stops, then reports silence and stays silent
{
  const k = new Proc();
  k.process([[new Float32Array(128).fill(0.5)]], block());
  let blocks = 0;
  while (k.process([[]], block()) !== false) assert.ok(++blocks < 200, 'settles');
  assert.ok(blocks > 2, `rings out over a few blocks (${blocks})`);
  assert.equal(k.process([[]], block()), false, 'then stays silent');
  assert.equal(new Proc().process([[]], block()), false, 'a fresh one is silent without input');
}

console.log('waveshaper tests passed');
