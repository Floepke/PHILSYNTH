import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dspTestHost } from './dsphost.mjs';
import ModulatorKernel from '../src/modules/modulator.dsp.js';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';
import { PatchRuntime, cableSignals } from '../src/patch.js';
import { paramsOf } from '../src/params.js';
import { getModule } from '../src/modules/index.js';

const bytes = readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url));
const native = wasmKernels(instantiateDsp(bytes), sampleRate);
const N = 128;
const stereo = (left = 0, right = left) => [new Float32Array(N).fill(left), new Float32Array(N).fill(right)];
const near = (a, b, label = '') => assert.ok(Math.abs(a - b) < 2e-6, `${label}: ${a} != ${b}`);
const pcm = (x) => Math.max(-32768, Math.min(32767, Math.trunc(x * 32768)));
const combine = [
  (c, m) => c * m, null, null, (c, m) => c + m, (c, m) => c - m,
  Math.min, Math.max, (c, m) => (pcm(c) & pcm(m)) / 32768, (c, m) => (pcm(c) ^ pcm(m)) / 32768,
  (c, m) => Math.abs(c) <= Math.abs(m) ? c : m,
  (c, m) => Math.abs(c) >= Math.abs(m) ? c : m,
];

for (const K of [ModulatorKernel, native.kernels.modulator]) {
  const k = new K();
  const out = [stereo()];
  for (let type = 0; type <= 10; type++) {
    if (!combine[type]) continue;
    k.param('type', type);
    for (const [c, m] of [[0.75, 0.25], [-0.75, 0.25], [-0.25, -0.75], [0.5, -0.5], [0, 0], [2, -3], [0.1, -0.3], [1, -1]]) {
      const ins = [stereo(c, -c), stereo(m, -m)];
      const live = k.process(ins, out);
      const expected = [0, 1].map((ch) => combine[type](ins[0][ch][0], ins[1][ch][0]));
      assert.equal(live, expected.some((v) => v !== 0));
      if (!live) continue; // silent kernel outputs are undefined
      for (let ch = 0; ch < 2; ch++) {
        for (const value of out[0][ch]) near(value, expected[ch], `type ${type}, channel ${ch}`);
      }
    }
  }
  k.param('type', 3);
  k.process([[new Float32Array(N).fill(0.25)], [new Float32Array(N).fill(0.5)]], out);
  assert.ok(out[0].every((ch) => ch.every((v) => v === 0.75)), 'mono inputs feed both stereo channels');
  const mono = [[new Float32Array(N)]];
  k.process([stereo(0.25, 0.5), stereo(0.5, -1)], mono);
  assert.ok(mono[0][0].every((v) => v === 0.75), 'mono output is not overwritten by right-channel processing');
  k.param('type', 0);
  assert.equal(k.process([stereo(1), []], out), false, 'AM without a modulator is silent');
  k.destroy?.();
}

// Impulses prove the exact delay range and tail handling, independently of backend parity.
for (const sr of [44100, 48000, 96000]) {
  globalThis.sampleRate = sr;
  const wa = wasmKernels(instantiateDsp(bytes), sr);
  for (const K of [ModulatorKernel, wa.kernels.modulator]) for (const type of [1, 2]) {
    for (const m of [-2, -1, 0, 1, 2]) for (const interpolation of [0, 1, 2]) {
      const k = new K();
      k.param('type', type);
      k.param('interpolation', interpolation);
      const delay = Math.round((type === 1 ? (Math.max(-1, Math.min(1, m)) + 1) * 0.5 : Math.min(1, Math.abs(m))) * sr * 0.04);
      const carrier = stereo(0);
      carrier[0][0] = 1;
      carrier[1][0] = -0.5;
      const mod = stereo(m);
      const out = [stereo()];
      const hits = [[], []];
      for (let at = 0; at < sr * 0.04 + 3 * N; at += N) {
        if (!k.process([at ? [] : carrier, mod], out)) continue;
        for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
          if (Math.abs(out[0][ch][i]) > 1e-6) hits[ch].push([at + i, out[0][ch][i]]);
        }
      }
      assert.deepEqual(hits, [[[delay, 1]], [[delay, -0.5]]], `${sr} Hz, type ${type}, mod ${m}, interpolation ${interpolation}`);
      k.destroy?.();
    }
  }
}
globalThis.sampleRate = 48000;

