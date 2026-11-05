import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';
import Operator from '../src/modules/operator.dsp.js';
import def from '../src/modules/operator.js';
import { getModule } from '../src/modules/index.js';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';
import { TWELVE_TET } from '../src/scala.js';

globalThis.sampleRate = 48000;
const SR = sampleRate, N = 128;
const stereo = () => [[new Float32Array(N), new Float32Array(N)]];
const pitchOf = (hz) => 69 + 12 * Math.log2(hz / 440);
function make(params = {}) {
  const k = new Operator();
  for (const [id, value] of Object.entries({ gain: 1, attack: 0.001, atkCurve: 0, ...params })) k.param(id, value);
  k.process([[]], stereo()); // settle controller settings before triggering
  return k;
}
function render(k, blocks, input = () => [[]]) {
  const samples = [];
  for (let b = 0; b < blocks; b++) {
    const out = stereo();
    k.process(input(b), out);
    assert.deepEqual(out[0][0], out[0][1], 'mono signal on both output channels');
    assert.ok(out[0][0].every(Number.isFinite));
    samples.push(...out[0][0]);
  }
  return samples;
}
const peak = (a) => Math.max(...a.map(Math.abs));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

// Sleeping graphs match continuously processed operators across tails, idle edits and wake-up.
for (const backend of ['js', 'mixed', 'native']) {
  const native = () => wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), SR);
  const aOpts = backend === 'js' ? {} : { ...native(), native: backend === 'native' };
  const bOpts = backend === 'js' ? {} : { ...native(), native: false };
  const Base = bOpts.kernels?.operator ?? Operator;
  bOpts.kernels = { ...bOpts.kernels, operator: class extends Base { get dormant() { return false; } } };
  const a = dspTestHost(aOpts), b = dspTestHost(bOpts);
  const nodes = [a, b].map(h => {
    const op = h.dsp.create('operator');
    op.connect(h.dsp.destination);
    op.param('release', 0.02);
    return op;
  });
  const sources = [a, b].map((h, i) => {
    const src = h.dsp.create('osc');
    src.connect(nodes[i]);
    return src;
  });
  let calls = 0;
  const k = a.kernel(nodes[0]), process = k.process;
  k.process = function (...args) { calls++; return process.apply(this, args); };
  for (let block = 0; block < 400; block++) {
    for (const op of nodes) {
      if (block === 40 || block === 200) op.send({ type: 'noteOn', id: block, pitch: 60.3, velocity: 0.7, phase: 0.2 });
      if (block === 60) op.send({ type: 'noteOff', id: 40 });
      if (block === 150) { op.param('feedback', 35); op.param('modulation', 168); op.param('gain', 0.3); }
      if (block === 220) op.send({ type: 'noteMod', notes: [[200, 80.1, 0.3]] });
      if (block === 250) op.send({ type: 'allOff' });
      if (block === 330) op.send({ type: 'noteOn', id: 330, pitch: 72, velocity: 0.8, phase: 0 });
    }
    if (block === 280) for (const src of sources) src.send({ type: 'noteOn', id: 1, pitch: 57, velocity: 0.8, phase: 0 });
    if (block === 350) for (const src of sources) src.send({ type: 'allOff' });
    const x = a.render(), y = b.render();
    assert.deepEqual(x.L, y.L, `${backend}: dormant/reference left block ${block}`);
    assert.deepEqual(x.R, y.R, `${backend}: dormant/reference right block ${block}`);
    if (block === 30 && backend !== 'native') assert.ok(calls < 3, 'idle graph skips processor calls');
  }
  if (backend === 'native') assert.ok(a.graph.prog, 'exercise native graph sleeping');
  nodes.forEach(op => op.destroy());
  sources.forEach(src => src.destroy());
}

assert.equal(getModule('OPERATOR'), def);
assert.ok(def.hasInput && def.hasOutput && def.acceptsMidi && !def.midiOut);
assert.deepEqual(def.params.map((p) => p.id), [
  'modulation', 'feedback', 'attack', 'decay', 'sustain', 'release',
  'atkCurve', 'decCurve', 'relCurve', 'velocity', 'gain',
]);
assert.deepEqual(def.linked({ sustain: 0 }, 'decay', 0.2, def.params), { release: 0.2 });
const one = [new Float32Array(N).fill(1)];
assert.equal(peak(render(make(), 4, () => [one])), 0, 'audio alone never triggers or passes through');

