// Run: node test/feedback.test.mjs — FEEDBACK kernel (JS and C++), the loop rule of the patch,
// sample-by-sample loop rendering (JS graph, wasm kernels, native ms_run) and a Karplus-Strong string.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dspTestHost } from './dsphost.mjs';
import FeedbackKernel, { LIMIT } from '../src/modules/feedback.dsp.js';
import DelayKernel from '../src/modules/delay.dsp.js';
import { NOTE_UNIT, notePeriodSamples } from '../src/modules/delaytime.js';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';
import { Kernel } from '../src/dsp/kernel.js';
import { PatchRuntime } from '../src/patch.js';

const SR = sampleRate;
const native = wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), SR);
const close = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

// ---- kernel: silent at 0, per block == per sample, smoothing, limit ----
for (const [name, K] of [['JS', FeedbackKernel], ['C++', native.kernels.feedback]]) {
  const input = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < 128; i++) { input[0][0][i] = Math.sin(i / 7); input[0][1][i] = Math.cos(i / 5) * 6; }
  const out = () => [[new Float32Array(128), new Float32Array(128)]];
  const k0 = new K();
  assert.equal(k0.process(input, out()), false, `${name}: Feedback 0 is silent`);
  assert.equal(new K().process([[]], out()), false, `${name}: no input is silent`);

  const a = new K();
  const b = new K();
  for (const k of [a, b]) k.param('feedback', 0.5);
  const oa = out();
  assert.equal(a.process(input, oa), true);
  close(oa[0][0][10], Math.fround(Math.sin(10 / 7)) * 0.5, 1e-6, `${name}: the first sound starts at the target gain`);
  close(oa[0][1][3], LIMIT * Math.sign(Math.cos(3 / 5)), 0, `${name}: limited to ±${LIMIT}`);
  b.process(input, out()); // b: the first block at 0.5 too, the next one sample by sample
  for (const k of [a, b]) k.param('feedback', 1);
  const blocks = out();
  a.process(input, blocks);
  const one = [[new Float32Array(1), new Float32Array(1)]];
  for (let i = 0; i < 128; i++) {
    b.process([[input[0][0].subarray(i, i + 1), input[0][1].subarray(i, i + 1)]], one);
    assert.equal(one[0][0][0], blocks[0][0][i], `${name}: sample ${i} rendered alone equals the block`);
    assert.equal(one[0][1][0], blocks[0][1][i]);
  }
  assert.ok(Math.abs(blocks[0][0][0]) < Math.abs(input[0][0][0]) || input[0][0][0] === 0);
  close(blocks[0][0][1] / input[0][0][1], 0.5, 0.01, `${name}: a change glides`);
  const nan = new K();
  nan.param('feedback', 1);
  const on = out();
  nan.process([[new Float32Array(128).fill(NaN), new Float32Array(128).fill(Infinity)]], on);
  assert.equal(on[0][0][0], 0, `${name}: NaN becomes 0`);
  assert.equal(on[0][1][0], LIMIT);
}

// ---- DELAY Note unit: one period of the note minus one sample ----
for (const [name, K] of [['JS', DelayKernel], ['C++', native.kernels.delay]]) {
  const k = new K();
  k.param('unit', NOTE_UNIT);
  k.message({ type: 'noteOn', id: 1, pitch: 69, velocity: 1, phase: 0 });
  const input = [[new Float32Array(128), new Float32Array(128)]];
  input[0][0][0] = input[0][1][0] = 1;
  const o = [[new Float32Array(128), new Float32Array(128)]];
  k.process(input, o);
  const d = notePeriodSamples(69, SR);
  close(d, SR / 440 - 1, 1e-9, 'period minus one sample');
  let at = 0;
  for (let i = 1; i < 128; i++) if (o[0][0][i] > o[0][0][at]) at = i;
  assert.ok(at === Math.floor(d) || at === Math.ceil(d), `${name}: A4 delays ${d} samples, peak at ${at}`);
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += o[0][0][i] * i;
  close(sum, d, 0.02, `${name}: the impulse's centre sits at the fractional delay`);
}

