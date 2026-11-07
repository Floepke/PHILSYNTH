// Run: node test/graph.test.mjs   (engine graph + main-thread host, src/dsp/)
import assert from 'node:assert/strict';
import { dspTestHost } from './dsphost.mjs';
import { DspHost } from '../src/dsp/host.js';
import { KERNELS } from '../src/dsp/kernels.js';
import { Kernel } from '../src/dsp/kernel.js';
import { SCOPE_QUIET, SCOPE_PTS, SCOPE_DECIM } from '../src/dsp/graph.js';

// test kernels: a constant source, a counter of process() calls
class Const extends Kernel {
  constructor({ v = 1 } = {}) { super(); this.v = v; this.on = true; this.calls = 0; }
  param(id, value) { this[id] = value; }
  process(_i, outputs) { this.calls++; if (!this.on) return false; outputs[0][0].fill(this.v); outputs[0][1].fill(-this.v); return true; }
}
class Probe extends Kernel {
  constructor() { super(); this.calls = 0; this.ins = null; this.set = []; }
  param(id, value) { this.set.push([id, value]); }
  process(inputs, outputs) { this.calls++; this.ins = inputs[0]; const i = inputs[0]; if (i.length) { outputs[0][0].set(i[0]); outputs[0][1].set(i[1]); } return i.length > 0; }
}
class Mod extends Kernel {
  static modulator = true;
  constructor() { super(); this.value = 0; }
}
const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
Object.assign(KERNELS, { const: Const, probe: Probe, mod: Mod });

// Output smoothing happens after trim/depth mapping, in each target controller's slider space.
for (const sr of [44100, 48000, 96000]) {
  const previousRate = sampleRate;
  globalThis.sampleRate = sr;
  try {
    const { dsp, graph, kernel, render } = dspTestHost();
    const mod = dsp.create('mod');
    const target = dsp.create('probe');
    const got = [];
    target.onMod = (id, value) => got.push([id, value]);
    target.param('linear', 0);
    target.param('log', 100);
    target.param('stepped', 0);
    mod.routes([
      { to: target.h, id: 'linear', min: 0, max: 100 },
      { to: target.h, id: 'log', min: 100, max: 10000, scale: 'log' },
      { to: target.h, id: 'stepped', min: 0, max: 10, step: 1 },
    ]);
    mod.param('outSmooth', 100);
    kernel(mod).value = 1;
    const blocks = Math.round(sr * 0.1 / 128);
    render(blocks);
    const expected = 1 - Math.exp(-blocks * 128 / (sr * 0.1));
    const values = () => Object.fromEntries(kernel(target).set);
    near(values().linear, expected * 100, 1e-6);
    near(values().log, 100 * 100 ** expected, 1e-6);
    assert.equal(values().stepped, Math.round(expected * 10));
    assert.deepEqual(got.at(-1), kernel(target).set.at(-1), 'reports contain applied smoothed values');
    kernel(mod).value = 0;
    render();
    const alpha = 1 - Math.exp(-128 / (sr * 0.1));
    near(values().linear, expected * 100 * (1 - alpha), 1e-6);
    // A clamped stepped output must not stall the underlying smoother.
    render(blocks * 25);
    assert.equal(values().stepped, 0);
    mod.param('outMin', 100);
    render();
    assert.ok(values().linear < 10, 'trim changes are smoothed too');
    mod.param('outSmooth', 0);
    render();
    assert.equal(values().linear, 100, 'turning smoothing off immediately applies the mapped target');
    mod.param('outMin', 0);
    mod.param('outMax', 0);
    kernel(mod).value = 1;
    render();
    assert.equal(values().linear, 0, 'zero smoothing preserves instantaneous mapping');
    // Another modulator can drive smoothing without going through the main-thread UI.
    const depth = dsp.create('mod');
    depth.routes([{ to: mod.h, id: 'outSmooth', min: 0, max: 5000 }]);
    kernel(depth).value = 0.02;
    render(2);
    assert.equal(graph.nodes.get(mod.h).depth.outSmooth, 100);
    mod.param('outMax', 100);
    render();
    assert.ok(values().linear > 0 && values().linear < 10, 'modulated smoothing is live');
  } finally {
    globalThis.sampleRate = previousRate;
  }
}

