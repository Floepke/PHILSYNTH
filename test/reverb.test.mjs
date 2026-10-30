// Run: node test/reverb.test.mjs   (runs the real DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import reverbDef from '../src/modules/reverb.js';

const SR = 48000;
const Proc = await loadKernel('reverb.dsp.js', SR);

const make = (params = {}) => {
  const r = new Proc();
  r.set = (p) => { for (const [id, value] of Object.entries(p)) r.port.onmessage({ data: { type: 'param', id, value } }); };
  r.set(params);
  return r;
};

// Runs `seconds` of audio; inFn(i) -> [l, r] or null for a disconnected input. onBlock(r, i) can change params.
function run(r, seconds, inFn = () => [0, 0], onBlock) {
  const n = Math.ceil((seconds * SR) / 128) * 128;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let b = 0; b < n; b += 128) {
    onBlock?.(r, b);
    let inputs = [[]];
    if (inFn(b) !== null) {
      const iL = new Float32Array(128);
      const iR = new Float32Array(128);
      for (let s = 0; s < 128; s++) [iL[s], iR[s]] = inFn(b + s);
      inputs = [[iL, iR]];
    }
    const oL = new Float32Array(128);
    const oR = new Float32Array(128);
    const live = r.process(inputs, [[oL, oR]]);
    if (!live) assert.ok(oL.every((v) => v === 0) && oR.every((v) => v === 0), 'false = silent output');
    L.set(oL, b);
    R.set(oR, b);
  }
  return { L, R };
}

const impulse = (i) => (i === 0 ? [1, 1] : [0, 0]);
let seed = 1;
const rnd = () => (((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5) * 2 * Math.sqrt(3);
const noise = () => { const v = rnd(); return [v, v]; };
const rms = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / (to - from)); };
const finite = (x) => x.every(Number.isFinite);

// RT60 via Schroeder backward integration, fitted between -5 and -25 dB
function rt60(x) {
  const e = new Float64Array(x.length);
  let acc = 0;
  for (let i = x.length - 1; i >= 0; i--) e[i] = acc += x[i] * x[i];
  let i5 = 0;
  for (let i = 0; i < x.length; i++) {
    const db = 10 * Math.log10(e[i] / e[0]);
    if (!i5 && db < -5) i5 = i;
    if (db < -25) return ((i - i5) / SR) * 3;
  }
  return Infinity;
}
// energy above ~5 kHz relative to total, via a first difference
const brightness = (x, from, to) => {
  const d = x.slice(from, to).map((v, i, a) => (i ? v - a[i - 1] : 0));
  return rms(d) / rms(x, from, to);
};

// --- module definition ---
{
  const ids = reverbDef.params.map((p) => p.id);
  for (const id of ['mix', 'size', 'damp', 'seed', 'decay']) assert.ok(ids.includes(id), `param ${id}`);
  assert.equal(reverbDef.acceptsMidi, false);
  assert.ok(reverbDef.hasInput && reverbDef.hasOutput);
  assert.ok(reverbDef.color);
}

// --- dry/wet: 0 % is the untouched input ---
{
  const r = make({ mix: 0 });
  const { L, R } = run(r, 0.3, (i) => [Math.sin(i * 0.05), Math.cos(i * 0.03)]);
  for (let i = 0; i < L.length; i++) {
    assert.ok(Math.abs(L[i] - Math.sin(i * 0.05)) < 1e-6);
    assert.ok(Math.abs(R[i] - Math.cos(i * 0.03)) < 1e-6);
  }
}

// --- decay: measured RT60 follows the Decay control across room sizes ---
for (const decay of [0.8, 2.5, 8]) {
  for (const size of [0.3, 0.7]) {
    const { L } = run(make({ mix: 1, decay, size, damp: 0, early: 0, lowCut: 20, highCut: 20000 }), decay * 1.4 + 0.5, impulse);
    const t = rt60(L);
    assert.ok(Math.abs(t / decay - 1) < 0.2, `decay ${decay} size ${size}: RT60 ${t.toFixed(2)}`);
  }
}

// --- room size: bigger room = later echo density build-up (first output arrives later) ---
{
  const first = (size) => {
    const { L } = run(make({ mix: 1, size, early: 0, predelay: 0, diffusion: 0 }), 0.4, impulse);
    return L.findIndex((v) => Math.abs(v) > 1e-4);
  };
  assert.ok(first(1) - first(0.2) > 0.03 * SR, `size: ${first(0.2)} vs ${first(1)}`);
}