// Compare the FIR against circular indexing at every ring position, including release and panic.
{
  const taps = 65, weights = new Float64Array(taps);
  let total = 0;
  for (let t = 0; t < taps; t++) {
    const x = t - (taps - 1) / 2, fc = 0.45 / 4;
    weights[t] = (x ? Math.sin(2 * Math.PI * fc * x) / (Math.PI * x) : 2 * fc)
      * (0.54 - 0.46 * Math.cos(2 * Math.PI * t / (taps - 1)));
    total += weights[t];
  }
  for (let t = 0; t < taps; t++) weights[t] /= total;
  const k = make({ feedback: 31, modulation: 168 });
  const input = [[new Float32Array(1), new Float32Array(1)]];
  const output = [[new Float32Array(1), new Float32Array(1)]];
  const positions = new Set();
  k.noteOn(1, 60.375, 0.8, 0.23);
  for (let i = 0; i < 600; i++) {
    if (i === 180) k.noteMod(1, 81.2, 0.3);
    if (i === 250) k.noteOff(1);
    if (i === 400) { k.panic(); k.noteOn(2, 48, 0.7, 0.1); }
    input[0][0][0] = Math.sin(i * 0.31);
    input[0][1][0] = Math.cos(i * 0.17);
    k.process(input, output);
    positions.add(k.pos);
    let expected = 0;
    for (let t = 0; t < taps; t++) expected += weights[t] * k.history[(k.pos - 1 - t + taps) % taps];
    assert.equal(output[0][0][0], Math.fround(expected), 'FIR retains exact circular summation');
  }
  assert.equal(positions.size, taps, 'every wrap position is exercised');
}

// Fractional pitch and MIDI phase, with the FIR's eight-sample group delay.
for (const pitch of [21, 60.375, 69, 108.1]) {
  for (const phase of [0, 0.23, -0.3, 1.4]) {
    const k = make();
    k.noteOn(1, pitch, 1, phase);
    const samples = render(k, 16);
    const hz = 440 * 2 ** ((pitch - 69) / 12);
    for (let i = 256; i < samples.length; i++) {
      near(samples[i], Math.sin(2 * Math.PI * ((i - 7.25) * hz / SR + phase)), 0.003, 'tuned sine and initial phase');
    }
  }
}

// 25 % at input amplitude 1 = a quarter cycle, not a frequency offset or amplitude change.
for (const [left, right, amount, phase] of [
  [1, 1, 25, 0.25], [0.5, 0.5, 50, 0.25], [1, -1, 100, 0], [0, 1, 50, 0.25], [1, 1, 0, 0],
]) {
  const k = make({ modulation: amount });
  k.noteOn(1, 69, 1, 0);
  const input = [[new Float32Array(N).fill(left), new Float32Array(N).fill(right)]];
  const samples = render(k, 16, () => input);
  for (let i = 256; i < samples.length; i++) near(samples[i],
    Math.sin(2 * Math.PI * ((i - 7.25) * 440 / SR + phase)), 0.003, 'input phase depth / stereo average');
}

for (const sensitivity of [0, 50, 100]) {
  const k = make({ velocity: sensitivity });
  k.noteOn(1, 69, 0.2);
  const samples = render(k, 16).slice(256);
  near(peak(samples), 1 - sensitivity / 100 * 0.8, 0.003, 'velocity sensitivity');
}

// Live pitch changes glide to the exact fractional MIDI target.
{
  const k = make();
  k.noteOn(1, 60, 1);
  render(k, 10);
  k.noteMod(1, 72.37, 0.4);
  render(k, 100);
  near(k.voices[0].pitch, 72.37, 1e-5, 'live tuning');
  near(k.voices[0].vel, 0.4, 1e-6, 'live velocity');
  k.noteOn(2, 67, 1);
  k.noteOff(1);
  assert.equal(k.voices[0].id, 2, 'newest note owns the monophonic voice');
  assert.notEqual(k.voices[0].stage, 4, 'old note-off does not release the new voice');
}

// Exact stage durations at the internal rate, curved release and filter-tail cleanup.
for (const curve of [-100, 0, 100]) {
  const k = make({ attack: 0.01, decay: 0.02, sustain: 0.4, release: 0.01, atkCurve: curve, decCurve: curve, relCurve: curve });
  k.noteOn(1, 69, 1);
  render(k, 4);
  assert.equal(k.voices[0].stage, 2, 'attack completed after 10 ms');
  render(k, 8);
  near(k.voices[0].level, 0.4, 1e-9, 'decay settles at sustain');
  k.noteOff(1);
  render(k, 5);
  assert.equal(k.voices[0].stage, 0, 'release completes');
  assert.equal(peak(render(k, 2)), 0, 'filter tail drains to exact silence');
}

// Feedback has bounded state and resets reproducibly with panic and a new MIDI phase.
for (const feedback of [0, 20, 100]) {
  const k = make({ feedback });
  k.noteOn(1, 69, 1, 0.2);
  const first = render(k, 30);
  assert.ok(peak(first) < 1.2, 'feedback remains bounded');
  k.panic();
  assert.equal(peak(render(k, 2)), 0, 'panic clears oscillator and FIR memory');
  k.noteOn(2, 69, 1, 0.2);
  assert.deepEqual(render(k, 30), first, 'feedback state reset');
  k.message({ type: 'allOff' });
  assert.equal(peak(render(k, 1)), 0, 'allOff clears filter tail');
}