// Fractional interpolation, including the causal spline boundary and history wraparound.
for (const K of [ModulatorKernel, native.kernels.modulator]) {
  for (const interpolation of [0, 1, 2]) for (const requested of [0.5, 2.5]) {
    const k = new K();
    k.param('type', 2);
    k.param('interpolation', interpolation);
    const carrier = stereo();
    const mod = stereo(requested / (sampleRate * 0.04));
    const delay = mod[0][0] * sampleRate * 0.04;
    const out = [stereo()];
    for (let block = 0; block < 20; block++) {
      for (let i = 0; i < N; i++) carrier[0][i] = carrier[1][i] = (block * N + i) / 4096;
      k.process([carrier, mod], out);
      if (!block) continue;
      for (let i = 0; i < N; i++) near(out[0][0][i], (block * N + i - (interpolation === 0 ? Math.round(delay) : delay)) / 4096, 'interpolated ramp');
    }
    k.destroy?.();
  }
  // The cubic tap is not merely another linear interpolation option.
  const k = new K();
  k.param('type', 2);
  k.param('interpolation', 2);
  const mod = stereo(2.5 / (sampleRate * 0.04));
  const delay = mod[0][0] * sampleRate * 0.04;
  const input = stereo();
  for (let i = 0; i < N; i++) input[0][i] = input[1][i] = i * i / 16384;
  const out = [stereo()];
  k.process([input, mod], out);
  near(out[0][0][40], (40 - delay) ** 2 / 16384, 'spline reconstructs a quadratic');
  assert.ok(Math.abs(out[0][0][40] - ((38 ** 2 + 37 ** 2) / 2 / 16384)) > 1e-5, 'spline differs from linear');
  k.param('carrier', 1);
  assert.equal(k.carrier, 1);
  assert.equal(k.process([[], stereo(1)], out), false, 'changing carrier clears the old carrier history');
  k.destroy?.();
}

// Stress and sample parity with rapidly varying PM, multiple wraps, and live mode changes.
for (const interpolation of [0, 1, 2]) {
  const js = new ModulatorKernel();
  const wa = new native.kernels.modulator();
  for (const k of [js, wa]) k.param('interpolation', interpolation);
  const jo = [stereo()], wo = [stereo()];
  for (let block = 0; block < 200; block++) {
    for (const k of [js, wa]) k.param('type', Math.floor(block / 16) % 11);
    const ins = [stereo(), stereo()];
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
      ins[0][ch][i] = Math.sin((block * N + i) * (ch ? 0.113 : 0.073));
      ins[1][ch][i] = 1.4 * Math.cos((block * N + i) * (ch ? 0.17 : 0.29));
    }
    assert.equal(js.process(ins, jo), wa.process(ins, wo), 'same silent flags');
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
      assert.ok(Number.isFinite(wo[0][ch][i]));
      near(jo[0][ch][i], wo[0][ch][i], 'JS/WASM parity');
    }
  }
  wa.destroy();
}

// All render paths select the carrier BEFORE summing, retaining silent source positions.
for (const options of [{}, { ...native, native: false }, { ...native, kernels: { ...native.kernels, modulator: ModulatorKernel } }, native]) {
  const h = dspTestHost(options);
  const sources = [h.dsp.create('osc'), h.dsp.create('osc'), h.dsp.create('osc')];
  const effect = h.dsp.create('modulator');
  for (const [i, s] of sources.entries()) {
    s.param('wave', 2); // pulse
    s.param('attack', 0);
    s.param('gain', (i + 1) * 0.2);
    s.send({ type: 'noteOn', id: i + 1, pitch: 40 + i * 5, velocity: 1 });
    s.connect(effect);
  }
  effect.connect(h.dsp.destination);
  const control = h.dsp.create('multictl');
  control.routes([{ to: effect.h, id: 'carrier', min: 0, max: 2, step: 1 }]);
  effect.param('type', 4);
  for (const carrier of [0, 1, 2]) {
    control.param('value', carrier * 50);
    const { L } = h.render();
    assert.equal(h.kernel(effect).carrier, carrier, 'carrier is selectable by audio-thread controller modulation');
    assert.ok(h.graph.nodes.get(sources[0].h).outs[0][0].some((v) => v !== 0), 'sources actually render during controller modulation');
    for (let i = 0; i < N; i++) {
      const signals = sources.map((s) => h.graph.nodes.get(s.h).outs[0][0][i]);
      let mod = 0;
      for (let s = 0; s < 3; s++) if (s !== carrier) mod = Math.fround(mod + signals[s]);
      near(L[i], signals[carrier] - mod);
    }
  }
  control.destroy();
  for (const type of [0, 3, 4, 5, 6, 7, 8, 9, 10]) for (let carrier = 0; carrier < 3; carrier++) {
    effect.param('type', type);
    effect.param('carrier', carrier);
    const { L, R } = h.render();
    assert.equal(!!h.graph.prog, options === native, 'correct rendering path');
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < N; i++) {
      const signals = sources.map((s) => h.graph.nodes.get(s.h).outs[0][ch][i]);
      let mod = 0;
      for (let s = 0; s < 3; s++) if (s !== carrier) mod = Math.fround(mod + signals[s]);
      near((ch ? R : L)[i], combine[type](signals[carrier], mod), `graph type ${type}, carrier ${carrier}`);
    }
  }
  sources[1].send({ type: 'allOff' });
  effect.param('type', 0);
  effect.param('carrier', 1);
  h.render(500);
  assert.ok(h.render().L.every((v) => v === 0), 'silent selected carrier is not replaced by another live input');
  assert.equal(effect.inputs.size, 3);
  sources[0].disconnect(effect);
  assert.deepEqual([...effect.inputs], sources.slice(1), 'disconnect updates input order');
  sources[1].destroy();
  assert.deepEqual([...effect.inputs], [sources[2]], 'destroy removes incoming-source bookkeeping');
  effect.destroy();
  assert.equal(sources[2].out.size, 0, 'destroy removes outgoing bookkeeping on surviving sources');
  sources[0].destroy(); sources[2].destroy();
}