// --- damp: tail gets darker ---
{
  const tail = (damp) => run(make({ mix: 1, decay: 3, damp, highCut: 20000 }), 1.5, impulse).L;
  const bright = brightness(tail(0), SR * 0.5, SR * 1.5);
  const dark = brightness(tail(0.9), SR * 0.5, SR * 1.5);
  assert.ok(dark < bright * 0.5, `damp brightness ${bright.toFixed(3)} -> ${dark.toFixed(3)}`);
}

// --- pre-delay: wet starts after the pre-delay ---
{
  const { L } = run(make({ mix: 1, predelay: 0.1, early: 1 }), 0.3, impulse);
  const first = L.findIndex((v) => Math.abs(v) > 1e-4);
  assert.ok(first >= 0.1 * SR && first < 0.1 * SR + 0.02 * SR, `pre-delay onset ${first}`);
}

// --- seeds: deterministic per seed, different between seeds ---
{
  const ir = (s) => run(make({ mix: 1, seed: s }), 0.5, impulse).L;
  const a = ir(7);
  const b = ir(7);
  const c = ir(8);
  assert.deepEqual(a, b, 'same seed, same room');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - c[i]);
  assert.ok(diff > 1, 'different seed, different room');
}

// --- seed change while playing is click-free (no sample jump beyond what the music itself does) ---
{
  const tone = (i) => { const v = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR); return [v, v]; };
  const { L } = run(make({ mix: 1, decay: 2 }), 2, tone, (r, b) => { if (b === SR) r.set({ seed: 42 }); });
  let before = 0;
  let around = 0;
  for (let i = SR / 2; i < SR; i++) before = Math.max(before, Math.abs(L[i] - L[i - 1]));
  for (let i = SR; i < SR + 0.05 * SR; i++) around = Math.max(around, Math.abs(L[i] - L[i - 1]));
  assert.ok(around <= before * 1.2, `seed swap step ${around.toFixed(4)} vs ${before.toFixed(4)}`);
}

// --- loudness: wet noise is in the same ballpark as the input ---
{
  const { L } = run(make({ mix: 1, decay: 2.5 }), 3, noise);
  const level = rms(L, SR * 2);
  assert.ok(level > 0.5 && level < 2, `wet level ${level.toFixed(2)}`);
}

// --- freeze holds the tail, unfreeze lets it decay ---
{
  const r = make({ mix: 1, decay: 1 });
  run(r, 0.5, noise);
  r.set({ freeze: 1 });
  const held = run(r, 4, () => [0, 0]).L;
  const a = rms(held, SR * 0.5, SR * 1);
  const b = rms(held, SR * 3.5, SR * 4);
  assert.ok(a > 0.05 && b / a > 0.9, `freeze ${a.toFixed(3)} -> ${b.toFixed(3)}`);
  r.set({ freeze: 0 });
  const after = run(r, 2, () => [0, 0]).L;
  assert.ok(rms(after, SR * 1.5, SR * 2) < a * 0.05, 'unfreeze decays');
}

// --- stability: extreme settings and wild parameter sweeps stay finite and bounded ---
{
  const r = make({ mix: 1, decay: 30, damp: 0, mod: 1, diffusion: 1, size: 1 });
  const { L, R } = run(r, 4, noise, (rv, b) => {
    rv.set({ size: 0.5 + 0.5 * Math.sin(b / 3000), predelay: 0.25 + 0.25 * Math.sin(b / 5000), width: (b / 128) % 2 });
  });
  assert.ok(finite(L) && finite(R));
  assert.ok(L.reduce((m, v) => Math.max(m, Math.abs(v)), 0) < 50, 'bounded');
}

// --- disconnected input: tail keeps ringing, then the processor sleeps and outputs silence ---
{
  const r = make({ mix: 1, decay: 0.5 });
  run(r, 0.2, noise);
  const tail = run(r, 0.3, () => null).L;
  assert.ok(rms(tail, 0, SR * 0.1) > 0.01, 'tail continues after the input disconnects');
  run(r, 6, () => null);
  assert.equal(r.sleeping, true, 'sleeps when silent');
  const woke = run(r, 0.3, noise).L;
  assert.equal(r.sleeping, false);
  assert.ok(rms(woke, SR * 0.1) > 0.05, 'wakes up on input');
}

// --- mono output buffer (single channel) works ---
{
  const r = make({ mix: 0.5 });
  const oL = new Float32Array(128);
  const iL = new Float32Array(128).fill(0.25);
  r.process([[iL]], [[oL]]);
  assert.ok(finite(oL));
}

console.log('all reverb tests passed');