// A note-only source's first output glides from the controller's saved value, not from zero.
{
  const { dsp, kernel, render } = dspTestHost();
  const mod = dsp.create('velocity2ctl');
  const target = dsp.create('probe');
  target.param('x', 80);
  mod.param('outSmooth', 100);
  mod.routes([{ to: target.h, id: 'x', min: 0, max: 100 }]);
  render(4);
  assert.deepEqual(kernel(target).set, [['x', 80]], 'null source does not drive the controller');
  mod.send({ type: 'noteOn', id: 1, velocity: 0 });
  render();
  assert.ok(kernel(target).set.at(-1)[1] < 80 && kernel(target).set.at(-1)[1] > 75);
  const other = dsp.create('probe');
  other.param('x', 20);
  mod.routes([{ to: target.h, id: 'x', min: 0, max: 100 }, { to: other.h, id: 'x', min: 0, max: 100 }]);
  render();
  assert.ok(kernel(target).set.at(-1)[1] > 70, 'route rebuild continues from current output');
  assert.ok(kernel(other).set.at(-1)[1] < 20 && kernel(other).set.at(-1)[1] > 18, 'new routes have independent starting values');
}

// Audio-to-control renders otherwise inaudible sources, without leaking their sound.
{
  class Voltage extends Kernel {
    constructor() { super(); this.left = 1; this.right = 1; this.on = true; this.calls = 0; }
    process(_ins, outs) {
      this.calls++;
      if (!this.on) return false;
      outs[0][0].fill(this.left);
      outs[0][1].fill(this.right);
      return true;
    }
  }
  const { dsp, graph, kernel, render } = dspTestHost({ kernels: { voltage: Voltage } });
  const src = dsp.create('voltage');
  const ctl = dsp.create('sound2ctl');
  const target = dsp.create('probe');
  src.connect(ctl);
  ctl.routes([{ to: target.h, id: 'x', min: 0, max: 100 }]);
  let out = render();
  assert.equal(kernel(target).set.at(-1)[1], 100);
  assert.ok(out.L.every((v) => v === 0), 'control routes do not leak audio');
  assert.deepEqual(graph.order.map((n) => n.h), [0, src.h, ctl.h]);
  kernel(src).left = kernel(src).right = -1;
  render();
  assert.equal(kernel(target).set.at(-1)[1], 0);
  kernel(src).left = 1; kernel(src).right = -1;
  render();
  assert.equal(kernel(target).set.at(-1)[1], 50, 'stereo voltage is averaged');
  kernel(src).left = kernel(src).right = 4;
  ctl.param('outMin', 20); ctl.param('outMax', 80);
  render();
  assert.equal(kernel(target).set.at(-1)[1], 80, 'clamped positive voltage');
  kernel(src).left = kernel(src).right = -4;
  render();
  assert.equal(kernel(target).set.at(-1)[1], 20, 'clamped negative voltage');
  ctl.param('outMin', 80); ctl.param('outMax', 20);
  render();
  assert.equal(kernel(target).set.at(-1)[1], 80, 'inverted trim range');
  kernel(src).on = false;
  render();
  assert.equal(kernel(target).set.at(-1)[1], 50, 'silence is zero voltage, not held stale audio');
  src.disconnect(ctl);
  render();
  assert.equal(kernel(ctl).value, 0.5, 'disconnected input stays at zero voltage');
  src.connect(ctl);
  ctl.routes([]);
  const calls = kernel(src).calls;
  render();
  assert.equal(kernel(src).calls, calls, 'unrouted control-only sources no longer render');
}

const { dsp, graph, render, kernel } = dspTestHost();
const k = kernel;

// ---- order, passthrough, summing, reachability ----
const a = dsp.create('const', { v: 0.25 });
const b = dsp.create('const', { v: 0.5 });
const p = dsp.create('probe');
const lone = dsp.create('probe'); // not connected to the master: never rendered
a.connect(p);
p.connect(dsp.destination);
let { L, R } = render();
assert.equal(L[5], 0.25); assert.equal(R[5], -0.25);
assert.equal(k(p).ins, graph.nodes.get(a.h).outs[0], 'a single input is passed through without copying');
assert.equal(k(lone).calls, 0, 'nodes that do not reach the output are not rendered');
b.connect(p);
({ L } = render());
assert.equal(L[0], 0.75, 'several inputs are summed');
assert.deepEqual(graph.order.map((n) => n.h), [a.h, b.h, p.h, 0], 'sources first');

// silent sources are skipped, passive nodes with silent inputs are not rendered at all
k(a).on = false; k(b).on = false;
({ L } = render()); // this block a/b return false
({ L } = render());
assert.equal(k(p).ins.length, 0, 'no live input: the kernel gets an empty input');
assert.ok(L.every((v) => v === 0), 'silent master');
const bus = dsp.create('bus');
p.disconnect(dsp.destination);
p.connect(bus);
bus.connect(dsp.destination);
render(2);
assert.equal(graph.nodes.get(bus.h).silent, true, 'passive bus with a silent input is skipped');
k(a).on = true;
({ L } = render());
assert.equal(L[3], 0.25, 'and runs again as soon as its input is live');

