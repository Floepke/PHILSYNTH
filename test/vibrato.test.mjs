// Run: node test/vibrato.test.mjs   (VIBRATO DSP kernel and module)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';
import { getModule } from '../src/modules/index.js';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';

const SR = 48000;
globalThis.sampleRate = SR;
const { default: Vibrato, vibratoOffset, MAX_OFFSET, MAX_DELAY } = await import('../src/modules/vibrato.dsp.js');
const NativeVibrato = wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), SR).kernels.vibrato;

const def = getModule('VIBRATO');
assert.deepEqual(def.params.map((p) => p.id), ['wave', 'unit', 'freq', 'phase', 'amp'], 'LFO-like controller order');
assert.deepEqual(def.params.map((p) => p.label), ['Waveform', 'Freq Unit', 'Frequency', 'Set Phase', 'Amp']);
assert.deepEqual(def.params[0].options, ['Sine', 'Triangle']);
assert.deepEqual(def.params[1].options, ['Hz', '1/4', '1/8', '1/16'], 'no MIDI Pitch: VIBRATO receives no notes');
assert.equal(def.acceptsMidi, false);
assert.ok(def.hasInput && def.hasOutput);
assert.equal(def.params[1].format ?? null, null);
assert.equal(def.params[2].format(5, { unit: 0 }), '5.00 Hz');
assert.equal(def.params[3].format(0.25), '25 % (90°)');
assert.equal(def.params[4].format(25), '±25 cents');

const fresh = (values = {}) => {
  const k = new Vibrato();
  for (const [id, v] of Object.entries(values)) k.param(id, v);
  return k;
};
const wave = (ph, w) => (w === 1 ? (ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4) : Math.sin(2 * Math.PI * ph));

// offset() is the integral of the pitch wave, ≥ 0, peaking at MAX_OFFSET
for (const w of [0, 1]) {
  let max = 0;
  for (let i = 0; i <= 1000; i++) {
    const p = i / 1000, o = vibratoOffset(p, w);
    assert.ok(o >= -1e-12, 'offset never negative');
    max = Math.max(max, o);
    if (i && i < 1000) {
      const slope = (vibratoOffset(p + 1e-6, w) - vibratoOffset(p - 1e-6, w)) / 2e-6;
      assert.ok(Math.abs(-slope - wave(p, w)) < 1e-4, `offset slope = −wave (${w}, ${p})`);
    }
  }
  assert.ok(Math.abs(max - MAX_OFFSET[w]) < 1e-6);
}

// Renders `seconds` of a sine at f0 and returns the frequency of each cycle (upward zero crossings).
function measure(k, seconds, f0 = 1000) {
  const n = Math.round(seconds * SR);
  const y = new Float32Array(n);
  for (let s = 0; s < n; s += 128) {
    const L = Float32Array.from({ length: 128 }, (_, i) => Math.sin(2 * Math.PI * f0 * (s + i) / SR));
    const out = [[new Float32Array(128), new Float32Array(128)]];
    k.process([[L, L]], out);
    y.set(out[0][0].subarray(0, Math.min(128, n - s)), s);
  }
  const cross = [];
  for (let i = 1; i < n; i++) if (y[i - 1] < 0 && y[i] >= 0) cross.push(i - 1 + y[i - 1] / (y[i - 1] - y[i]));
  return cross.slice(1).map((c, i) => ({ t: (c + cross[i]) / 2 / SR, f: SR / (c - cross[i]) }));
}
const cents = (a, b) => 1200 * Math.log2(a / b);