// ---- DELAY Note unit: the fraction of a sample is read by an all-pass, so it never dulls the
// sound (linear interpolation did, except at whole numbers of samples: there a FEEDBACK loop
// rang far brighter than at neighbouring notes) ----
{
  const pitchFor = (samples) => 69 - 12 * Math.log2((440 * (samples + 1)) / SR);
  let seed = 1;
  const noise = Array.from({ length: 4096 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
  const run = (K, samples) => {
    const k = new K();
    k.param('unit', NOTE_UNIT);
    k.message({ type: 'noteOn', id: 1, pitch: pitchFor(samples), velocity: 1, phase: 0 });
    const out = [];
    const o = [[new Float32Array(128), new Float32Array(128)]];
    for (let at = 0; at < noise.length; at += 128) {
      const x = Float32Array.from(noise.slice(at, at + 128));
      k.process([[x, x]], o);
      out.push(...o[0][0]);
    }
    return out;
  };
  const highs = (x) => {
    let hi = 0;
    let all = 0;
    for (let i = 1024; i < x.length; i++) { hi += (x[i] - x[i - 1]) ** 2; all += x[i] ** 2; }
    return hi / all;
  };
  const ref = highs(noise);
  for (const samples of [200, 200.25, 200.5, 200.75, 3.5]) {
    const js = run(DelayKernel, samples);
    const cpp = run(native.kernels.delay, samples);
    for (let i = 0; i < js.length; i++) assert.equal(cpp[i], js[i], `Note unit ${samples}: C++ == JS (sample ${i})`);
    close(highs(js) / ref, 1, 0.08, `Note unit ${samples} samples keeps the highs`);
  }
}

// ---- patch rule: a sound loop must pass through at least two FEEDBACK modules ----
{
  const t = dspTestHost();
  const patch = await PatchRuntime.create({ ctx: { currentTime: 0 }, dsp: t.dsp }, t.dsp.destination);
  const f = await patch.addModule('FILTER');
  const d = await patch.addModule('DELAY');
  const fb1 = await patch.addModule('FEEDBACK');
  const fb2 = await patch.addModule('FEEDBACK');
  const mm = await patch.addModule('MULTIMIDI');
  assert.equal(fb1.values.feedback, 0, 'FEEDBACK starts at 0');
  assert.ok(patch.connect(f.id, d.id));
  assert.equal(patch.connect(d.id, f.id), false, 'a loop without FEEDBACK is refused');
  assert.ok(patch.connect(d.id, fb1.id));
  assert.equal(patch.connect(fb1.id, f.id), false, 'one FEEDBACK is not enough');
  assert.ok(patch.connect(fb1.id, fb2.id));
  assert.ok(patch.connect(fb2.id, f.id), 'two FEEDBACK modules close the loop');
  assert.equal(patch.connect(fb2.id, d.id), true, 'a second loop over both FEEDBACK modules');
  assert.equal(patch.connect(d.id, f.id), false, 'a shortcut loop without FEEDBACK is still refused');
  assert.ok(patch.connect(f.id, fb1.id), 'f -> fb1 -> fb2 -> f passes through both');
  assert.ok(patch.connect(mm.id, d.id), 'MIDI into a loop');
  assert.equal(patch.connect(d.id, mm.id), false, 'MIDI loops stay impossible');
  const data = patch.toJSON();
  await patch.load(data);
  assert.deepEqual(patch.toJSON(), data, 'loops survive saving and loading');
}

// ---- graph: a loop adds one sample of delay, across block boundaries too (JS graph) ----
{
  class Impulse extends Kernel {
    constructor() { super(); this.done = false; }
    process(_i, o) {
      if (this.done) return false;
      o[0][0].fill(0); o[0][1].fill(0);
      o[0][0][0] = o[0][1][0] = 1;
      this.done = true;
      return true;
    }
  }
  const t = dspTestHost({ kernels: { impulse: Impulse } });
  const g = t.graph;
  g.handle([['add', 1, 'impulse'], ['add', 2, 'feedback'], ['add', 3, 'feedback'],
    ['con', 1, 2], ['con', 2, 3], ['con', 3, 2], ['con', 3, 0],
    ['msg', 2, { type: 'param', id: 'feedback', value: 1 }], ['msg', 3, { type: 'param', id: 'feedback', value: 1 }]]);
  const { L } = t.render();
  for (let i = 0; i < 128; i++) assert.equal(L[i], 1, `sample ${i}: the impulse circles every sample`);
  assert.equal(g.plan.length, 3, 'impulse, the loop group, the master');
  assert.equal(t.render().L[0], 1, 'the loop carries on into the next block');
  g.handle([['panic']]);
  assert.equal(t.render().L.every((v) => v === 0), true, 'panic clears the loop');

  const u = dspTestHost({ kernels: { impulse: Impulse } });
  u.graph.handle([['add', 1, 'impulse'], ['add', 2, 'feedback'], ['add', 3, 'feedback'],
    ['con', 1, 2], ['con', 2, 3], ['con', 3, 2], ['con', 3, 0],
    ['msg', 2, { type: 'param', id: 'feedback', value: 1 }], ['msg', 3, { type: 'param', id: 'feedback', value: 0.5 }]]);
  const y = u.render().L;
  for (let i = 0; i < 40; i++) assert.equal(y[i], 0.5 ** (i + 1), `sample ${i}: halved every sample`);
  u.render(2);
  assert.ok(u.graph.nodes.get(3).silent && u.graph.master.silent, 'a dying loop ends in silence, not denormals');
}

// ---- Karplus-Strong string: JS graph, wasm kernels, native ms_run ----
async function pluck(opts, pitch = 57, gain = 0.995, filter = true, { cutoff = 8000, slope = 0, tune = 1, blocks = 200 } = {}) {
  const t = dspTestHost(opts);
  const patch = await PatchRuntime.create({ ctx: { currentTime: 0 }, dsp: t.dsp }, t.dsp.destination);
  const osc = await patch.addModule('OSC', { values: { wave: 2, gain: 0.5, polyphony: 1 } });
  const d = await patch.addModule('DELAY', { values: { unit: NOTE_UNIT, tune } });
  const f = await patch.addModule('FILTER', { values: { type: 0, slope, cutoff, resonance: 0 } });
  const fb1 = await patch.addModule('FEEDBACK');
  const fb2 = await patch.addModule('FEEDBACK');
  const cables = filter ? [[d, f], [f, fb1]] : [[d, fb1]];
  for (const [a, b] of [[osc, d], ...cables, [fb1, fb2], [fb2, d], [d, { id: 0 }]]) assert.ok(patch.connect(a.id, b.id));
  patch.setParam(fb1.id, 'feedback', gain);
  patch.setParam(fb2.id, 'feedback', 1);
  osc.inst.noteOn(1, pitch, 1);
  d.inst.noteOn(1, pitch, 1);
  t.render(1);
  osc.inst.noteOff(1);
  t.render(4);
  const out = [];
  for (let b = 0; b < blocks; b++) out.push(...t.render().L);
  return { out, graph: t.graph, delay: t.graph.nodes.get(d.inst.node.h) };
}
// the strongest autocorrelation lag near the note's period, refined between samples (parabola)
const period = (x, f) => {
  const want = SR / 440 / 2 ** ((f - 69) / 12);
  const ac = (lag) => {
    let c = 0;
    for (let i = 0; i + lag < 8192; i++) c += x[i] * x[i + lag];
    return c;
  };
  let best = -Infinity;
  let at = 0;
  for (let lag = Math.floor(want * 0.8); lag < want * 1.2; lag++) {
    const c = ac(lag);
    if (c > best) { best = c; at = lag; }
  }
  const [a, b, c] = [ac(at - 1), best, ac(at + 1)];
  return [at + (0.5 * (a - c)) / (a - 2 * b + c), want];
};
const strings = {};
for (const [name, opts] of [['JS', undefined], ['wasm', { ...native, native: false }], ['native', native]]) {
  const { out, graph } = await pluck(opts);
  strings[name] = out;
  if (name === 'native') assert.ok(graph.prog, 'the loop renders natively');
  else assert.equal(graph.prog, 0);
  const [lag, want] = period(out.slice(4096), 57);
  // Loop Tuning takes the low-pass's delay off the DELAY (autocorrelation weighs all partials: rough)
  close(lag, want, 0.5, `${name}: rings at A3 (${lag} vs ${want.toFixed(2)} samples)`);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const early = rms(out.slice(0, 4800));
  const late = rms(out.slice(out.length - 4800));
  assert.ok(early > 0.01 && late > early * 0.01 && late < early, `${name}: the string decays slowly (${early}, ${late})`);
  const { out: dead } = await pluck(opts, 57, 0);
  assert.ok(rms(dead.slice(1024)) === 0, `${name}: no feedback, no ringing`);
}
for (let i = 0; i < strings.native.length; i++) assert.equal(strings.native[i], strings.wasm[i], `native ms_run == JS graph with C++ kernels (sample ${i})`);

// without a filter in the loop the string is in tune: DELAY Note + the loop's one sample
for (const [pitch, opts] of [[57, undefined], [69, native], [81, native]]) {
  const { out } = await pluck(opts, pitch, 0.995, false);
  const [lag, want] = period(out.slice(4096), pitch);
  close(lag, want, 0.3, `note ${pitch} in tune`);
}
// ---- Loop Tuning: the fundamental stays in tune at any cutoff (the FILTER's phase delay at the
// note is taken off the DELAY); Off leaves it flat ----
// the fundamental's frequency in cents from `pitch`: the phase advance of a windowed DFT bin at the
// note over growing gaps (each gap unwraps the next)
const cents = (x, pitch) => {
  const f = 440 * 2 ** ((pitch - 69) / 12);
  const N = 8192;
  const s1 = 4096;
  const phase = (s) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const w = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)) * x[s + i];
      const a = (2 * Math.PI * f * (s + i)) / SR;
      re += w * Math.cos(a);
      im -= w * Math.sin(a);
    }
    return Math.atan2(im, re);
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const p1 = phase(s1);
  let fm = f;
  for (const gap of [256, 2048, 16384]) {
    const guess = (2 * Math.PI * (fm - f) * gap) / SR;
    fm = f + ((guess + wrap(phase(s1 + gap) - p1 - guess)) / (2 * Math.PI)) * (SR / gap);
  }
  return 1200 * Math.log2(fm / f);
};
for (const [name, opts] of [['JS', undefined], ['native', native]]) {
  for (const [pitch, cutoff, slope] of [[45, 1500, 0], [57, 3192, 0], [69, 3192, 1], [69, 1500, 0], [81, 3192, 0]]) {
    const on = await pluck(opts, pitch, 0.995, true, { cutoff, slope, blocks: 300 });
    close(cents(on.out, pitch), 0, 3.5, `${name}: note ${pitch}, cutoff ${cutoff}, slope ${slope} in tune`);
    assert.equal(on.delay.tune.back, 1, 'the loop adds one sample');
    assert.equal(on.delay.tune.filters.length, 1, 'the FILTER on the loop is found');
  }
  const off = await pluck(opts, 69, 0.995, true, { cutoff: 1500, tune: 0, blocks: 300 });
  assert.ok(cents(off.out, 69) < -100, `${name}: Loop Tuning Off rings flat (${cents(off.out, 69)} ct)`);
}
// a DELAY outside any loop gets its one sample back
{
  const t = dspTestHost();
  const patch = await PatchRuntime.create({ ctx: { currentTime: 0 }, dsp: t.dsp }, t.dsp.destination);
  const d = await patch.addModule('DELAY', { values: { unit: NOTE_UNIT } });
  const f = await patch.addModule('FILTER', { values: { cutoff: 500 } });
  const fb1 = await patch.addModule('FEEDBACK');
  const fb2 = await patch.addModule('FEEDBACK');
  for (const [a, b] of [[d, f], [f, fb1], [fb1, fb2], [fb2, d], [d, { id: 0 }]]) assert.ok(patch.connect(a.id, b.id));
  d.inst.noteOn(1, 69, 1);
  t.render(1);
  const k = t.kernel(d.inst.node);
  assert.ok(k.p.loop > 2, `in the loop: one sample plus the low-pass (${k.p.loop})`);
  patch.disconnect(patch.cables.find((c) => c.from === fb2.id && c.to === d.id));
  t.render(1);
  assert.equal(k.p.loop, 1, 'out of the loop: one sample');
}
console.log('feedback tests passed');
