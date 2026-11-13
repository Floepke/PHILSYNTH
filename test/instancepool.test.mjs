// Run: node test/instancepool.test.mjs
// PATCH instances on worker threads (src/dsp/instancepool.js): rendering with a pool of real
// worker_threads (test/poolworker.mjs) must give exactly the samples of the single-thread graph.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker, MessageChannel } from 'node:worker_threads';

globalThis.sampleRate = 48000;
const { Graph } = await import('../src/dsp/graph.js');
const { DspHost } = await import('../src/dsp/host.js');
const { InstancePool, POOL_BYTES, poolSize } = await import('../src/dsp/instancepool.js');
const { instantiateDsp, wasmKernels } = await import('../src/dsp/wasm.js');
const { PatchRuntime } = await import('../src/patch.js');

const bytes = new Uint8Array(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url)));
const BUDGET = 5000; // ms: a slow test machine must not change the result

// logical processors -> workers: about half are real cores, two stay with the audio and main thread
assert.deepEqual([1, 2, 3, 4, 6, 8, 12, 16, 32].map((c) => poolSize(c)), [0, 0, 1, 2, 2, 3, 5, 6, 6]);

// assignment: a worker takes 4 copies before the next one wakes, then the least busy one; every
// node of a copy goes to the same worker and a deleted copy frees its place
{
  const fake = (n) => new InstancePool({ sabs: Array.from({ length: n }, () => new SharedArrayBuffer(POOL_BYTES)), ports: Array(n).fill(null) });
  const p = fake(3);
  const at = (part) => p.links.indexOf(p.take(part));
  assert.deepEqual([1, 2, 3, 4].map(at), [0, 0, 0, 0], 'the first 4 copies share one worker');
  assert.equal(at(1), 0, 'a copy keeps its worker');
  assert.deepEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(at), [1, 1, 1, 1, 2, 2, 2, 2, 0, 1], 'more copies wake more workers, then spread');
  const count = (w) => [...p.parts.values()].filter((q) => q.link === p.links[w]).length;
  assert.deepEqual([0, 1, 2].map(count), [5, 5, 4]);
  p.drop(1);
  assert.equal(at(1), 0, 'one of two nodes of copy 1 removed: the copy stays');
  p.drop(1); p.drop(1);
  for (const part of [5, 6, 7, 8]) p.drop(part);
  assert.deepEqual([0, 1, 2].map(count), [4, 1, 4]);
  assert.equal(at(20), 1, 'a new copy fills the emptied worker');
  p.links[1].dead = true;
  assert.deepEqual([21, 22].map(at), [0, 2], 'a dead worker gets no new copies');
  for (const l of p.links) l.dead = true;
  assert.equal(p.take(23), null, 'no worker left: the node renders on the audio thread');
}

async function startWorkers(n, wasm) {
  const workers = [];
  const sabs = [];
  const ports = [];
  const errors = [];
  for (let i = 0; i < n; i++) {
    const sab = new SharedArrayBuffer(POOL_BYTES);
    const ch = new MessageChannel();
    const w = new Worker(new URL('./poolworker.mjs', import.meta.url));
    w.on('message', (m) => m.error && errors.push(m.error));
    w.on('error', (e) => errors.push(String(e)));
    w.postMessage({ sab, port: ch.port2, wasm, sampleRate, budget: BUDGET }, [ch.port2]);
    workers.push(w);
    sabs.push(sab);
    ports.push(ch.port1);
  }
  // READY (control word 5) once the worker has its graph
  const ctrls = sabs.map((sab) => new Int32Array(sab, 0, 8));
  for (let t = 0; ctrls.some((c) => !Atomics.load(c, 5)); t++) {
    assert.ok(t < 1000, 'workers start');
    await new Promise((r) => setTimeout(r, 10));
  }
  return { workers, sabs, ports, errors };
}

function makeGraph(wasm) {
  return wasm ? new Graph(wasmKernels(instantiateDsp(wasm), sampleRate)) : new Graph();
}

function hostOf(graph) {
  return new DspHost({ onmessage: null, postMessage: (batch) => graph.handle(batch) }, { sync: true });
}

const L = new Float32Array(128);
const R = new Float32Array(128);
function renderInto(graph, out) {
  graph.render(L, R);
  out.push(Float32Array.from(L), Float32Array.from(R));
}

// A scene with the borders the pool handles: a local source into remote nodes of several
// instances (import), remote chains (cables forwarded within a worker), remote nodes into a local
// bus (export), a local LFO modulating remote controllers, notes, binary messages (sample data,
// MessagePort path), cable changes, removing nodes and panic.
async function scene(graph, dsp, steps) {
  const out = [];
  const lead = dsp.create('osc');
  lead.send({ type: 'noteOn', id: 1, pitch: 45, velocity: 0.6 });
  const inGain = dsp.create('bus');
  lead.connect(inGain);
  const outGain = dsp.create('bus');
  outGain.connect(dsp.destination);
  const lfo = dsp.create('lfo');
  lfo.param('rate', 7);
  const inst = [];
  for (let k = 0; k < 8; k++) {
    const part = k; // 0: instance 1 (audio thread), 1..7: the copies
    const o = dsp.create('osc', null, part);
    o.param('polyphony', 4);
    const f = dsp.create('filter', null, part);
    const a = dsp.create('amp', null, part);
    o.connect(f);
    inGain.connect(f);
    f.connect(a);
    a.connect(outGain);
    for (let v = 0; v < 3; v++) o.send({ type: 'noteOn', id: 10 + v, pitch: 48 + k * 2 + v * 7, velocity: 0.5 });
    inst.push({ o, f, a });
  }
  lfo.routes(inst.map(({ f }) => ({ to: f.h, id: 'cutoff', min: 200, max: 4000 })));
  const smp = dsp.create('sampler', null, 3);
  const data = new Float32Array(4800).map((_, i) => Math.sin(i * 0.05) * (1 - i / 4800));
  smp.send({ type: 'sample', channels: [data], rate: 48000 });
  smp.connect(outGain);
  smp.send({ type: 'noteOn', id: 50, pitch: 60, velocity: 1 });
  for (let b = 0; b < steps; b++) {
    if (b === 40) inst[2].a.disconnect(outGain);
    if (b === 60) inst[2].a.connect(outGain);
    if (b === 70) { inst[5].o.destroy(); inst[5].f.destroy(); inst[5].a.destroy(); }
    if (b === 80) inst[1].o.send({ type: 'noteOff', id: 10 });
    if (b === 90) inGain.disconnect(inst[4].f);
    if (b === 100) graph.panic();
    if (b === 105) for (const { o } of inst) o.send({ type: 'noteOn', id: 99, pitch: 70, velocity: 0.7 });
    renderInto(graph, out);
  }
  return out;
}

