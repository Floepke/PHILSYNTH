// Run: node test/dcblock.test.mjs   (runs the real DC BLOCKER DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import def from '../src/modules/dcblock.js';

const SR = 48000;
const Proc = await loadKernel('dcblock.dsp.js', SR);
const block = () => [[new Float32Array(128), new Float32Array(128)]];

assert.deepEqual(def.params, [], 'no controllers');
assert.ok(!Proc.passive, 'not passive: it has memory, so the graph keeps running it on silent input');

// a constant 1 glides to zero in ~40 ms, starting at 1 without a jump
{
  const k = new Proc();
  const out = [];
  for (let b = 0; b < 30; b++) {
    const o = block();
    k.process([[new Float32Array(128).fill(1)]], o);
    out.push(...o[0][0]);
  }
  assert.ok(Math.abs(out[0] - 1) < 1e-6, 'starts at the input');
  assert.ok(out.every((v, i) => i === 0 || v <= out[i - 1]), 'falls monotonically, no jumps');
  const at40ms = out[Math.round(0.04 * SR)];
  assert.ok(at40ms > 0 && at40ms < 0.01, `99 % gone after ~40 ms (${at40ms})`);
}

// The bug: a half sine through a MODULATOR gives whole silent blocks (its zero half on low notes).
// The DC BLOCKER used to be skipped there and output 0 (a jump from its offset correction): now the
// silent blocks are filtered as zeros, the same samples as a block of real zeros.
{
  const halfSine = (n) => Math.max(0, Math.sin((2 * Math.PI * 40 * n) / SR)); // 40 Hz: 600-sample zero half
  const run = (gapAsSilence) => {
    const k = new Proc();
    const out = [];
    let n = 0;
    for (let b = 0; b < 200; b++) {
      const L = new Float32Array(128);
      for (let i = 0; i < 128; i++, n++) L[i] = halfSine(n);
      const zero = L.every((v) => v === 0);
      const o = block();
      const live = k.process(gapAsSilence && zero ? [[]] : [[L]], o);
      out.push(...(live === false ? new Float32Array(128) : o[0][0]));
    }
    return out;
  };
  const real = run(false);
  const gapped = run(true);
  assert.ok(Math.max(...real.map((v, i) => Math.abs(v - gapped[i]))) < 1e-9, 'silent blocks = zeros: no click');
  const maxStep = Math.max(...gapped.slice(1).map((v, i) => Math.abs(v - gapped[i])));
  assert.ok(maxStep < 0.01, `no jumps (${maxStep})`);
}

// after the input stops it rings out, then reports silence (and stays cheap)
{
  const k = new Proc();
  k.process([[new Float32Array(128).fill(0.5)]], block());
  let blocks = 0;
  while (k.process([[]], block()) !== false) assert.ok(++blocks < 100, 'settles');
  assert.ok(blocks > 2, `rings out over a few blocks (${blocks})`);
  assert.equal(k.process([[]], block()), false, 'then stays silent');
}

console.log('dcblock tests passed');