// The pitch follows the Waveform: ±Amp cents around the input, starting at Set Phase.
for (const w of [0, 1]) for (const start of [0, 0.25, 0.6]) {
  const rate = 3, amp = 100, r = 2 ** (amp / 1200) - 1;
  const k = fresh({ wave: w, freq: rate, amp, phase: start });
  let worst = 0, hi = -Infinity, lo = Infinity;
  for (const { t, f } of measure(k, 1)) {
    if (t < 0.02) continue;
    const want = 1000 * (1 + r * wave((start + rate * t) % 1, w));
    worst = Math.max(worst, Math.abs(cents(f, want)));
    hi = Math.max(hi, cents(f, 1000)); lo = Math.min(lo, cents(f, 1000));
  }
  assert.ok(worst < 1.5, `wave ${w}, phase ${start}: pitch follows the waveform (worst ${worst.toFixed(2)} cents)`);
  assert.ok(Math.abs(hi - 100) < 2, `peak +100 cents (${hi.toFixed(1)})`);
  assert.ok(lo < -100 && lo > -110, `trough about −100 cents (${lo.toFixed(1)})`);
}

// Amp is a pitch depth: the same at slow and fast rates
for (const rate of [1, 12]) {
  const k = fresh({ freq: rate, amp: 50 });
  const hi = Math.max(...measure(k, 1.2).filter((c) => c.t > 0.02).map((c) => cents(c.f, 1000)));
  assert.ok(Math.abs(hi - 50) < 3, `${rate} Hz: +50 cents (${hi.toFixed(1)})`);
}

// Amp 0: the input passes through, two samples late
{
  const k = fresh({ amp: 0 });
  const L = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.1));
  const out = [[new Float32Array(128), new Float32Array(128)]];
  k.process([[L, L]], out);
  for (let i = 2; i < 128; i++) assert.ok(Math.abs(out[0][0][i] - L[i - 2]) < 1e-6);
}

// Freq Unit synced to BPM, like the LFO: 1 × 1/4 at 120 BPM = 2 Hz; slow rates stay within the line
{
  const k = fresh({ unit: 1, freq: 1 });
  assert.equal(k.rate, 2);
  k.message({ type: 'bpm', value: 90 });
  assert.equal(k.rate, 1.5);
  const slow = fresh({ freq: 0.01, amp: 200 });
  assert.ok(slow.target <= MAX_DELAY * SR / MAX_OFFSET[0] + 1e-6, 'depth limited to the delay line');
  measure(slow, 0.1); // stays in bounds
}

// Set Phase: applied before the first block and on panic, never jumps while running
{
  const k = fresh({ phase: 0.25 });
  assert.equal(k.phase, 0.25);
  measure(k, 0.1);
  const running = k.phase;
  k.param('phase', 0.75);
  assert.equal(k.phase, running, 'turning Set Phase does not jump');
  k.panic();
  assert.equal(k.phase, 0.75, 'panic restarts at Set Phase');
  const out = [[new Float32Array(128), new Float32Array(128)]];
  assert.equal(k.process([[]], out), false, 'panic empties the delay line');
}

// Silent once the delayed input has played out; the clock keeps running
{
  const k = fresh({ freq: 0.5, amp: 100 });
  measure(k, 0.05);
  let blocks = 0;
  const p0 = k.phase;
  for (let b = 0; b < 2000 && k.process([[]], [[new Float32Array(128), new Float32Array(128)]]); b++) blocks++;
  assert.ok(blocks > 0, 'the tail plays');
  assert.equal(k.process([[]], [[new Float32Array(128), new Float32Array(128)]]), false, 'then silent');
  assert.notEqual(k.phase, p0, 'phase moved on while silent');
}