// ---- removal ----
p.destroy();
({ L } = render());
assert.ok(L.every((v) => v === 0), 'destroying a node drops its edges');
assert.ok(!graph.nodes.has(p.h));
assert.ok(!dsp.nodes.has(p.h));
p.destroy(); // twice is harmless

// ---- modulation routes (mapping, reports, invalidation, removal) ----
const m = dsp.create('mod');
const t = dsp.create('probe');
const t2 = dsp.create('probe');
const got = [];
t.onMod = (id, v) => got.push([id, v]);
m.routes([{ to: t.h, id: 'x', min: 0, max: 10, step: 1 }, { to: t2.h, id: 'f', min: 20, max: 20000, scale: 'log' }]);
k(m).value = 0.5;
render(1);
assert.deepEqual(k(t).set.at(-1), ['x', 5], 'linear stepped mapping');
assert.ok(Math.abs(k(t2).set.at(-1)[1] - 632.4555) < 1e-3, 'log mapping');
assert.deepEqual(got, [['x', 5]], 'reported to the main thread');
render(3);
assert.equal(k(t).set.length, 1, 'unchanged values are not applied again');
assert.equal(got.length, 1, 'nor reported again');
m.param('outMin', 20); m.param('outMax', 60); m.param('amp', 50);
k(m).value = 1;
render(1);
assert.deepEqual(k(t).set.at(-1), ['x', 5], 'Amplitude 50 %: top = 75 % of Out Min..Out Max = 50 %');
t.param('x', 9); // hand change while modulated
assert.deepEqual(k(t).set.at(-1), ['x', 9]);
render(1);
assert.deepEqual(k(t).set.at(-1), ['x', 5], 'modulation re-applied on the next block');
// a modulator driving another modulator's depth
const m2 = dsp.create('mod');
m2.routes([{ to: m.h, id: 'outMax', min: 0, max: 100, step: 1 }]);
k(m2).value = 1;
render(2); // modulators run in creation order: m picks up the new depth one block later
assert.equal(graph.nodes.get(m.h).depth.outMax, 100, 'LFO -> LFO Out Max changes its mapping');
assert.deepEqual(k(t).set.at(-1), ['x', 8], '20 + 75 % of 20..100 = 80 % of 0..10');
m2.destroy();
t2.destroy();
render(1);
assert.deepEqual(graph.nodes.get(m.h).routes.map((r) => r.id), ['x'], 'routes to a removed node are dropped');
k(m).value = null;
const n = k(t).set.length;
render(2);
assert.equal(k(t).set.length, n, 'value null = no modulation');

// ENVELOPE drives its target before any MIDI trigger, including externally modulated trim.
{
  const { dsp, graph, kernel, render } = dspTestHost();
  const env = dsp.create('envelope');
  const trim = dsp.create('mod');
  const target = dsp.create('probe');
  const got = [];
  target.onMod = (id, value) => got.push([id, value]);
  env.routes([{ to: target.h, id: 'x', min: 0, max: 100 }]);
  env.param('outMin', 20);
  env.param('outMax', 80);
  trim.routes([{ to: env.h, id: 'outMin', min: 0, max: 100 }]);
  kernel(trim).value = 0.3;
  render(2);
  assert.deepEqual(kernel(target).set.at(-1), ['x', 30], 'idle start follows modulated Out Min');
  assert.deepEqual(got.at(-1), ['x', 30], 'idle modulation is reported to the controller UI');
  kernel(trim).value = 0.4;
  render(2);
  assert.deepEqual(kernel(target).set.at(-1), ['x', 40], 'trim keeps updating without a note');
  // idle in Note ON Trigger mode = the curve's end (as after a finished note)
  env.send({ type: 'curve', curve: { points: [{ x: 0, y: 1, r: 0 }, { x: 1, y: 0.25, r: 0 }] } });
  render();
  assert.deepEqual(kernel(target).set.at(-1), ['x', 50], 'loaded nonzero idle value maps between both trims');
  trim.routes([{ to: env.h, id: 'outMax', min: 0, max: 100 }]);
  kernel(trim).value = 1;
  render(2);
  assert.deepEqual(kernel(target).set.at(-1), ['x', 55], 'idle output also follows modulated Out Max');
  env.send({ type: 'noteOn', id: 1, phase: 0.5 });
  render();
  assert.ok(kernel(target).set.at(-1)[1] > 55, 'note triggers still advance the curve');
  graph.panic();
  render(2);
  assert.deepEqual(kernel(target).set.at(-1), ['x', 55], 'panic resumes idle mapping instead of disabling routes');
  assert.equal(kernel(env).meter, -1);
}

