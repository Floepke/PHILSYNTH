import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AudioAnalysis, ANALYSIS_SIZE, ANALYSIS_SIZES } from '../src/dsp/analysis.js';
import { Spectrum, dbFS } from '../src/spectrum.js';
import { analysisHandle } from '../src/spectrumanalyserpanel.js';
import { dspTestHost } from './dsphost.mjs';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';

const near = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
globalThis.sampleRate = 48000;

for (const size of ANALYSIS_SIZES) {
  const analysis = new AudioAnalysis(3, size);
  const samples = Float32Array.from({ length: size }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 8 * i / size));
  for (let i = 0; i < size; i += 128) {
    analysis.push(samples.subarray(i, i + 128), samples.subarray(i, i + 128));
    if (i + 128 < size) assert.equal(analysis.report(), null, 'wait for the configured full window');
  }
  const report = analysis.report();
  assert.equal(report.samples.length, size * 2);
  assert.deepEqual(report.samples.subarray(0, size), samples);
  const levels = new Spectrum(size).measure(report.samples);
  assert.equal(levels.length, size / 2);
  assert.equal(levels.indexOf(Math.max(...levels)), 8);
  near(levels[8], dbFS(0.5));
}
assert.throws(() => new AudioAnalysis(3, 4048), /Invalid spectrum analyser size/);
assert.throws(() => new Spectrum(4048), /Invalid spectrum analyser size/);
assert.throws(() => new Spectrum().measure(new Float32Array(512)), /does not match/);

// The full-rate stereo window retains samples a decimated cable scope would miss.
{
  const analysis = new AudioAnalysis(3);
  const left = new Float32Array(128), right = new Float32Array(128);
  left[1] = 1.25;
  right[2] = -2;
  analysis.push(left, right);
  analysis.push(null, null);
  assert.equal(analysis.report(), null, 'input changes wait for a complete FFT window');
  for (let i = 2; i < ANALYSIS_SIZE / 128; i++) analysis.push(null, null);
  const report = analysis.report();
  assert.equal(report.h, 3);
  assert.deepEqual(Object.keys(report).sort(), ['h', 'sampleRate', 'samples'], 'no loudness-meter data is collected');
  assert.equal(report.samples.length, 2 * ANALYSIS_SIZE);
  assert.equal(report.samples[1], 1.25);
  assert.equal(report.samples[ANALYSIS_SIZE + 2], -2);
  assert.equal(analysis.report(), null, 'no duplicate data without another rendered block');
  for (let i = 0; i < ANALYSIS_SIZE / 128; i++) analysis.push(null, null);
  assert.ok(analysis.report().samples.every(value => value === 0), 'silence clears the spectrum window');
}

// The circular FFT window always contains the latest full-rate audio in chronological order.
{
  const analysis = new AudioAnalysis(1);
  for (let block = 0; block < 40; block++) {
    analysis.push(new Float32Array(128).fill(block), new Float32Array(128).fill(-block));
  }
  const report = analysis.report();
  assert.equal(report.samples[0], 8);
  assert.equal(report.samples[ANALYSIS_SIZE - 1], 39);
  assert.equal(report.samples[ANALYSIS_SIZE], -8);
}

// FFT pitch and amplitude are calibrated; opposite-phase stereo must not disappear.
for (const frequency of [93.75, 996.09375, 15000]) {
  for (const phase of [1, -1]) {
    const samples = new Float32Array(2 * ANALYSIS_SIZE);
    for (let i = 0; i < ANALYSIS_SIZE; i++) {
      samples[i] = 0.5 * Math.sin(2 * Math.PI * frequency * i / sampleRate);
      samples[ANALYSIS_SIZE + i] = samples[i] * phase;
    }
    const levels = new Spectrum().measure(samples);
    const bin = levels.indexOf(Math.max(...levels));
    near(bin * sampleRate / ANALYSIS_SIZE, frequency);
    near(levels[bin], dbFS(0.5));
  }
}
assert.ok(new Spectrum().measure(new Float32Array(ANALYSIS_SIZE * 2)).every(v => v === -Infinity));
assert.equal(dbFS(0), -Infinity);
near(dbFS(2), 6.020599913);

// Monitoring an uncabled module renders its dependencies but never sends it to the master.
for (const backend of ['js', 'wasm', 'wasm-jsgraph']) {
  const native = backend !== 'js'
    ? wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), sampleRate) : {};
  const { graph, dsp, render } = dspTestHost({ ...native, native: backend !== 'wasm-jsgraph' });
  const osc = dsp.create('osc');
  osc.send({ type: 'noteOn', id: 1, pitch: 69, velocity: 1 });
  const master = new Float32Array(128), right = new Float32Array(128);
  graph.render(master, right);
  assert.equal(graph.analysis, null, `${backend}: analysis disabled by default`);
  assert.ok(master.every(v => v === 0));
  dsp.analyse(osc.h);
  for (let i = 0; i < 40; i++) graph.render(master, right);
  const result = graph.analysis.report();
  assert.ok(result.samples.some(value => Math.abs(value) > 0.1), `${backend}: uncabled sound is measured`);
  assert.ok(master.every(v => v === 0), `${backend}: monitoring does not leak to speakers`);
  dsp.analyse(osc.h, 8192);
  assert.equal(graph.analysis.size, 8192, `${backend}: same target can change window size`);
  render(8192 / 128);
  assert.equal(graph.analysis.report().samples.length, 16384);
  dsp.analyse(osc.h);
  osc.send({ type: 'allOff' });
  render(1);
  graph.analysis.report();
  render(ANALYSIS_SIZE / 128);
  assert.ok(graph.analysis.report().samples.every(value => value === 0), `${backend}: silent nodes do not report stale audio buffers`);
  osc.send({ type: 'noteOn', id: 2, pitch: 69, velocity: 1 });
  osc.connect(dsp.destination);
  render(ANALYSIS_SIZE / 128);
  assert.ok(graph.analysis.report().samples.some(value => Math.abs(value) > 0.1));
  assert.ok(graph.master.silent === false);
  dsp.analyse(null);
  assert.equal(graph.analysis, null, `${backend}: closing frees the analysis buffers`);
  osc.disconnect(dsp.destination);
  render(1);
  assert.ok(!graph.order.some(n => n.h === osc.h), 'closed panel does not keep disconnected nodes rendering');
  dsp.analyse(osc.h);
  osc.destroy();
  render(ANALYSIS_SIZE / 128);
  assert.ok(graph.analysis.report().samples.every(value => value === 0), 'deleted nodes yield silence, not stale samples');
}

// Selection uses the node after the Output's master gain, not the input signal or a controller.
{
  assert.equal(analysisHandle({ def: { isOutput: true }, inst: { input: { h: 3 } } }), 3);
  assert.equal(analysisHandle({ def: { hasOutput: true }, inst: { node: { h: 4 } } }), 4);
  assert.equal(analysisHandle({ def: { hasOutput: true, modulator: true }, inst: { node: { h: 5 } } }), null);
  assert.equal(analysisHandle({ def: { hasOutput: true, modulator: true, audioThrough: true }, values: { mode: 1 }, inst: { node: { h: 6 } } }), 6);
  assert.equal(analysisHandle({ def: { hasOutput: true }, inst: { outSignals: () => ({ midi: true }), node: { h: 7 } } }), null);
  assert.equal(analysisHandle({ def: { hasOutput: true }, inst: {} }), null);
}

console.log('Analyse DSP, FFT and target selection tests passed');
