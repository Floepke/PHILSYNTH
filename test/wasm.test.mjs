// Run: node test/wasm.test.mjs   (C++ kernels in src/dsp/modsynth.wasm vs their JS twins)
// Rebuild the .wasm first after changing cpp/: npm run build:wasm
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
function compare(kind, { opts = {}, script = [], input = null, blocks = 200, tol = 1e-5, inHeap = false }) {
  const js = new KERNELS[kind](opts);
  const wa = new WASM[kind](opts);
  let worst = 0;
  let at = -1;
  const outW = inHeap ? [[heap.f32(heap.alloc(N * 4), N), heap.f32(heap.alloc(N * 4), N)]] : [stereo()];
  for (let b = 0; b < blocks; b++) {
    for (const [when, m] of script) if (when === b) {
      if (m === 'panic') { js.panic(); wa.panic(); } else { js.message(m); wa.message(m); }
    }
    let ins = [[]];
    if (input) {
      const [L, R] = stereo();
      for (let i = 0; i < N; i++) { L[i] = input(b, i, 0); R[i] = input(b, i, 1); }
      ins = [[L, R]];
    }
    const outJ = [stereo()];
    const rj = js.process(ins, outJ) !== false;
    const rw = wa.process(ins, outW) !== false;
    assert.equal(rw, rj, `${kind}: same silent flag at block ${b}`);
    if (!rj) continue; // silent outputs are undefined
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < N; i++) {
        const d = Math.abs(outJ[0][c][i] - outW[0][c][i]);
        assert.ok(Number.isFinite(outW[0][c][i]), `${kind}: finite output`);
        if (d > worst) { worst = d; at = b; }
      }
    }
  }
  wa.destroy();
  assert.ok(worst <= tol, `${kind} ${JSON.stringify(script.slice(0, 3))}: differs by ${worst} at block ${at}`);
  return worst;
}
const param = (id, value) => ({ type: 'param', id, value });
const noteOn = (id, pitch, velocity = 0.8, phase) => ({ type: 'noteOn', id, pitch, velocity, ...(phase === undefined ? {} : { phase }) });

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