// Explicit zero input is a continuously processed reference for the silent-input fast path.
for (const K of [Vibrato, NativeVibrato]) for (const wave of [0, 1]) {
  const k = new K({});
  for (const [id, value] of Object.entries({ wave, freq: 5, amp: 5, phase: 0.25 })) k.param(id, value);
  const reference = fresh({ wave, freq: 5, amp: 5, phase: 0.25 });
  const input = [[Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.1)), new Float32Array(128).fill(0.3)]];
  const zero = [[new Float32Array(128), new Float32Array(128)]];
  const a = [[new Float32Array(128), new Float32Array(128)]];
  const b = [[new Float32Array(128), new Float32Array(128)]];
  let resumedHistory = false;
  for (let block = 0; block < 500; block++) {
    // Increase the delay while old samples are still in the ring, then switch waveform.
    if (block === 10) for (const fx of [k, reference]) { fx.param('amp', 200); fx.param('freq', 0.03); }
    if (block === 80) for (const fx of [k, reference]) fx.param('wave', 1 - wave);
    if (block === 160) for (const fx of [k, reference]) { fx.param('amp', 0); fx.param('freq', 20); }
    const active = block < 4 || block >= 250 && block < 254;
    if (k.process(active ? input : [[]], a) === false) for (const ch of a[0]) ch.fill(0);
    if (reference.process(active ? input : zero, b) === false) for (const ch of b[0]) ch.fill(0);
    for (let ch = 0; ch < 2; ch++) assert.deepEqual(a[0][ch], b[0][ch], `silent fast path, wave ${wave}, block ${block}`);
    if (K === Vibrato) {
      assert.equal(k.phase, reference.phase, 'phase advances identically while skipping interpolation');
      assert.equal(k.depth, reference.depth, 'depth glide stays identical');
    }
    if (block >= 10 && block < 160 && a[0][0].some(v => v !== 0)) resumedHistory = true;
  }
  assert.ok(resumedHistory, 'increasing delay can still read retained history');
  k.destroy?.();
}
{
  const k = fresh({ amp: 5, freq: 5 });
  measure(k, 0.01);
  const out = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < 10; i++) k.process([[]], out);
  const cos = Math.cos;
  let calls = 0;
  Math.cos = (v) => { calls++; return cos(v); };
  try { k.process([[]], out); }
  finally { Math.cos = cos; }
  assert.equal(calls, 0, 'short silent tail skips per-sample cosine/interpolation before the two-second buffer expires');
}

// Switching Waveform, Amp or Frequency while playing glides: no click
for (const [id, value] of [['wave', 1], ['amp', 200], ['freq', 40]]) {
  const k = fresh({ freq: 4, amp: 100 });
  const f0 = 200;
  let prev = 0, jump = 0;
  for (let s = 0; s < SR; s += 128) {
    if (s === 128 * 150) k.param(id, value);
    const L = Float32Array.from({ length: 128 }, (_, i) => Math.sin(2 * Math.PI * f0 * (s + i) / SR));
    const out = [[new Float32Array(128), new Float32Array(128)]];
    k.process([[L, L]], out);
    for (let i = 0; i < 128; i++) {
      if (s + i > 200) jump = Math.max(jump, Math.abs(out[0][0][i] - prev));
      prev = out[0][0][i];
    }
  }
  // a 200 Hz sine at +2 semitones moves at most 2π·224/48000 ≈ 0.03 per sample
  assert.ok(jump < 0.04, `${id}: largest step ${jump.toFixed(4)}`);
}

// In a patch: audio passes, duplicate and save/load keep the controllers
{
  const { dsp, render } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const src = await root.addModule('OSC');
  const fx = await root.addModule('VIBRATO', { values: { wave: 1, unit: 2, freq: 2, phase: 0.5, amp: 60 } });
  root.connect(src.id, fx.id); root.connect(fx.id, 0);
  src.inst.noteOn(1, 60, 1);
  const { L } = render(10);
  assert.ok(L.some((v) => Math.abs(v) > 0.01), 'audio passes through VIBRATO');
  const clone = await root.duplicate(fx.id);
  assert.deepEqual(clone.values, fx.values);
  const json = JSON.parse(JSON.stringify(root.toJSON()));
  const loaded = await PatchRuntime.create(engine, dsp.destination);
  await loaded.load(json);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.toJSON())), json, 'save/load retains VIBRATO');
  root.destroy(); loaded.destroy();
}
console.log('vibrato tests passed');