// Stateful PM is identical through the native graph program, including carrier changes.
for (const type of [1, 2]) for (const interpolation of [0, 1, 2]) {
  const graphs = [{}, native].map((options) => {
    const h = dspTestHost(options);
    const a = h.dsp.create('osc'), b = h.dsp.create('osc'), m = h.dsp.create('modulator');
    a.connect(m); b.connect(m); m.connect(h.dsp.destination);
    m.param('type', type); m.param('interpolation', interpolation);
    a.param('attack', 0); b.param('attack', 0);
    a.send({ type: 'noteOn', id: 1, pitch: 52, velocity: 1 });
    b.send({ type: 'noteOn', id: 2, pitch: 29, velocity: 1 });
    return { ...h, a, b, m };
  });
  for (let block = 0; block < 200; block++) {
    if (block === 30) for (const h of graphs) h.m.param('carrier', 1);
    if (block === 60) for (const h of graphs) h.a.send({ type: 'allOff' });
    if (block === 100) for (const h of graphs) h.b.send({ type: 'allOff' });
    const js = graphs[0].render(), wa = graphs[1].render();
    for (let i = 0; i < N; i++) {
      near(js.L[i], wa.L[i], 'PM graph left parity');
      near(js.R[i], wa.R[i], 'PM graph right parity');
    }
  }
  assert.ok(graphs[1].graph.prog);
  for (const h of graphs) { h.a.destroy(); h.b.destroy(); h.m.destroy(); }
}

// A non-audio node has no native record, but must not shift subsequent carrier indices.
{
  const h = dspTestHost(native);
  const silent = h.dsp.create('none'), osc = h.dsp.create('osc'), effect = h.dsp.create('modulator');
  silent.connect(effect); osc.connect(effect); effect.connect(h.dsp.destination);
  osc.send({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  effect.param('type', 4); effect.param('carrier', 1);
  const { L } = h.render();
  assert.ok(h.graph.prog);
  assert.deepEqual(L, h.graph.nodes.get(osc.h).outs[0][0], 'silent placeholder preserves the selected carrier');
  silent.destroy(); osc.destroy(); effect.destroy();
}

// UI ranges, audio cable classification, connection order, nested input buses and persistence.
{
  const h = dspTestHost();
  const engine = { ctx: {}, dsp: h.dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const root = await PatchRuntime.create(engine, h.dsp.destination);
  const a = await root.addModule('OSC');
  const b = await root.addModule('OSC');
  const m = await root.addModule('MODULATOR');
  assert.deepEqual(cableSignals(a.def, m.def), { audio: true, midi: false });
  assert.equal(paramsOf(m)[1].max, 0);
  root.connect(b.id, m.id); root.connect(a.id, m.id); root.connect(m.id, 0);
  assert.equal(paramsOf(m)[1].max, 1);
  assert.match(paramsOf(m)[1].format(0), new RegExp(`#${b.id} OSC`));
  assert.match(paramsOf(m)[1].format(1), new RegExp(`#${a.id} OSC`));
  root.setParam(m.id, 'carrier', 1);
  root.setParam(m.id, 'type', 2);
  root.setParam(m.id, 'interpolation', 2);
  const saved = JSON.parse(JSON.stringify(root.toJSON()));
  const restored = await PatchRuntime.create(engine, h.dsp.destination);
  await restored.load(saved);
  assert.deepEqual(restored.toJSON(), saved);
  const restoredM = restored.modules.get(m.id);
  assert.equal(h.kernel(restoredM.inst.node).carrier, 1);
  assert.match(paramsOf(restoredM)[1].format(1), new RegExp(`#${a.id} OSC`));
  const sub = await root.addModule('PATCH');
  const inner = await sub.inst.patch.addModule('MODULATOR');
  root.setParam(sub.id, 'inputModule', inner.id);
  assert.equal(inner.inst.node.inputs.size, 1);
  assert.match(paramsOf(inner)[1].format(0), /patch input/);
  root.removeModule(a.id);
  assert.match(paramsOf(m)[1].format(1), /not connected/);
  assert.equal(getModule('MODULATOR').params[0].options.length, 11);
  root.destroy(); restored.destroy();
}

console.log('modulator tests passed (JS, WASM, native graph, mixed graph, patch integration)');
