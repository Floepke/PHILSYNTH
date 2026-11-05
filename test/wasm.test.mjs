// Run: node test/wasm.test.mjs   (C++ kernels in src/dsp/modsynth.wasm vs their JS twins)
// Rebuild the .wasm first after changing cpp/: npm run build:wasm
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PatchRuntime } from '../src/patch.js';
import { addImage, addSample } from '../src/samples.js';

globalThis.sampleRate = 48000;
const { KERNELS } = await import('../src/dsp/kernels.js');
const { instantiateDsp, wasmKernels, SPECS } = await import('../src/dsp/wasm.js');
const { getModule } = await import('../src/modules/index.js');
const { dspTestHost } = await import('./dsphost.mjs');

const bytes = readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url));
const x = instantiateDsp(bytes);
const { heap, kernels: WASM } = wasmKernels(x, 48000);
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), [], 'no imports');

// SOUND2CTL reads native audio buffers; adding/removing its routes switches render paths safely.
{
  const { dsp, graph, render } = dspTestHost({ kernels: WASM, heap });
  const src = dsp.create('osc');
  const ctl = dsp.create('sound2ctl');
  const target = dsp.create('amp');
  src.connect(dsp.destination);
  src.connect(ctl);
  src.send({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  render();
  assert.ok(graph.prog, 'native render without audio-control routes');
  let applied;
  target.onMod = (_id, value) => { applied = value; };
  ctl.routes([{ to: target.h, id: 'amp', min: 0, max: 4 }]);
  render();
  assert.equal(graph.prog, 0, 'mixed JS/native render for audio conversion');
  const [left, right] = graph.nodes.get(src.h).outs[0];
  const voltage = 0.5 * (left[127] + right[127]);
  assert.ok(Math.abs(applied - 2 * (Math.max(-1, Math.min(1, voltage)) + 1)) < 1e-6, 'final signed sample, not peak or envelope');
  ctl.routes([]);
  render();
  assert.ok(graph.prog, 'native rendering restored after removing routes');
  src.destroy(); ctl.destroy(); target.destroy();
}

// LFO tremolo (JS) between native kernels: mixed render while sound goes in, native again after.
{
  const { dsp, graph, render } = dspTestHost({ kernels: WASM, heap });
  const src = dsp.create('osc');
  const lfo = dsp.create('lfo');
  const amp = dsp.create('amp');
  for (const [id, v] of [['amp', 0], ['outMin', 50], ['outMax', 50]]) lfo.param(id, v);
  amp.connect(dsp.destination);
  src.send({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  render();
  assert.ok(graph.prog, 'native render while the LFO only modulates');
  src.connect(lfo);
  lfo.connect(amp);
  render();
  assert.equal(graph.prog, 0, 'mixed JS/native render for the tremolo');
  const s = graph.nodes.get(src.h).outs[0][0];
  const t = graph.nodes.get(lfo.h).outs[0][0];
  assert.ok(Math.abs(s[64]) > 1e-3 && Math.abs(t[64] - 0.5 * s[64]) < 1e-6, 'native sound at 50 % volume');
  const a = graph.nodes.get(amp.h).outs[0][0];
  assert.ok(Math.abs(a[64] - t[64]) < 1e-6, 'into the native AMP');
  src.disconnect(lfo);
  lfo.disconnect(amp);
  render();
  assert.ok(graph.prog, 'native rendering restored');
  assert.equal(graph.nodes.get(lfo.h).audio, false);
  src.destroy(); lfo.destroy(); amp.destroy();
}

// PANIC through the host: echo tail with feedback into a reverb, in the JS graph and the native graph
for (const opts of [{}, { kernels: WASM, heap }]) {
  const { dsp, graph, render } = dspTestHost(opts);
  const src = dsp.create('osc');
  const echo = dsp.create('echo');
  const verb = dsp.create('reverb');
  src.connect(echo);
  echo.connect(verb);
  verb.connect(dsp.destination);
  echo.send({ type: 'param', id: 'feedback', value: 0.95 });
  echo.send({ type: 'param', id: 'delay', value: 50 });
  src.send({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  render(20);
  src.send({ type: 'allOff' });
  const peak = () => { const { L, R } = render(); return Math.max(...L.map(Math.abs), ...R.map(Math.abs)); };
  let before = 0;
  for (let i = 0; i < 40; i++) before = Math.max(before, peak());
  assert.ok(before > 1e-3, `tail still sounding before the panic (${before})`);
  dsp.panic();
  for (let i = 0; i < 20; i++) assert.equal(peak(), 0, `${opts.kernels ? 'native' : 'JS'} graph silent after the panic`);
  src.send({ type: 'noteOn', id: 2, pitch: 60, velocity: 1 });
  let after = 0;
  for (let i = 0; i < 20; i++) after = Math.max(after, peak());
  assert.ok(after > 1e-3, 'plays again after the panic');
  src.destroy(); echo.destroy(); verb.destroy();
}

// ---- the controller lists match the module definitions ----
for (const [kind, spec] of Object.entries(SPECS)) {
  if (kind === 'bus') continue; // no module of its own
  const def = getModule({ dcblock: 'DC BLOCKER' }[kind] ?? kind.toUpperCase());
  assert.ok(def, kind);
  assert.deepEqual([...spec.params].sort(), def.params.filter((p) => p.dsp !== false).map((p) => p.id).sort(), `${kind}: every controller is mapped`);
}

// ---- parity: the same messages and input into both kernels give the same samples ----
const N = 128;
const stereo = () => [new Float32Array(N), new Float32Array(N)];
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

// script: [[block, message], ...]; input: (block, i, ch) -> sample, or null (nothing connected)
function compare(kind, { opts = {}, script = [], input = null, gaps = () => false, blocks = 200, tol = 1e-5, inHeap = false, channels = 2 }) {
  const js = new KERNELS[kind](opts);
  const wa = new WASM[kind](opts);
  let worst = 0;
  let at = -1;
  const output = () => Array.from({ length: channels }, () => new Float32Array(N));
  const outPtrs = inHeap ? Array.from({ length: channels }, () => heap.alloc(N * 4)) : null;
  const outW = outPtrs ? [outPtrs.map((p) => heap.f32(p, N))] : [output()];
  for (let b = 0; b < blocks; b++) {
    for (const [when, m] of script) if (when === b) {
      if (m === 'panic') { js.panic(); wa.panic(); } else { js.message(m); wa.message(m); }
    }
    let ins = [[]];
    if (input && !gaps(b)) {
      const [L, R] = stereo();
      for (let i = 0; i < N; i++) { L[i] = input(b, i, 0); R[i] = input(b, i, 1); }
      ins = [[L, R]];
    }
    const outJ = [output()];
    const rj = js.process(ins, outJ) !== false;
    if (outPtrs && outW[0][0].buffer !== heap.memory.buffer) outW[0] = outPtrs.map((p) => heap.f32(p, N));
    const rw = wa.process(ins, outW) !== false;
    assert.equal(rw, rj, `${kind}: same silent flag at block ${b}`);
    if (!rj) continue; // silent outputs are undefined
    for (let c = 0; c < channels; c++) {
      for (let i = 0; i < N; i++) {
        const d = Math.abs(outJ[0][c][i] - outW[0][c][i]);
        assert.ok(Number.isFinite(outW[0][c][i]), `${kind}: finite output`);
        if (d > worst) { worst = d; at = b; }
      }
    }
  }
  wa.destroy();
  js.destroy?.();
  if (outPtrs) outPtrs.forEach((p) => heap.free(p));
  assert.ok(worst <= tol, `${kind} ${JSON.stringify(script.slice(0, 3))}: differs by ${worst} at block ${at}`);
  return worst;
}
const param = (id, value) => ({ type: 'param', id, value });
const noteOn = (id, pitch, velocity = 0.8, phase) => ({ type: 'noteOn', id, pitch, velocity, ...(phase === undefined ? {} : { phase }) });

// SAMPLER: all five playback modes and interpolation choices, non-engine sample rates,
// stereo/mono, moving selections, glides, sample replacement and one-shot end conditions.
const sampleL = Float32Array.from({ length: 9001 }, (_, i) => 0.6 * Math.sin(i * 0.13) + 0.1 * Math.cos(i * 0.031));
const sampleR = Float32Array.from(sampleL, v => -v * 0.4);
for (const playMode of [0, 1, 2, 3, 4]) for (const interpolation of [0, 1, 2]) {
  for (const channels of [1, 2]) compare('sampler', {
    channels, blocks: 160, inHeap: true, tol: 1e-5,
    script: [
      [0, { type: 'sample', rate: 22050, channels: [sampleL, sampleR] }],
      [0, param('playMode', playMode)], [0, param('interpolation', interpolation)],
      [0, param('attack', 0.001)], [0, param('release', 0.012)],
      [0, param('selStart', 12.31)], [0, param('selLength', 60.23)],
      [0, noteOn(1, 60.37, 0.9, 0.75)], [3, noteOn(2, 48.21, 0.4)],
      [8, { type: 'noteMod', notes: [[1, 84.9, 0.25], [2, 51.2, 0.8]] }],
      [12, param('transpose', -5)], [13, param('finetune', 23)],
      [20, param('selStart', 87.3)], [21, param('selLength', 0)],
      [24, noteOn(3, 127.4)], [28, param('selLength', 12)],
      [32, { type: 'noteOff', id: 2 }], [34, param('release', 1)],
      [40, { type: 'sample', rate: 96000, channels: [sampleR] }],
      [41, noteOn(4, 60.8)], [44, param('playMode', 4)], [50, param('playMode', 2)],
      [55, param('selStart', 0)], [55, param('selLength', 100)],
      [70, 'panic'], [72, noteOn(5, 58.2)], [80, { type: 'allOff' }],
      [90, { type: 'sample', rate: 0, channels: null }], [91, noteOn(6, 60)],
      [100, { type: 'sample', rate: 48000, channels: [sampleL] }], [101, noteOn(7, 64.5)],
    ],
  });
}

for (const kind of ['sampler', 'wavetable']) {
  compare(kind, {
    blocks: 160,
    script: [
      ...(kind === 'sampler' ? [[0, { type: 'sample', rate: 48000, channels: [sampleL, sampleR] }], [0, param('playMode', 3)]] : []),
      [0, param('polyphony', 32)],
      ...Array.from({ length: 36 }, (_, i) => [i, noteOn(i + 1, 40 + i * 0.7, 0.6)]),
      [38, noteOn(35, 70.33, 0.9)], // retrigger by id rather than stealing another voice
      [40, param('polyphony', 3)], [41, param('polyphony', 8)],
      [42, { type: 'noteMod', notes: [[35, 60.7, 0.2], [36, 61.3, 0.9]] }],
      [45, param('attack', 0.03)], [46, param('decay', 0.01)], [47, param('sustain', 0.2)],
      [48, param('gain', 0.7)], [50, noteOn(40, 67, 1)],
      [60, param('release', 0.02)], [62, { type: 'noteOff', id: 40 }],
      [70, { type: 'allOff' }], [72, noteOn(41, 65)], [80, 'panic'], [82, noteOn(42, 44.1)],
    ],
  });
}

// WAVETABLE: exact FFT mipmaps for power-of-two and resampled odd-sized frames,
// phase wrapping, high-note anti-aliasing, frame morphing, layout changes and builtin fallback.
for (const frame of [2, 7, 256, 257, 2048, 4096]) for (const interpolation of [0, 1, 2]) {
  const data = Float32Array.from({ length: frame * 3 + 1 }, (_, i) => Math.sin(i * 0.17) * 0.5 + Math.cos(i * 0.043) * 0.3);
  compare('wavetable', {
    blocks: 140, inHeap: true, channels: interpolation === 0 ? 1 : 2,
    script: [
      [0, { type: 'table', data, frame }], [0, param('interpolation', interpolation)],
      [0, param('attack', 0.001)], [0, param('release', 0.01)],
      [0, noteOn(1, 48.7, 0.9, -0.3)], [1, noteOn(2, 110.3, 0.6, 1.25)],
      [3, param('position', 100)], [12, param('position', 27.3)],
      [20, { type: 'noteMod', notes: [[1, 94.2, 0.2]] }],
      [30, param('block', 1)], [35, param('position', 50.5)],
      [40, param('block', 5)], [50, param('block', 0)],
      [60, { type: 'noteOff', id: 2 }], [65, { type: 'table', data: null }],
      [68, noteOn(3, 69.25, 0.7, 0.25)], [70, param('position', 81.7)],
      [90, 'panic'], [92, noteOn(4, 127, 0.6)], [100, { type: 'allOff' }],
    ],
  });
}

// Uploads and mipmaps are shared across cloned Patch messages, released at their last owner,
// and never grow memory during rendering (including first-time FFT/frame visits).
{
  const counts = { banks: 0, bankFrees: 0, tables: 0, tableFrees: 0 };
  let failBank = false, failTable = false;
  const api = {
    ...x,
    ms_sample_create(...args) { if (failBank) return 0; counts.banks++; return x.ms_sample_create(...args); },
    ms_sample_free(ptr) { counts.bankFrees++; x.ms_sample_free(ptr); },
    ms_table_create(...args) { if (failTable) return 0; counts.tables++; return x.ms_table_create(...args); },
    ms_table_free(ptr) { counts.tableFrees++; x.ms_table_free(ptr); },
  };
  const native = wasmKernels(api, 48000);
  const a = new native.kernels.sampler(), b = new native.kernels.sampler();
  for (const k of [a, b]) k.message({ type: 'sample', rate: 48000, channels: [sampleL.slice(), sampleR.slice()] });
  assert.equal(counts.banks, 1, 'stereo PCM shared by content');
  a.destroy();
  assert.equal(counts.bankFrees, 0, 'another sampler still owns the data');
  b.message(noteOn(1, 60));
  assert.equal(b.process([[]], [stereo()]), true, 'surviving owner still plays');
  b.destroy(); b.destroy();
  assert.equal(counts.bankFrees, 1, 'last owner frees PCM once');
  const c = new native.kernels.wavetable(), d = new native.kernels.wavetable();
  assert.equal(c.sampleEntry, d.sampleEntry, 'builtin PCM shared');
  assert.equal(c.tableEntry, d.tableEntry, 'builtin FFT cache shared');
  const custom = sampleL.slice(0, 1024);
  for (const k of [c, d]) k.message({ type: 'table', data: custom.slice(), frame: 256 });
  assert.equal(c.tableEntry, d.tableEntry, 'cloned custom tables share mipmaps');
  c.param('block', 2);
  assert.notEqual(c.tableEntry, d.tableEntry, 'different frame sizes have different caches');
  const previous = c.tableEntry;
  failTable = true;
  assert.throws(() => c.param('block', 3), /cannot allocate wavetable/);
  assert.equal(c.tableEntry, previous, 'failed layout change preserves the current table');
  assert.throws(() => c.message({ type: 'table', data: sampleR, frame: 7 }), /cannot allocate wavetable/);
  assert.equal(c.tableEntry, previous, 'failed replacement preserves the current table and releases its new PCM');
  failTable = false;
  failBank = true;
  assert.throws(() => c.message({ type: 'table', data: sampleR, frame: 7 }), /cannot allocate sample/);
  assert.equal(c.tableEntry, previous);
  failBank = false;
  c.destroy();
  d.message(noteOn(1, 60));
  const mem = native.heap.memory.buffer;
  const outputs = [stereo()];
  for (let i = 0; i < 80; i++) {
    d.param('position', i % 2 ? 100 : 0);
    assert.equal(d.process([[]], outputs), true);
    assert.equal(native.heap.memory.buffer, mem, 'first-time frame builds cannot detach graph buffers');
  }
  d.destroy();
  assert.equal(counts.banks, counts.bankFrees, 'all native PCM freed');
  assert.equal(counts.tables, counts.tableFrees, 'all native mipmaps freed');
}

// Modules use the native graph through real state uploads, including a Patch container.
for (const type of ['SAMPLER', 'WAVETABLE']) {
  const h = dspTestHost({ kernels: WASM, heap });
  const engine = { ctx: { get currentTime() { return h.time; } }, dsp: h.dsp };
  const root = await PatchRuntime.create(engine, h.dsp.destination);
  const folder = await root.addModule('PATCH');
  const sampleId = addSample({ rate: 48000, channels: [sampleL] });
  const entry = await folder.inst.patch.addModule(type, { state: { sampleId, frame: 256 }, values: { playMode: 3 } });
  assert.ok(folder.inst.patch.connect(entry.id, 0) && root.connect(folder.id, 0));
  folder.inst.noteOn(1, 60.7, 0.8, 0.3);
  let peak = 0;
  for (let i = 0; i < 20; i++) peak = Math.max(peak, ...h.render().L.map(Math.abs));
  assert.ok(h.graph.prog, `${type} can run entirely through the native graph`);
  assert.ok(peak > 0.01);
  h.dsp.panic();
  assert.ok(h.render().L.every(v => v === 0), `${type}: native graph panic is silent`);
  root.destroy();
  h.dsp.destination.destroy();
}

// Sample-based graphs switch safely between the single-call native runner and mixed rendering.
for (const kind of ['sampler', 'wavetable']) {
  const h = dspTestHost({ kernels: { ...WASM, jsonly: KERNELS.bus }, heap });
  const src = h.dsp.create(kind);
  src.connect(h.dsp.destination);
  if (kind === 'sampler') {
    src.send({ type: 'sample', rate: 48000, channels: [sampleL] });
    src.param('playMode', 3);
  }
  src.send(noteOn(1, 60.7));
  assert.ok(h.render(4).L.some(v => v !== 0));
  assert.ok(h.graph.prog);
  const bus = h.dsp.create('jsonly');
  src.disconnect(h.dsp.destination);
  src.connect(bus); bus.connect(h.dsp.destination);
  assert.ok(h.render(4).L.some(v => v !== 0));
  assert.equal(h.graph.prog, 0);
  bus.destroy();
  src.connect(h.dsp.destination);
  assert.ok(h.render(4).L.some(v => v !== 0));
  assert.ok(h.graph.prog);
  src.destroy(); h.dsp.destination.destroy();
}

// Block Size modulation can allocate a new layout before or after audio processing. Force
// memory growth to exercise buffer remapping, including the scope and final output copy.
for (const modKind of ['multictl', 'sound2ctl']) {
  const native = wasmKernels({
    ...x,
    ms_table_create(...args) { x.memory.grow(1); return x.ms_table_create(...args); },
  }, 48000);
  const h = dspTestHost(native);
  const src = h.dsp.create('wavetable'), mod = h.dsp.create(modKind);
  src.connect(h.dsp.destination);
  if (modKind === 'sound2ctl') src.connect(mod);
  h.dsp.scope([src.h]);
  src.send(noteOn(1, 60));
  assert.ok(h.render(4).L.some(v => v !== 0));
  const before = x.memory.buffer;
  mod.routes([{ to: src.h, id: 'block', min: 2, max: 2, step: 1 }]);
  const out = h.render();
  assert.notEqual(x.memory.buffer, before, 'Block Size modulation forced a heap growth');
  assert.ok(out.L.every(Number.isFinite) && out.L.some(v => v !== 0));
  assert.equal(h.graph.nodes.get(src.h).outs[0][0].buffer, x.memory.buffer);
  src.destroy(); mod.destroy(); h.dsp.destination.destroy();
}

// OPERATOR: stereo PM, monophonic note ownership, fractional tuning, curves, smoothing and panic.
for (const feedback of [0, 2]) {
  compare('operator', {
    blocks: 160, tol: 1e-5, inHeap: true,
    input: (b, i, ch) => 0.2 * Math.sin((b * N + i) * (ch ? 0.07 : 0.11)),
    gaps: (b) => b >= 50 && b < 60,
    script: [
      [0, param('feedback', feedback)], [0, param('modulation', 25)], [0, param('attack', 0.01)],
      [0, noteOn(1, 60.37, 0.7, 0.2)], [5, param('modulation', 200)],
      [10, { type: 'noteMod', notes: [[1, 72.15, 0.3]] }], [15, param('velocity', 0)],
      [20, param('atkCurve', -100)], [25, param('gain', 0.2)],
      [30, noteOn(2, 65.5)], [35, { type: 'noteOff', id: 1 }],
      [40, param('sustain', 0.3)], [45, param('relCurve', -50)], [65, param('release', 0.03)],
      [70, { type: 'noteOff', id: 2 }], [100, 'panic'], [110, noteOn(3, 69, 1, -0.3)],
      [120, { type: 'allOff' }], [130, noteOn(4, 48, 0.5, 1.25)],
    ],
  });
}

function operatorGraph(opts, modulation) {
  const { dsp, graph, render } = dspTestHost(opts);
  const a = dsp.create('operator'), b = dsp.create('operator');
  a.connect(b); b.connect(dsp.destination);
  b.send(param('modulation', modulation));
  render();
  a.send(noteOn(1, 60.37, 1));
  assert.ok(render(4).L.every((v) => v === 0), 'modulator audio alone cannot play a carrier');
  b.send(noteOn(2, 69.12, 1));
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push(...render().L);
  if (opts.heap) assert.ok(graph.prog, 'operator network uses native rendering');
  dsp.panic();
  assert.ok(render().L.every((v) => v === 0), 'operator network panic clears tails');
  a.destroy(); b.destroy();
  return samples;
}
const opJs = operatorGraph({}, 100);
const opNative = operatorGraph({ kernels: WASM, heap }, 100);
const opDry = operatorGraph({ kernels: WASM, heap }, 0);
assert.ok(opNative.every((v, i) => Math.abs(v - opJs[i]) < 1e-5), 'native operator network matches JS');
assert.ok(opNative.some((v, i) => Math.abs(v - opDry[i]) > 0.01), 'operator audio cable modulates downstream phase');

// Strong self-feedback can be chaotic (tiny floating-point differences diverge), so test
// boundedness and deterministic resets in each engine rather than sample equality between them.
for (const K of [KERNELS.operator, WASM.operator]) {
  const k = new K();
  k.message(param('feedback', 100));
  const out = [stereo()];
  k.process([[]], out);
  const play = () => {
    k.message(noteOn(1, 60.13, 1, 0.2));
    const samples = [];
    for (let b = 0; b < 60; b++) {
      k.process([[]], out);
      assert.ok(out[0][0].every((v) => Number.isFinite(v) && Math.abs(v) < 1));
      samples.push(...out[0][0]);
    }
    return samples;
  };
  const first = play();
  k.panic();
  assert.equal(k.process([[]], out), false, 'silent after panic (silent output buffers are undefined)');
  assert.deepEqual(play(), first, 'panic clears self-feedback and filter state');
  k.destroy?.();
}

// IMAGESAMPLER: all scanners, odd and power-of-two table sizes, movement, colours, voice
// stealing, curved envelopes, image replacement/removal, fractional pitch, start phase and panic.
function imageMessage(width, height, seed = 123) {
  const random = noise(seed);
  return { type: 'image', width, height, rgb: Uint8Array.from({ length: width * height * 3 }, () => Math.floor((random() + 1) * 127.5)) };
}
for (const [width, height] of [[1, 1], [3, 5], [256, 256]]) {
  for (const scanType of [0, 1, 2, 3, 4]) {
    for (const resolution of [2, 3, 64, 1024, 2048]) {
      compare('imagesampler', {
        blocks: 100, tol: 2e-6, inHeap: true,
        script: [
          [0, param('scanType', scanType)], [0, param('resolution', resolution)], [0, param('polyphony', 3)],
          [0, imageMessage(width, height)], [0, noteOn(1, 48.37, 0.8, 0.23)],
          [2, noteOn(2, 72.12, 0.5, -0.3)], [4, noteOn(3, 93)], [5, noteOn(4, 60)],
          [6, param('x', 21)], [7, param('y', 80)], [8, param('length', 20)],
          [9, param('rotation', 179)], [10, param('speed', -3.1)],
          [11, param('ovalWidth', 30)], [12, param('ovalHeight', 90)], [13, param('ovalRotation', -175)],
          [13, param('triX1', 3)], [13, param('triY3', 97.5)], [14, param('triX2', 60)],
          [14, param('redLeft', -80)], [15, param('blueRight', 30)], [16, param('greenRight', -50)],
          [17, { type: 'noteMod', notes: [[4, 70.34, 0.3]] }],
          [18, param('atkCurve', -75)], [19, param('decCurve', 100)], [20, param('sustain', 0.2)],
          [22, param('relCurve', -100)], [23, param('release', 0.01)], [24, { type: 'noteOff', id: 4 }],
          [30, param('scanType', (scanType + 1) % 5)], [35, param('resolution', 7)],
          [40, imageMessage(7, 3, 321)], [45, param('polyphony', 1)], [50, 'panic'],
          [55, noteOn(5, 65.5)], [60, { type: 'allOff' }], [65, noteOn(6, 48)],
          [70, { type: 'image', width: 0, height: 0, rgb: null }],
          [75, imageMessage(width, height)], [76, noteOn(7, 60)],
          [80, param('gain', 0.8)], [82, param('release', 0.001)], [83, { type: 'noteOff', id: 7 }],
        ],
      });
    }
  }
}

// IMAGESAMPLER Propellor: every voice turned by its note's phase (own tables), voice reuse, phase 0
// sharing the table, switching scanner types mid-note.
for (const speed of [0, 2.7]) {
  compare('imagesampler', {
    blocks: 60, tol: 2e-6, inHeap: true,
    script: [
      [0, param('scanType', 1)], [0, param('speed', speed)], [0, param('polyphony', 3)], [0, param('resolution', 48)],
      [0, imageMessage(40, 30)], [0, noteOn(1, 50, 0.7, 0.13)], [0, noteOn(2, 57.3, 0.6, 0.71)],
      [3, noteOn(3, 62, 0.5, 0)], [6, param('length', 60)], [8, noteOn(4, 66, 0.5, 0.42)],
      [12, param('scanType', 0)], [16, param('scanType', 1)], [20, { type: 'noteOff', id: 2 }],
      [24, noteOn(5, 45, 0.9, 0.9)], [30, param('x', 30)], [36, 'panic'], [38, noteOn(6, 60, 0.8, 0.5)],
    ],
  });
}

// Content-sharing survives cloned messages and releases only the replaced/deleted owner's ref.
for (const K of [KERNELS.imagesampler, WASM.imagesampler]) {
  const a = new K(), b = new K();
  a.message(imageMessage(16, 7));
  b.message(imageMessage(16, 7));
  assert.equal(a.imageEntry, b.imageEntry, 'identical image content prepared once');
  const original = b.imageEntry;
  assert.equal(original.refs, 2);
  a.message(imageMessage(16, 7, 456));
  assert.notEqual(a.imageEntry, b.imageEntry, 'changed content uses its own pyramid');
  assert.equal(original.refs, 1);
  a.destroy();
  assert.equal(original.refs, 1);
  b.message(noteOn(1, 60));
  assert.equal(b.process([[]], [stereo()]), true, 'remaining image owner keeps playing');
  b.message({ type: 'image', width: 0, height: 0, rgb: null });
  assert.equal(original.refs, 0);
  b.destroy();
}

// Fully native sixteen-instance rendering, shared image lifecycle and fractional MIDI notes.
{
  const { dsp, graph, render } = dspTestHost({ kernels: WASM, heap });
  const nodes = [];
  for (let i = 0; i < 16; i++) {
    const node = dsp.create('imagesampler');
    node.send(imageMessage(256, 256));
    node.param('scanType', 1);
    node.connect(dsp.destination);
    node.send(noteOn(i, 48 + i * 0.37));
    nodes.push(node);
  }
  assert.ok(render(20).L.some((v) => Math.abs(v) > 1e-5), 'sixteen moving image scanners produce sound');
  assert.ok(graph.prog, 'image samplers no longer force mixed JS/native rendering');
  nodes[0].destroy();
  assert.ok(render().L.every(Number.isFinite), 'deleting one shared image user preserves the others');
  dsp.panic();
  assert.ok(render().L.every((v) => v === 0), 'native image network panic');
  for (const node of nodes.slice(1)) node.destroy();
}

// Real Patch Instances use sampleFeeder state (not hand-sent image messages).
for (const options of [{}, { kernels: WASM, heap }]) {
  const { dsp, graph, render, kernel } = dspTestHost(options);
  const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const rt = await PatchRuntime.create(engine, dsp.destination);
  const patch = await rt.addModule('PATCH');
  const msg = imageMessage(32, 17);
  const imageId = addImage({ width: msg.width, height: msg.height, rgb: msg.rgb });
  const entry = await patch.inst.patch.addModule('IMAGESAMPLER', {
    state: { imageId }, values: { scanType: 1, resolution: 1024 },
  });
  patch.inst.patch.connect(entry.id, 0);
  rt.connect(patch.id, 0);
  rt.setParam(patch.id, 'instances', 16);
  await patch.inst.sync();
  const copies = [patch.inst.patch, ...patch.inst.clones];
  assert.equal(copies.length, 16);
  const shared = kernel(entry.inst.node).imageEntry;
  assert.ok(copies.every((copy) => kernel(copy.modules.get(entry.id).inst.node).imageEntry === shared));
  assert.equal(shared.refs, 16, 'all sixteen real Patch instances share image preparation');
  for (let i = 0; i < 16; i++) patch.inst.noteOn(100 + i, 48 + i * 0.37, 0.8);
  assert.ok(render(20).L.some((v) => Math.abs(v) > 1e-5), 'all Patch copies play');
  if (options.heap) assert.ok(graph.prog, 'Patch instances use the fully native render path');
  rt.setParam(patch.id, 'instances', 2);
  await patch.inst.sync();
  assert.equal(shared.refs, 2, 'removed instances release their image ownership');
  rt.destroy();
  assert.equal(shared.refs, 0, 'deleting the Patch releases the final prepared image');
}

// DELAY / ECHO: fractional taps, controller glides, tempo sync and all feedback filters.
compare('delay', {
  blocks: 160, input: (b, i, ch) => b < 20 ? Math.sin((b * N + i) * (ch ? 0.13 : 0.1)) : 0,
  script: [[0, param('left', 3.25)], [0, param('right', 5.125)], [10, param('left', 10.7)],
    [15, param('right', 0)], [25, param('unit', 3)], [25, param('left', 0)],
    [35, { type: 'bpm', value: 240 }], [60, param('unit', 0)]],
});
compare('delay', { blocks: 10 });
for (let filter = 0; filter <= 8; filter++) {
  compare('echo', {
    blocks: 160, tol: 1e-6, inHeap: filter % 2 === 1,
    input: (b, i, ch) => b < 20 ? 0.5 * Math.sin((b * N + i) * (ch ? 0.13 : 0.1)) : 0,
    script: [[0, param('delay', 3.25)], [0, param('filter', filter)], [0, param('cutoff', 1700)],
      [0, param('feedback', 0.8)], [5, param('mode', 1)], [10, param('delay', 7.1)],
      [20, param('cutoff', 500)], [30, param('unit', 3)], [30, param('delay', 0)],
      [40, { type: 'bpm', value: 300 }], [50, param('unit', 0)], [70, param('filter', (filter + 4) % 9)],
      [100, param('wet', 0.1)], [110, param('feedback', 0.99)]],
  });
}
compare('echo', { blocks: 10 });

// OSC: every waveform, duty sweeps, glides, release, voice stealing, polyphony changes
for (let wave = 0; wave <= 4; wave++) {
  compare('osc', {
    blocks: 160,
    script: [
      [0, param('wave', wave)], [0, param('polyphony', 3)], [0, param('attack', 0.005)], [0, param('release', 0.05)],
      [0, noteOn(1, 60)], [3, noteOn(2, 64.5, 0.4)], [5, param('duty', 20)],
      [8, { type: 'noteMod', notes: [[1, 67, 0.3], [2, 52, 1]] }], [12, noteOn(3, 72)], [14, noteOn(4, 40)],
      [20, param('duty', 85)], [30, { type: 'noteOff', id: 3 }], [40, param('sustain', 0.3)],
      [60, param('polyphony', 1)], [70, { type: 'allOff' }], [80, noteOn(5, 100, 1)], [100, { type: 'noteOff', id: 5 }],
    ],
  });
}

// OSC envelope curves: analog / inverse shapes, live curve and time changes, release from mid-stage
compare('osc', {
  blocks: 200,
  script: [
    [0, param('polyphony', 4)], [0, param('attack', 0.02)], [0, param('decay', 0.05)], [0, param('sustain', 0.4)],
    [0, param('release', 0.08)], [0, param('atkCurve', 100)], [0, param('decCurve', -60)], [0, param('relCurve', 75)],
    [0, noteOn(1, 60)], [2, noteOn(2, 67, 0.7)], [3, { type: 'noteOff', id: 2 }], [5, param('atkCurve', -100)],
    [6, noteOn(3, 72)], [8, param('decCurve', 100)], [10, param('decay', 0.2)], [30, { type: 'noteOff', id: 1 }],
    [33, param('relCurve', -40)], [36, param('release', 0.3)], [60, param('sustain', 0)], [70, { type: 'noteOff', id: 3 }],
    [120, noteOn(4, 50, 1)], [121, param('atkCurve', 0.4)], [130, { type: 'noteOff', id: 4 }], [131, noteOn(4, 52)],
  ],
});

// OSC start phase (MODMIDI phase): wrapped into [0, 1), invalid -> 0, retrigger takes the new phase
for (let wave = 0; wave <= 4; wave++) {
  compare('osc', {
    blocks: 60,
    script: [
      [0, param('wave', wave)], [0, param('polyphony', 4)], [0, param('attack', 0.001)],
      [0, noteOn(1, 60, 0.8, 0.25)], [2, noteOn(2, 64, 0.6, 0.5)], [4, noteOn(3, 67, 0.7, 1.75)],
      [6, noteOn(4, 48, 0.9, -0.3)], [10, noteOn(1, 60, 0.8, 0.9)], [20, noteOn(2, 64, 0.6, NaN)],
    ],
  });
}

// OSC noise colours: same seed -> same noise (xorshift32 in both), voices share the generator
for (let wave = 5; wave <= 9; wave++) {
  const w = compare('osc', {
    opts: { seed: 1234 + wave },
    blocks: 80,
    tol: 0,
    script: [
      [0, param('wave', wave)], [0, param('polyphony', 3)], [0, noteOn(1, 60)], [2, noteOn(2, 30, 0.5)],
      [10, noteOn(3, 90)], [12, noteOn(4, 50)], [30, { type: 'noteOff', id: 2 }], [60, { type: 'allOff' }], [62, noteOn(5, 70)],
    ],
  });
  assert.equal(w, 0, `noise ${wave} bit-identical`);
}

// FILTER: every type, cascaded slopes, drive, the deterministic LFO shapes, tail without input
const rnd = noise(7);
const buzz = Array.from({ length: 4096 }, () => rnd());
const signal = (b, i, c) => 0.6 * buzz[(b * N + i + c * 333) % 4096] + 0.4 * Math.sin((b * N + i) * 0.05);
for (let type = 0; type <= 12; type++) {
  compare('filter', {
    input: (b, i, c) => (b < 100 ? signal(b, i, c) : 0),
    blocks: 160,
    tol: 2e-5,
    inHeap: type % 2 === 1,
    script: [
      [0, param('type', type)], [0, param('resonance', 0.7)], [0, param('slope', type % 4)], [0, param('gain', 9)],
      [0, param('cutoff', 900)], [0, param('vowel', 1.6)], [10, param('drive', 0.5)], [20, param('lfoDepth', 1.5)],
      [20, param('lfoRate', 3)], [40, param('lfoShape', 1)], [60, param('lfoShape', 2)], [80, param('lfoShape', 3)],
      [90, param('cutoff', 4000)], [95, param('mix', 0.6)], [96, param('level', 0.8)],
    ],
  });
}
// no input at all: rings out, then reports silence
compare('filter', { blocks: 40, script: [[0, param('resonance', 0.95)]] });
// type change across families resets the state
compare('filter', {
  input: signal, blocks: 60,
  script: [[0, param('type', 0)], [20, param('type', 9)], [40, param('type', 10)], [50, param('type', 3)]],
});

// REVERB: sleeping, waking, seed swap (with fade), salt, freeze, size/predelay glides, mono-ish input
compare('reverb', {
  input: (b, i, c) => (b >= 5 && b < 40 ? signal(b, i, c) : 0),
  blocks: 400,
  tol: 1e-4,
  inHeap: true,
  script: [
    [0, param('decay', 1.2)], [10, param('size', 0.9)], [20, param('seed', 7)], [30, param('predelay', 0.1)],
    [45, param('mod', 1)], [50, param('damp', 0.1)], [60, param('freeze', 1)], [90, param('freeze', 0)],
    [100, param('width', 0.3)], [110, param('mix', 1)], [120, param('lowCut', 400)], [130, param('highCut', 3000)],
  ],
});
compare('reverb', {
  opts: { salt: 3 },
  input: (b, i, c) => (b < 20 ? signal(b, i, 0) : 0),
  blocks: 120,
  tol: 1e-4,
  script: [[0, param('seed', 42)], [0, param('diffusion', 0.2)], [0, param('early', 1)], [60, param('seed', 43)]],
});
// asleep: no input at all keeps it silent
compare('reverb', { blocks: 10 });

// WAVESHAPER: curves (rounded points), both ranges, oversampling, drive / mix / level glides
const curve = { points: [{ x: 0, y: 0, r: 0 }, { x: 0.3, y: 0.8, r: 0.6 }, { x: 0.6, y: 0.2, r: 1 }, { x: 1, y: 1, r: 0 }] };
for (let os = 0; os <= 2; os++) {
  compare('waveshaper', {
    input: signal,
    blocks: 80,
    inHeap: os === 1,
    script: [
      [0, param('oversample', os)], [0, { type: 'curve', curve }], [5, param('drive', 12)], [20, param('range', 1)],
      [30, param('mix', 50)], [40, param('level', 0.5)], [50, param('range', 0)], [60, param('drive', -6)],
    ],
  });
}
compare('waveshaper', { blocks: 4 }); // nothing connected: silent
// silent input blocks in between (a source reporting silence): both twins ring out alike, then go silent
for (let os = 0; os <= 2; os++) {
  compare('waveshaper', {
    input: (b, i, ch) => signal(b, i, ch) + 0.3, gaps: (b) => (b >= 20 && b < 24) || b >= 40, blocks: 200,
    script: [[0, param('oversample', os)], [0, { type: 'curve', curve }], [0, param('mix', 70)]],
  });
}

// DISTORTION: all transfer types, quantization, hold clocks and live controller edits.
for (let type = 0; type < 12; type++) {
  compare('distortion', {
    input: (b, i, c) => signal(b, i, c) * 3,
    gaps: (b) => b >= 65 && b < 75,
    blocks: 100,
    inHeap: type % 2 === 0,
    script: [
      [0, param('type', type)], [0, param('power', 4)], [0, param('frequency', 11025)],
      [10, param('bits', 8)], [20, param('power', 12)], [30, param('frequency', 1)],
      [35, param('frequency', 1)], [40, param('frequency', 0)], [50, param('bits', 1)],
      [60, param('bits', 16)], [60, param('frequency', 9000)], [80, 'panic'],
    ],
  });
}
compare('distortion', { blocks: 4 });
for (const sr of [44100, 96000]) {
  globalThis.sampleRate = sr;
  const Native = wasmKernels(x, sr).kernels.distortion;
  try {
    for (let bits = 1; bits <= 16; bits++) {
      const js = new KERNELS.distortion(), native = new Native();
      for (const k of [js, native]) {
        k.param('bits', bits); k.param('frequency', 11025); k.param('power', 6);
      }
      for (let type = 0; type < 12; type++) {
        js.param('type', type); native.param('type', type);
        const input = [stereo()];
        for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) input[0][c][i] = Math.sin((i + type * N) * 0.137 + c);
        const a = [stereo()], b = [stereo()];
        assert.equal(native.process(input, b), js.process(input, a));
        for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) {
          assert.ok(Math.abs(a[0][c][i] - b[0][c][i]) < 1e-6, `${sr} Hz, type ${type}, ${bits} bits: native parity`);
        }
      }
      native.destroy();
    }
  } finally {
    globalThis.sampleRate = 48000;
  }
}
{
  const { dsp, graph, render } = dspTestHost({ kernels: WASM, heap });
  const osc = dsp.create('osc'), fx = dsp.create('distortion');
  osc.connect(fx); fx.connect(dsp.destination);
  fx.param('type', 8); fx.param('power', 8); fx.param('frequency', 10000);
  osc.send(noteOn(1, 60));
  const { L } = render(10);
  assert.ok(graph.prog, 'DISTORTION keeps the complete audio graph native');
  assert.ok(L.some((v) => Math.abs(v) > 0.01));
  dsp.panic();
  assert.ok(render().L.every((v) => v === 0), 'native panic clears the distortion hold');
  osc.destroy(); fx.destroy();
}

// VIBRATO: both waveforms, phase, BPM sync, live edits (waveform switch glide), gaps and panic.
for (const wave of [0, 1]) {
  compare('vibrato', {
    input: signal,
    gaps: (b) => b >= 120 && b < 130,
    blocks: 400,
    inHeap: wave === 1,
    script: [
      [0, param('wave', wave)], [0, param('phase', 0.3)], [0, param('freq', 7)], [0, param('amp', 80)],
      [20, param('amp', 200)], [40, param('wave', 1 - wave)], [60, param('unit', 2)], [60, { type: 'bpm', value: 140 }],
      [90, param('unit', 0)], [90, param('freq', 0.05)], [150, param('phase', 0.9)], [200, 'panic'], [260, param('amp', 0)],
    ],
  });
}
compare('vibrato', { blocks: 4 });
{
  const { dsp, graph, render } = dspTestHost({ kernels: WASM, heap });
  const osc = dsp.create('osc'), fx = dsp.create('vibrato');
  osc.connect(fx); fx.connect(dsp.destination);
  fx.param('amp', 100);
  osc.send(noteOn(1, 60));
  const { L } = render(10);
  assert.ok(graph.prog, 'VIBRATO keeps the complete audio graph native');
  assert.ok(L.some((v) => Math.abs(v) > 0.01));
  osc.send({ type: 'allOff' });
  dsp.panic();
  assert.ok(render().L.every((v) => v === 0), 'native panic empties the vibrato delay line');
  osc.destroy(); fx.destroy();
}

// BUS, AMP, OUT: the small kernels of the native graph
compare('bus', { input: signal, blocks: 4 });
compare('bus', { blocks: 2 });
compare('amp', {
  input: signal, blocks: 40,
  script: [[0, param('amp', 2.5)], [5, param('pan', -0.4)], [10, param('inverse', 1)], [20, param('pan', 0.7)], [30, param('amp', 0.25)]],
});
compare('out', { input: signal, blocks: 30, script: [[0, param('volume', 0.5)], [10, param('volume', 0.9)], [20, param('bpm', 140)]] });
compare('out', { input: signal, blocks: 10 }); // no volume message yet: starts at the target
compare('dcblock', { input: (b, i, ch) => signal(b, i, ch) + 0.3, blocks: 60, tol: 1e-6 });
compare('dcblock', { blocks: 2 });
// silent input blocks in between (a source reporting silence): both twins ring out alike, then go silent
compare('dcblock', { input: (b, i, ch) => signal(b, i, ch) + 0.3, gaps: (b) => (b >= 20 && b < 24) || b >= 40, blocks: 200, tol: 1e-6 });
// EQ: band gains glide, Q change recomputes all, level glide, ring-out after the input stops
compare('eq', {
  input: (b, i, ch) => (b < 60 ? signal(b, i, ch) : 0), blocks: 120,
  script: [[0, param('b3', 9)], [0, param('b8', -12)], [5, param('b12', 6)], [15, param('q', 0.7)], [20, param('level', -6)], [30, param('b8', 0)], [40, param('b0', 12)]],
});
{ // input disconnected: rings out, then reports silence like the JS kernel
  let n = 0;
  compare('eq', { input: null, blocks: 3 });
  const js = new KERNELS.eq();
  js.message(param('b5', 12));
  js.process([[Float32Array.from({ length: N }, (_, i) => Math.sin(i))]], [stereo()]);
  while (js.process([[]], [stereo()]) !== false && n < 5000) n++;
  assert.ok(n > 0 && n < 5000, `EQ rings out for ${n} blocks, then is silent`);
  // the same in C++: identical samples and the same block where it turns silent
  const a = new KERNELS.eq(), w = new WASM.eq();
  for (const k of [a, w]) { k.message(param('b2', 12)); k.message(param('q', 6)); }
  let worst = 0, endA = -1, endW = -1;
  for (let b = 0; b < 4000 && (endA < 0 || endW < 0); b++) {
    const ins = b < 20 ? [[Float32Array.from({ length: N }, (_, i) => signal(b, i, 0)), Float32Array.from({ length: N }, (_, i) => signal(b, i, 1))]] : [[]];
    const oa = [stereo()], ow = [stereo()];
    const ra = endA < 0 ? a.process(ins, oa) !== false : false;
    const rw = endW < 0 ? w.process(ins, ow) !== false : false;
    if (!ra && endA < 0) endA = b;
    if (!rw && endW < 0) endW = b;
    if (ra && rw) for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(oa[0][c][i] - ow[0][c][i]));
  }
  assert.ok(endA > 20, 'rings out after the input stops');
  assert.equal(endW, endA, 'C++ turns silent at the same block');
  assert.ok(worst < 1e-5, `ring-out parity ${worst}`);
}

// FILTER random LFO shapes use a different random source: only check they stay sane
{
  const f = new WASM.filter();
  f.message(param('lfoShape', 5));
  f.message(param('lfoDepth', 2));
  f.message(param('lfoRate', 30));
  const out = [stereo()];
  let peak = 0;
  for (let b = 0; b < 200; b++) {
    const [L, R] = stereo();
    for (let i = 0; i < N; i++) L[i] = R[i] = signal(b, i, 0);
    f.process([[L, R]], out);
    for (const v of out[0][0]) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
  }
  assert.ok(peak > 0.01 && peak < 10, `random LFO output is sane (${peak})`);
  f.destroy();
}

// PANIC: every audio kernel drops its sounding state at once (both twins alike): echo / reverb tails,
// delay lines, voices and filter memory are gone, the next input starts from scratch
{
  const burst = (b, i, ch) => (b < 15 || b >= 40) ? 0.5 * Math.sin((b * N + i) * (ch ? 0.13 : 0.1)) : 0;
  const cases = {
    delay: [[0, param('left', 20)], [0, param('right', 25)]],
    echo: [[0, param('delay', 30)], [0, param('feedback', 0.95)], [0, param('filter', 3)]],
    reverb: [[0, param('size', 0.9)]],
    filter: [[0, param('resonance', 0.9)]],
    eq: [],
    dcblock: [],
    waveshaper: [],
    modulator: [[0, param('type', 1)]],
    osc: [[0, param('release', 2)], [0, noteOn(1, 60)], [10, { type: 'noteOff', id: 1 }]],
  };
  for (const [kind, script] of Object.entries(cases)) {
    const input = kind === 'osc' ? null : burst;
    compare(kind, { blocks: 60, input, script: [...script, [20, 'panic']] });
    const k = new KERNELS[kind]();
    for (let b = 0; b < 40; b++) {
      if (b === 20) k.panic();
      const out = [stereo()];
      let ins = [[]];
      if (input) {
        const [L, R] = stereo();
        for (let i = 0; i < N; i++) { L[i] = input(b, i, 0); R[i] = input(b, i, 1); }
        ins = [[L, R]];
      }
      for (const [w, m] of script) if (w === b) k.message(m);
      const sounding = k.process(ins, out) !== false && out[0].some((ch) => ch.some((v) => Math.abs(v) > 1e-9));
      if (b === 18 && ['delay', 'echo', 'reverb', 'osc'].includes(kind)) assert.ok(sounding, `${kind}: still sounding before the panic`);
      if (b >= 20) assert.ok(!sounding, `${kind}: silent after the panic (block ${b})`);
    }
  }
}

// ---- in the graph: buffers in the heap, same audio as the JS graph ----
function patchUp(dsp) {
  const o = dsp.create('osc');
  const f = dsp.create('filter');
  const w = dsp.create('waveshaper');
  const r = dsp.create('reverb');
  const amp = dsp.create('amp');
  o.connect(f); f.connect(w); w.connect(r); r.connect(amp); amp.connect(dsp.destination);
  o.connect(dsp.destination); // two sources into the master: summed in heap buffers
  o.param('wave', 3);
  f.param('cutoff', 1200);
  f.param('resonance', 0.6);
  w.param('drive', 6);
  r.param('mix', 0.5);
  o.send(noteOn(1, 57));
  o.send(noteOn(2, 64));
  return { o, f, w, r };
}
{
  const J = dspTestHost();
  const W = dspTestHost({ heap, kernels: WASM });
  const jn = patchUp(J.dsp);
  const nodes = patchUp(W.dsp);
  W.render(0); // nothing rendered yet: the views were made before the reverb grew the memory
  W.graph.render(new Float32Array(128), new Float32Array(128));
  J.graph.render(new Float32Array(128), new Float32Array(128));
  assert.ok(W.graph.nodes.get(nodes.o.h).outs[0][0].buffer === x.memory.buffer, 'node buffers live in wasm memory');
  let worst = 0;
  const growAt = 50;
  const extra = [];
  for (let b = 0; b < 300; b++) {
    if (b === 120) for (const o of [jn.o, nodes.o]) o.send({ type: 'noteOff', id: 1 });
    if (b === growAt) {
      // allocate enough reverbs (≈1 MB each) to grow the memory: the graph must remap its views
      const before = x.memory.buffer.byteLength;
      for (let i = 0; i < 40; i++) extra.push(W.dsp.create('reverb'));
      assert.ok(x.memory.buffer.byteLength > before, 'memory grew');
    }
    const j = J.render();
    const w = W.render();
    let d = 0;
    for (let i = 0; i < N; i++) d = Math.max(d, Math.abs(j.L[i] - w.L[i]), Math.abs(j.R[i] - w.R[i]));
    if (d > 1e-4 && worst <= 1e-4) console.log('first difference at block', b, d);
    worst = Math.max(worst, d);
  }
  assert.ok(worst < 1e-4, `graph output matches the JS engine (max diff ${worst})`);
  assert.ok(W.graph.nodes.get(nodes.o.h).outs[0][0].length === 128, 'views remapped after growth');
  // deleting nodes frees their kernels and buffers: create/delete cycles don't grow the memory
  extra.forEach((n) => n.destroy());
  W.render();
  const size = x.memory.buffer.byteLength;
  for (let round = 0; round < 5; round++) {
    const many = Array.from({ length: 40 }, () => W.dsp.create('reverb'));
    W.render();
    many.forEach((n) => n.destroy());
    W.render();
  }
  assert.equal(x.memory.buffer.byteLength, size, 'freed memory is reused');
}

// ---- native graph runner (ms_run): same audio as the per-node path, mode switches keep state ----
{
  class JsOnly extends KERNELS.bus {} // a JS kernel: a graph containing it can't run natively
  const opts = { heap, kernels: { ...WASM, jsonly: JsOnly } };
  const A = dspTestHost(opts); // native whenever possible
  const B = dspTestHost({ ...opts, native: false }); // per-node calls from JS
  const build = (dsp) => {
    const o1 = dsp.create('osc');
    const o2 = dsp.create('osc');
    const f = dsp.create('filter');
    const a = dsp.create('amp');
    const out = dsp.create('out');
    const lfo = dsp.create('lfo'); // modulator: JS, outside the render order
    o1.connect(f); o2.connect(f); // two sources: summed
    f.connect(a); o2.connect(a); a.connect(out); out.connect(dsp.destination);
    lfo.connect(f);
    lfo.routes([{ to: f.h, id: 'cutoff', min: 20, max: 20000, scale: 'log', step: 1 }]);
    lfo.param('rate', 4);
    out.param('volume', 0.7);
    o1.send(noteOn(1, 50)); o2.send(noteOn(1, 57));
    return { o1, o2, f, a, out, lfo };
  };
  const na = build(A.dsp);
  const nb = build(B.dsp);
  // cable scope: the native runner's silent flags give the same stream as the per-node path
  const sa = [], sb = [];
  A.dsp.onScope = (s) => sa.push(...s.v);
  B.dsp.onScope = (s) => sb.push(...s.v);
  A.dsp.scope([na.o1.h, na.f.h, na.a.h, na.lfo.h]);
  B.dsp.scope([nb.o1.h, nb.f.h, nb.a.h, nb.lfo.h]);
  let extraA = null, extraB = null;
  let worst = 0;
  const native = [];
  const peak = [];
  for (let b = 0; b < 400; b++) {
    if (b === 100) { // a JS kernel joins: per-node path, silent flags carried over
      extraA = A.dsp.create('jsonly'); na.o1.connect(extraA); extraA.connect(A.dsp.destination);
      extraB = B.dsp.create('jsonly'); nb.o1.connect(extraB); extraB.connect(B.dsp.destination);
    }
    if (b === 200) { extraA.destroy(); extraB.destroy(); } // native again
    if (b === 250) { na.o1.send({ type: 'noteOff', id: 1 }); nb.o1.send({ type: 'noteOff', id: 1 }); }
    if (b === 260) { na.o2.send({ type: 'allOff' }); nb.o2.send({ type: 'allOff' }); }
    if (b === 300) { na.a.disconnect(na.out); nb.a.disconnect(nb.out); }
    if (b === 320) { na.a.connect(na.out); nb.a.connect(nb.out); na.o2.send(noteOn(2, 60)); nb.o2.send(noteOn(2, 60)); }
    const ra = A.render();
    const ja = Float32Array.from(ra.L);
    const jr = Float32Array.from(ra.R);
    const rb = B.render();
    native.push(!!A.graph.prog);
    peak.push(ja.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(ja[i] - rb.L[i]), Math.abs(jr[i] - rb.R[i]));
  }
  assert.equal(worst, 0, 'the native runner renders exactly what the per-node path renders');
  assert.ok(sa.length > 400 && sa.some((v) => v !== 0), 'scope points were reported');
  assert.deepEqual(sa, sb, 'scope stream is the same in native and per-node mode');
  assert.ok(native[50] && !native[150] && native[250], 'native only while every audio node is C++');
  assert.ok(!B.graph.prog, 'native: false keeps the per-node path');
  assert.ok(peak[50] > 0.01 && peak[150] > 0.01 && peak[240] > 0.01 && peak[350] > 0.01, 'there was sound to compare');
  assert.ok(peak[310] === 0, 'a disconnected chain leaves the master silent');
}

// ---- speed: the same patch rendered by the JS and the C++ kernels ----
function bench(opts) {
  const { dsp, render } = dspTestHost(opts);
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
    for (let v = 0; v < 4; v++) o.send(noteOn(100 + v, 48 + v * 7, 0.5));
  }
  const r = dsp.create('reverb');
  const src = dsp.create('osc');
  src.connect(r); r.connect(dsp.destination);
  src.send(noteOn(1, 60));
  render(100); // warm up (JIT)
  const t0 = performance.now();
  render(375); // 1 s
  return performance.now() - t0;
}
const msJs = bench();
const msWasm = bench({ heap, kernels: WASM });
console.log(`16 × (OSC 4 voices → FILTER 4-pole → WAVESHAPER 4×) + REVERB, 1 s of audio: JS ${msJs.toFixed(0)} ms, C++/wasm ${msWasm.toFixed(0)} ms (${(msJs / msWasm).toFixed(2)}×)`);
assert.ok(msWasm < 1000, 'wasm renders faster than real time');

console.log('wasm tests passed');
