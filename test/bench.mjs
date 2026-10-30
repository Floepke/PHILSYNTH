// Run: node test/bench.mjs   DSP speed: every C++ kernel vs its JS twin, and whole graphs.
// Not part of `npm test` (timings depend on the machine); `npm run bench`.
import { readFileSync } from 'node:fs';

globalThis.sampleRate = 48000;
const { KERNELS } = await import('../src/dsp/kernels.js');
const { instantiateDsp, wasmKernels } = await import('../src/dsp/wasm.js');
const { dspTestHost } = await import('./dsphost.mjs');

const x = instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url)));
const W = wasmKernels(x, 48000);
const N = 128;
const SECONDS = 2;
const BLOCKS = Math.round((SECONDS * 48000) / N);

const signal = () => {
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  for (let i = 0; i < N; i++) { L[i] = Math.sin(i * 0.1) * 0.5; R[i] = Math.cos(i * 0.07) * 0.5; }
  return [L, R];
};
const param = (id, value) => ({ type: 'param', id, value });
const noteOn = (id, pitch) => ({ type: 'noteOn', id, pitch, velocity: 0.7 });

const CASES = {
  'OSC 8 voices saw': { kind: 'osc', input: false, msgs: [param('polyphony', 8), param('wave', 1), ...[0, 3, 7, 10, 12, 15, 19, 24].map((p, i) => noteOn(i + 1, 48 + p))] },
  'OSC 8 voices sine duty': { kind: 'osc', input: false, msgs: [param('polyphony', 8), param('wave', 0), param('duty', 30), ...[0, 3, 7, 10, 12, 15, 19, 24].map((p, i) => noteOn(i + 1, 48 + p))] },
  'FILTER lowpass 24 dB': { kind: 'filter', msgs: [param('type', 0), param('slope', 1), param('resonance', 0.5)] },
  'FILTER ladder': { kind: 'filter', msgs: [param('type', 9), param('resonance', 0.5)] },
  'FILTER sine LFO': { kind: 'filter', msgs: [param('type', 0), param('lfoDepth', 1), param('lfoRate', 2)] },
  'WAVESHAPER 1×': { kind: 'waveshaper', msgs: [param('drive', 6)] },
  'WAVESHAPER 4×': { kind: 'waveshaper', msgs: [param('drive', 6), param('oversample', 2)] },
  REVERB: { kind: 'reverb', msgs: [param('mix', 0.5)] },
  AMP: { kind: 'amp', msgs: [param('pan', 0.3)] },
};

function time(K, c) {
  const k = new K({});
  for (const m of c.msgs) k.message(m);
  const ins = c.input === false ? [[]] : [signal()];
  const outs = [W.heap ? [W.heap.f32(W.heap.alloc(N * 4), N), W.heap.f32(W.heap.alloc(N * 4), N)] : null];
  for (let b = 0; b < 300; b++) k.process(ins, outs); // warm up
  const t0 = performance.now();
  for (let b = 0; b < BLOCKS; b++) k.process(ins, outs);
  const ms = performance.now() - t0;
  k.destroy?.();
  return (ms / SECONDS) / 10; // % of one core (ms per 1 s of audio / 1000 * 100)
}

console.log(`kernel                      JS %core   C++ %core   speed-up   (one instance, 48 kHz)`);
for (const [name, c] of Object.entries(CASES)) {
  const js = time(KERNELS[c.kind], c);
  const wa = W.kernels[c.kind] ? time(W.kernels[c.kind], c) : NaN;
  console.log(`${name.padEnd(26)} ${js.toFixed(3).padStart(8)}   ${wa.toFixed(3).padStart(9)}   ${(js / wa).toFixed(2).padStart(7)}×`);
}

// whole graphs: many small modules (call overhead) and a heavy patch
function graph(opts, build) {
  const { dsp, render } = dspTestHost(opts);
  build(dsp);
  render(300);
  const t0 = performance.now();
  render(BLOCKS);
  return (performance.now() - t0) / SECONDS / 10;
}
const heavy = (dsp) => {
  for (let i = 0; i < 16; i++) {
    const o = dsp.create('osc');
    o.param('polyphony', 4);
    o.param('wave', 2);
    const f = dsp.create('filter');
    f.param('type', i % 2 ? 9 : 0);
    f.param('slope', 3);
    const w = dsp.create('waveshaper');
    w.param('oversample', 2);
    o.connect(f); f.connect(w); w.connect(dsp.destination);
    for (let v = 0; v < 4; v++) o.send(noteOn(100 + v, 48 + v * 7));
  }
  const r = dsp.create('reverb');
  const src = dsp.create('osc');
  src.connect(r); r.connect(dsp.destination);
  src.send(noteOn(1, 60));
};
const many = (dsp) => {
  for (let i = 0; i < 40; i++) {
    const o = dsp.create('osc');
    o.param('polyphony', 1);
    let prev = o;
    for (let j = 0; j < 4; j++) { const a = dsp.create('amp'); prev.connect(a); prev = a; }
    prev.connect(dsp.destination);
    o.send(noteOn(1, 40 + i));
  }
};
console.log('\ngraph                                        JS %core   C++ %core   speed-up');
for (const [name, build] of [['16×(OSC→FILTER→WAVESHAPER 4×) + REVERB', heavy], ['40×(OSC 1 voice → 4 AMP) = 200 nodes', many]]) {
  const js = graph(undefined, build);
  const wa = graph(W, build);
  console.log(`${name.padEnd(44)} ${js.toFixed(1).padStart(8)}   ${wa.toFixed(1).padStart(9)}   ${(js / wa).toFixed(2).padStart(7)}×`);
}