// A 9 kHz modulator on a 9 kHz carrier creates a 27 kHz sideband, aliased to 21 kHz
// without oversampling. Measure that component after warmup against a host-rate PM oscillator.
{
  const k = make({ modulation: 12 });
  k.noteOn(1, pitchOf(9000), 1);
  const raw = [];
  const samples = render(k, 400, (b) => {
    const src = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = b * N + i;
      src[i] = Math.sin(2 * Math.PI * 9000 * t / SR);
      raw.push(Math.sin(2 * Math.PI * 9000 * t / SR + 2 * Math.PI * src[i] * 0.12));
    }
    return [[src]];
  });
  const amplitude = (a) => {
    let re = 0, im = 0;
    for (let i = 1024; i < a.length; i++) {
      re += a[i] * Math.cos(2 * Math.PI * 21000 * i / SR);
      im += a[i] * Math.sin(2 * Math.PI * 21000 * i / SR);
    }
    return 2 * Math.hypot(re, im) / (a.length - 1024);
  };
  assert.ok(amplitude(samples) < amplitude(raw) * 0.25, `oversampling suppresses aliased sideband: ${amplitude(samples)} vs ${amplitude(raw)}`);
}

// Real patch wiring: audio and MIDI stay separate; MULTIMIDI supplies tuning and overtone.
{
  const { dsp, kernel, render: tick } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const patch = await PatchRuntime.create(engine, dsp.destination);
  const mm = await patch.addModule('MULTIMIDI', { values: { finetune: 0.37, overtone: 2 } });
  const a = await patch.addModule('OPERATOR'), b = await patch.addModule('OPERATOR');
  assert.ok(patch.connect(mm.id, a.id) && patch.connect(mm.id, b.id));
  assert.ok(patch.connect(a.id, b.id) && patch.connect(b.id, 0));
  assert.equal(patch.connect(b.id, a.id), false, 'audio feedback cycles still rejected');
  assert.ok(patch.signals(a, b).audio && !patch.signals(a, b).midi);
  mm.inst.noteOn(1, 60.25, 1, 0.3);
  assert.ok(kernel(a.inst.node).voices[0].pitch > 60.25, 'MULTIMIDI overtone and cents reach OPERATOR');
  assert.equal(kernel(a.inst.node).voices[0].pitch, kernel(b.inst.node).voices[0].pitch, 'shared tuned note');
  assert.equal(kernel(a.inst.node).voices[0].phase, 0.3);
  assert.ok(peak([...tick(10).L]) > 0.01, 'connected network produces sound');
  mm.inst.allOff();
  const tuning = await patch.addModule('TUNING', { state: { text: 'Just major\n7\n9/8\n5/4\n4/3\n3/2\n5/3\n15/8\n2/1\n' } });
  assert.ok(patch.connect(tuning.id, mm.id));
  tuning.inst.noteOn(2, 62.1, 0.7);
  const expected = 60 + 12 * Math.log2(5 / 4) + 0.1 + 0.37 + 12 * Math.log2(3);
  near(kernel(a.inst.node).voices[0].pitchT, expected, 1e-8, 'Scala tuning, fractional pitch, cents and overtone combine');
  tuning.inst.setState({ text: TWELVE_TET });
  await Promise.resolve(); // coalesced noteMod delivery
  await Promise.resolve();
  near(kernel(a.inst.node).voices[0].pitchT, 62.1 + 0.37 + 12 * Math.log2(3), 1e-8, 'live TUNING changes reach OPERATOR');
  patch.setParam(b.id, 'modulation', 250);
  const json = patch.toJSON();
  const copy = await PatchRuntime.create(engine, dsp.destination);
  await copy.load(json);
  assert.deepEqual(copy.toJSON(), json, 'operator settings and cables round-trip');
  const duplicate = await patch.duplicate(b.id);
  assert.equal(duplicate.values.modulation, 250, 'operator duplication preserves controls');

  const pm = await patch.addModule('PATCH');
  const inner = pm.inst.patch;
  const op = await inner.addModule('OPERATOR');
  assert.ok(inner.connect(op.id, 0));
  patch.setParam(pm.id, 'instances', 3);
  await pm.inst.sync();
  assert.equal(pm.inst.clones.length, 2, 'operator supports polyphonic Patch copies');
  const all = [inner, ...pm.inst.clones];
  assert.ok(all.every((rt) => pm.inst.input.out.has(rt.modules.get(op.id).inst.input)), 'external modulation reaches every copy');
  for (let id = 100; id < 103; id++) pm.inst.noteOn(id, 60 + id - 100, 1);
  assert.deepEqual(all.map((rt) => kernel(rt.modules.get(op.id).inst.node).voices[0].pitch), [60, 61, 62], 'one note per complete network');
  await inner.addModule('AMP');
  await pm.inst.sync();
  assert.ok(pm.inst.clones.every((rt) => pm.inst.input.out.has(rt.modules.get(op.id).inst.input)), 'rebuilt copies retain input');
  patch.destroy(); copy.destroy();
}

console.log('operator tests passed');
