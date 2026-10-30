// Run: node test/graph.test.mjs   (engine graph + main-thread host, src/dsp/)
import assert from 'node:assert/strict';
import { dspTestHost } from './dsphost.mjs';
import { DspHost } from '../src/dsp/host.js';
import { KERNELS } from '../src/dsp/kernels.js';
import { Kernel } from '../src/dsp/kernel.js';
import { SCOPE_QUIET } from '../src/dsp/graph.js';

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

// ---- cable scope: signed peaks per watched node, batched into the reports ----
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
  T.render(4);
  assert.equal(got.length, 1, 'two points (4 blocks) per message');
  assert.equal(got[0].n, 2);
  assert.deepEqual([...got[0].v], [0, 0.25, 0, 0, 0.25, 0], '(L+R)/2 of +v/-v is 0; modulator value; missing node 0');
  const lfo = T.dsp.create('lfo');
  T.graph.nodes.get(src.h).k.v = 0.5;
  T.graph.nodes.get(src.h).k.process = function (_i, o) { o[0][0].fill(0.1); o[0][0][7] = -0.8; o[0][1].fill(0.1); return this.on; };
  T.dsp.scope([src.h, lfo.h]);
  got.length = 0;
  T.render(4);
  assert.equal(got.length, 1);
  near(got[0].v[2], -0.35, 1e-6); // biggest magnitude sample, sign kept: (-0.8 + 0.1) / 2
  const lv = T.graph.nodes.get(lfo.h).k.value;
  near(got[0].v[3], 2 * lv - 1, 1e-6); // LFO shown bipolar
  // silence: zeros keep coming until SCOPE_QUIET points in a row, then nothing
  T.graph.nodes.get(src.h).k.on = false;
  lfo.destroy();
  got.length = 0;
  T.render(2 * (SCOPE_QUIET + 40));
  const pts = got.reduce((n, s) => n + s.n, 0);
  assert.ok(pts >= SCOPE_QUIET && pts <= SCOPE_QUIET + 4, `zeros flush the cables, then stop (${pts})`);
  assert.ok(got.every((s) => s.v.every((v) => v === 0)));
  got.length = 0;
  T.graph.nodes.get(src.h).k.on = true;
  T.render(4);
  assert.ok(got.length && got.at(-1).v[0] !== 0, 'and start again with the sound');
  T.dsp.scope([]);
  got.length = 0;
  T.render(8);
  assert.equal(got.length, 0, 'unwatched: no scope data');
}

console.log('graph tests passed');