// ---- reports and the clock ----
assert.equal(graph.report(1), null, 'nothing to report');
const ticks = [];
const off = dsp.onClock((time) => ticks.push(time));
render(2);
assert.equal(ticks.length, 2, 'clock reports the audio time while subscribed');
off();
render(2);
assert.equal(ticks.length, 2);

// ---- the host batches messages per microtask (one postMessage per task) ----
{
  const posts = [];
  const h = new DspHost({ postMessage: (q) => posts.push(q) });
  const x = h.create('osc');
  x.param('gain', 0.1);
  x.connect(h.destination);
  assert.equal(posts.length, 0, 'queued');
  await Promise.resolve();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], [['add', 1, 'osc', null], ['msg', 1, { type: 'param', id: 'gain', value: 0.1 }], ['con', 1, 0]]);
  let err = null;
  h.onError = (e) => (err = e);
  h.receive({ error: 'boom' });
  assert.equal(err, 'boom');
}
assert.throws(() => graph.handle([['add', 999, 'nope']]), /Unknown DSP kernel/);

// ---- whole engine: OSC -> FILTER -> master, through real kernels ----
{
  const osc = dsp.create('osc');
  const flt = dsp.create('filter');
  osc.connect(flt);
  flt.connect(dsp.destination);
  osc.send({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  let peak = 0;
  for (let i = 0; i < 20; i++) ({ L } = render(1)), (peak = Math.max(peak, ...L.map(Math.abs)));
  assert.ok(peak > 0.01, `sound reaches the output (${peak})`);
  osc.send({ type: 'allOff' });
  let silentAt = -1;
  for (let i = 0; i < 400 && silentAt < 0; i++) { render(1); if (graph.nodes.get(flt.h).silent) silentAt = i; }
  assert.ok(silentAt >= 0, 'after the notes end the filter rings out and goes silent');
}

// ---- performance smoke test: 64 voices worth of modules render well within real time ----
{
  const nodes = [];
  for (let i = 0; i < 16; i++) {
    const o = dsp.create('osc');
    o.param('polyphony', 4);
    const f = dsp.create('filter');
    o.connect(f);
    f.connect(dsp.destination);
    for (let v = 0; v < 4; v++) o.send({ type: 'noteOn', id: 100 + v, pitch: 48 + v * 7, velocity: 0.5 });
    nodes.push(o, f);
  }
  const blocks = 375; // 1 s at 48 kHz
  const t0 = performance.now();
  render(blocks);
  const ms = performance.now() - t0;
  console.log(`16 OSC (4 voices) + 16 FILTER: 1 s of audio in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, 'faster than real time');
  nodes.forEach((x) => x.destroy());
}

// ---- cable scope: waveform stream per watched node (means of SCOPE_DECIM samples), batched into the reports ----
{
  const T = dspTestHost();
  const src = T.dsp.create('const', { v: 0.5 });
  const m = T.dsp.create('mod');
  src.connect(T.dsp.destination);
  const got = [];
  T.dsp.onScope = (s) => got.push(s);
  T.render(4);
  assert.equal(got.length, 0, 'nothing is reported while no node is watched');
  T.dsp.scope([src.h, m.h, 9999]); // 9999: a node that does not exist
  T.graph.nodes.get(m.h).k.value = 0.25;
  T.render(1);
  assert.equal(got.length, 1, 'one message per report');
  assert.equal(got[0].n, SCOPE_PTS, 'SCOPE_PTS points per quantum');
  assert.equal(SCOPE_PTS * SCOPE_DECIM, 128);
  for (let p = 0; p < SCOPE_PTS; p++) {
    assert.deepEqual([...got[0].v.slice(p * 3, p * 3 + 3)], [0, 0.25, 0], '(L+R)/2 of +v/-v is 0; modulator value; missing node 0');
  }
  const lfo = T.dsp.create('lfo');
  T.graph.nodes.get(src.h).k.process = function (_i, o) {
    for (let j = 0; j < 128; j++) { o[0][0][j] = j / 128; o[0][1][j] = 0.1; }
    o[0][0][7] = -0.8;
    return this.on;
  };
  T.dsp.scope([src.h, lfo.h]);
  got.length = 0;
  T.render(2);
  assert.equal(got.length, 2);
  const v = got[1].v;
  // point 1 = samples 4..7: mean of (L+R)/2
  near(v[1 * 2], (((4 + 5 + 6) / 128 - 0.8) + 4 * 0.1) / 8, 1e-6);
  near(v[10 * 2], ((40 + 41 + 42 + 43) / 128 + 4 * 0.1) / 8, 1e-6, 'the waveform, not a peak');
  const lv = T.graph.nodes.get(lfo.h).k.value;
  near(v[3], 2 * lv - 1, 1e-6); // LFO shown bipolar
  // silence: zeros keep coming until SCOPE_QUIET points in a row, then nothing
  T.graph.nodes.get(src.h).k.on = false;
  lfo.destroy();
  got.length = 0;
  T.render(SCOPE_QUIET / SCOPE_PTS + 40);
  const pts = got.reduce((n, s) => n + s.n, 0);
  assert.ok(pts >= SCOPE_QUIET && pts <= SCOPE_QUIET + 2 * SCOPE_PTS, `zeros flush the cables, then stop (${pts})`);
  assert.ok(got.every((s) => s.v.every((x) => x === 0)));
  got.length = 0;
  T.graph.nodes.get(src.h).k.on = true;
  T.render(1);
  assert.ok(got.length && got.at(-1).v[20] !== 0, 'and start again with the sound');
  // nobody reads (offline): the buffer never overflows
  for (let i = 0; i < 100; i++) T.graph.render(new Float32Array(128), new Float32Array(128));
  assert.ok(T.graph.scopeN <= T.graph.scopeBuf.length / T.graph.scopeH.length);
  T.dsp.scope([]);
  got.length = 0;
  T.render(8);
  assert.equal(got.length, 0, 'unwatched: no scope data');
}

// ---- cable scope: out-of-bounds flag from the raw samples, cleared after each report ----
{
  const T = dspTestHost();
  const a = T.dsp.create('const', { v: 0.5 });
  const b = T.dsp.create('const', { v: 0.5 });
  a.connect(T.dsp.destination);
  b.connect(T.dsp.destination);
  const got = [];
  T.dsp.onScope = (s) => got.push(s);
  T.dsp.scope([a.h, b.h]);
  let spike = 1.2;
  T.graph.nodes.get(a.h).k.process = (_i, o) => { o[0][0].fill(0.5); o[0][1].fill(0.5); o[0][1][9] = spike; o[0][0][10] = -0.6; return true; };
  T.graph.nodes.get(b.h).k.process = (_i, o) => { o[0][0].fill(1); o[0][1].fill(-1); return true; };
  T.render(1);
  assert.deepEqual([...got[0].clip], [1, 0], 'one sample above +1 on one channel flags only that cable; exactly ±1 is in bounds');
  assert.ok(Math.abs(got[0].v[4]) < 1, 'the averaged waveform alone would hide the spike');
  spike = -1.01;
  T.render(1);
  assert.deepEqual([...got[1].clip], [1, 0], 'below -1 is flagged too');
  spike = 0.5;
  T.render(1);
  assert.deepEqual([...got[2].clip], [0, 0], 'cleared after the report');
}

// ---- cable scope at display rate: report(time, false) keeps the points for a later report ----
{
  const T = dspTestHost();
  const src = T.dsp.create('const', { v: 0.5 });
  src.connect(T.dsp.destination);
  const got = [];
  T.dsp.onScope = (s) => got.push(s);
  T.dsp.scope([src.h]);
  T.graph.nodes.get(src.h).k.process = function (_i, o) {
    o[0][0].fill(this.on ? 0.3 : 0); o[0][1].fill(this.on ? 0.3 : 0);
    return this.on;
  };
  T.graph.nodes.get(src.h).k.on = true;
  const step = (withScope) => {
    T.graph.render(new Float32Array(128), new Float32Array(128));
    const r = T.graph.report(0, withScope);
    if (r) T.dsp.receive(r);
  };
  for (let i = 0; i < 5; i++) step(false);
  assert.equal(got.length, 0, 'no scope without withScope');
  step(true);
  assert.equal(got.length, 1);
  assert.equal(got[0].n, 6 * SCOPE_PTS, 'the held points come in one batch');
  near(got[0].v[0], 0.3, 1e-6);
  // silence in batches of 6 quanta: zeros still flush the cables, then stop
  T.graph.nodes.get(src.h).k.on = false;
  got.length = 0;
  for (let i = 0; i < SCOPE_QUIET / SCOPE_PTS + 60; i++) step(i % 6 === 5);
  const pts = got.reduce((n, s) => n + s.n, 0);
  assert.ok(pts >= SCOPE_QUIET && pts <= SCOPE_QUIET + 6 * SCOPE_PTS, `zeros flush the cables, then stop (${pts})`);
  assert.ok(got.every((s) => s.v.every((x) => x === 0)));
}

console.log('graph tests passed');