function same(a, b, label) {
  assert.equal(a.length, b.length);
  let loud = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < 128; j++) {
      if (!Object.is(a[i][j], b[i][j])) assert.fail(`${label}: block ${i >> 1} sample ${j}: ${a[i][j]} vs ${b[i][j]}`);
      if (Math.abs(a[i][j]) > 1e-4) loud++;
    }
  }
  assert.ok(loud > 1000, `${label}: it makes sound`);
}

for (const wasm of [null, bytes]) {
  const label = wasm ? 'wasm kernels' : 'JS kernels';
  const plain = makeGraph(wasm);
  const expected = await scene(plain, hostOf(plain), 160);

  const pool = await startWorkers(3, wasm);
  const pooled = makeGraph(wasm);
  pooled.setPool(new InstancePool({ sabs: pool.sabs, ports: pool.ports }, { budget: BUDGET }));
  const got = await scene(pooled, hostOf(pooled), 160);
  assert.deepEqual(pool.errors, [], `${label}: no worker errors`);
  const remote = [...pooled.nodes.values()].filter((n) => n.link);
  assert.ok(remote.length >= 18, `${label}: the copies render on the workers (${remote.length} remote nodes)`);
  assert.ok(remote.every((n) => n.kind !== 'lfo'), 'modulators stay on the audio thread');
  assert.ok(pooled.steps.some((s) => s.fetch) && pooled.steps.some((s) => s.publish), 'imports and exports');
  assert.equal(pooled.native, !!wasm, `${label}: native runner with remote nodes`);
  same(expected, got, label);

  // a worker that is gone: its instances go silent after the deadline, nothing hangs
  await pool.workers[0].terminate();
  pooled.pool.budget = 2;
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) pooled.render(L, R);
  assert.ok(performance.now() - t0 < 2000, 'a dead worker does not hang the audio thread');
  await Promise.all(pool.workers.map((w) => w.terminate()));
  console.log(`${label}: pooled render matches the single-thread render`);
}

// ---- PATCH Instances end to end: copies (part > 0) render on the workers ----
async function patchScene(graph) {
  const dsp = hostOf(graph);
  const engine = { ctx: { currentTime: 0 }, dsp };
  const r = await PatchRuntime.create(engine, dsp.destination);
  const pm = await r.addModule('PATCH');
  assert.ok(r.connect(pm.id, 0));
  const ip = pm.inst.patch;
  const osc = await ip.addModule('OSC', { values: { polyphony: 1 } });
  const flt = await ip.addModule('FILTER');
  assert.ok(ip.connect(osc.id, flt.id) && ip.connect(flt.id, 0));
  r.setParam(pm.id, 'inputModule', osc.id);
  r.setParam(pm.id, 'instances', 8);
  await pm.inst.sync();
  assert.equal(ip.part, 0, 'instance 1 stays on the audio thread');
  const parts = pm.inst.clones.map((c) => c.part);
  assert.ok(parts.every((p) => p > 0) && new Set(parts).size === parts.length, 'every copy is a partition');
  for (let i = 1; i <= 8; i++) pm.inst.noteOn(i, 48 + i * 2, 1);
  await new Promise((res) => setTimeout(res, 0));
  const out = [];
  for (let b = 0; b < 120; b++) {
    if (b === 60) ip.setParam(flt.id, 'cutoff', 700);
    renderInto(graph, out);
  }
  return out;
}

{
  const plain = makeGraph(bytes);
  const expected = await patchScene(plain);
  const pool = await startWorkers(4, bytes);
  const pooled = makeGraph(bytes);
  pooled.setPool(new InstancePool({ sabs: pool.sabs, ports: pool.ports }, { budget: BUDGET }));
  const got = await patchScene(pooled);
  assert.deepEqual(pool.errors, []);
  const remote = [...pooled.nodes.values()].filter((n) => n.link);
  assert.ok(remote.length >= 14, `PATCH copies render remotely (${remote.length} nodes)`);
  const per = pooled.pool.links.map((l) => new Set(remote.filter((n) => n.link === l).map((n) => n.part)).size);
  assert.deepEqual(per, [4, 3, 0, 0], '7 copies wake 2 workers');
  same(expected, got, 'PATCH instances');
  await Promise.all(pool.workers.map((w) => w.terminate()));
  console.log('PATCH instances: pooled render matches');
}

console.log('instancepool tests passed');
