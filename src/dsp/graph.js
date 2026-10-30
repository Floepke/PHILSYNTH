// The whole DSP of a project, run on the audio thread by src/engine.worklet.js (one AudioWorklet
// for everything instead of one AudioWorkletNode per module). Pure JS, so tests run it directly.
//
// Nodes are kernels (src/dsp/kernel.js) addressed by a handle; node 0 is the master bus (the
// worklet's output). Every module of every patch level (nested Patch modules and their instances
// included) is a node here: the main thread (src/dsp/host.js) mirrors its structure as a flat
// graph of audio edges.
//
// Per render quantum:
//   1. modulators (LFO, ADSR, VELOCITY2CTL) step and their value is mapped onto the controllers
//      their routes point to (Out Min/Out Max/Amplitude), directly on the target kernels;
//   2. the nodes that reach the master bus are rendered in dependency order. A single live input
//      is passed through without copying, several are summed; silent sources are skipped and
//      passive nodes (buses, gains) with only silent inputs are not rendered at all.
// Changed modulated values are collected and sent to the main thread by report() (for display).
//
// Messages (arrays, batched by the host): ['add', h, kind, opts] ['del', h] ['con', from, to]
// ['dis', from, to] ['msg', h, message] ['routes', h, [{ to, id, min, max, scale, step }]]
// ['clock', on] (report the audio time even without modulation changes, for MULTIMIDI drift)
// ['scope', [h...]] (watch these nodes for the cable display, see scope()).
//
// new Graph({ kernels, heap, native }): `kernels` overrides kinds of the JS registry (the C++
// kernels of src/dsp/wasm.js); with a `heap` every node's audio buffers live in that wasm memory,
// so C++ kernels work on them in place (views are remade when the memory grows). When all nodes
// in the render order are C++ kernels (and `native` isn't false), rebuild() uploads the order as
// a program and render() runs step 2 with one call (ms_run, cpp/engine.cpp); the nodes' silent
// flags then live in C++ (GNode records) and are read back when the topology changes.
import { KERNELS } from './kernels.js';
import { fromNorm } from '../params.js';

const BLOCK = 128;
const NO_INPUT = [[]];
// Cable scope: one point per SCOPE_BLOCKS quanta (256 samples, ~5 ms at 48 kHz) per watched node,
// sent with the reports. After SCOPE_QUIET silent points in a row nothing is sent until sound returns.
export const SCOPE_BLOCKS = 2;
export const SCOPE_QUIET = 1024;
const SCOPE_MAX = 16; // points kept between two reports (more are dropped)

export class Graph {
  constructor({ kernels = null, heap = null, native = true } = {}) {
    this.kernels = kernels ? { ...KERNELS, ...kernels } : KERNELS;
    this.heap = heap;
    this.x = native && heap ? heap.x : null; // wasm exports for the native graph runner
    this.prog = 0; // native render program (heap pointer) or 0
    this.nodes = new Map();
    this.order = []; // audio nodes reaching the master bus, sources first
    this.mods = []; // modulator nodes
    this.dirty = true;
    this.clock = false;
    this.pending = new Set(); // routes whose applied value changed since the last report
    this.scopeH = []; // watched node handles
    this.scopePk = new Float64Array(0); // running signed peak per watched node
    this.scopeBuf = new Float32Array(0); // points since the last report: [point][node]
    this.scopeN = 0;
    this.scopeBlk = 0;
    this.scopeQuiet = SCOPE_QUIET + 1;
    this.master = this.add(0, 'bus');
  }

  handle(batch) {
    for (const op of batch) this.op(op);
  }

  op([t, a, b, c]) {
    switch (t) {
      case 'add': this.add(a, b, c); break;
      case 'del': this.remove(a); break;
      case 'con': this.connect(a, b); break;
      case 'dis': this.disconnect(a, b); break;
      case 'msg': this.message(a, b); break;
      case 'routes': this.setRoutes(a, b); break;
      case 'clock': this.clock = !!a; break;
      case 'scope': this.setScope(a); break;
    }
  }

  add(h, kind, opts) {
    const K = this.kernels[kind];
    if (!K) throw new Error(`Unknown DSP kernel: ${kind}`);
    const node = {
      h, kind, k: new K(opts ?? {}),
      srcs: [], dsts: [],
      modulator: !!K.modulator,
      audio: K.audio !== false && !K.modulator,
      passive: !!K.passive,
      outs: null,
      outPtr: 0, // heap: [L, R] buffers of outs
      sums: null, // [[L, R]] scratch for summing several inputs (allocated on demand)
      sumPtr: 0,
      rec: 0, // native: the node's GNode record
      silent: true,
      routes: [], // modulators: [{ node, id, min, max, scale, step, last }]
      depth: { outMin: 0, outMax: 100, amp: 100 }, // modulators: mapping controllers
    };
    if (this.heap) node.outPtr = this.heap.alloc(2 * BLOCK * 4);
    node.outs = this.stereo(node.outPtr);
    if (this.x && K.wasm) node.rec = this.x.ms_node(node.k.ptr, node.outPtr, node.passive ? 1 : 0);
    this.nodes.set(h, node);
    this.dirty = true;
    return node;
  }

  // [[L, R]] block buffers: views at ptr in the heap, or plain arrays without one
  stereo(ptr) {
    if (!this.heap) return [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    return [[this.heap.f32(ptr, BLOCK), this.heap.f32(ptr + BLOCK * 4, BLOCK)]];
  }

  // the wasm memory grew: views made before are detached
  remap() {
    for (const n of this.nodes.values()) {
      n.outs = this.stereo(n.outPtr);
      if (n.sums) n.sums = this.stereo(n.sumPtr);
    }
  }

  remove(h) {
    const node = this.nodes.get(h);
    if (!node || node === this.master) return;
    node.k.destroy?.();
    if (node.rec) this.x.ms_node_free(node.rec);
    if (this.heap) {
      this.heap.free(node.outPtr);
      this.heap.free(node.sumPtr);
    }
    for (const s of [...node.srcs]) this.disconnect(s.h, h);
    for (const d of [...node.dsts]) this.disconnect(h, d.h);
    for (const m of this.nodes.values()) {
      if (!m.routes.length) continue;
      for (const r of m.routes) if (r.node === node || m === node) this.pending.delete(r);
      m.routes = m.routes.filter((r) => r.node !== node);
    }
    this.nodes.delete(h);
    this.dirty = true;
  }

  connect(from, to) {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (!a || !b || b.srcs.includes(a)) return;
    b.srcs.push(a);
    a.dsts.push(b);
    this.dirty = true;
  }

  disconnect(from, to) {
    const a = this.nodes.get(from);
    const b = this.nodes.get(to);
    if (!a || !b) return;
    b.srcs = b.srcs.filter((n) => n !== a);
    a.dsts = a.dsts.filter((n) => n !== b);
    this.dirty = true;
  }

  message(h, m) {
    const node = this.nodes.get(h);
    if (!node) return;
    node.k.message(m);
    if (m.type !== 'param') return;
    if (node.modulator && m.id in node.depth) node.depth[m.id] = m.value;
    // a controller set by hand while modulated: re-apply the modulation on the next block
    for (const mod of this.mods) for (const r of mod.routes) if (r.node === node && r.id === m.id) r.last = NaN;
  }

  setRoutes(h, list) {
    const node = this.nodes.get(h);
    if (!node) return;
    for (const r of node.routes) this.pending.delete(r);
    node.routes = list
      .map((r) => ({ node: this.nodes.get(r.to), id: r.id, min: r.min, max: r.max, scale: r.scale, step: r.step, last: NaN }))
      .filter((r) => r.node);
  }

  setScope(list) {
    this.scopeH = [...list];
    this.scopePk = new Float64Array(list.length);
    this.scopeBuf = new Float32Array(list.length * SCOPE_MAX);
    this.scopeN = 0;
    this.scopeBlk = 0;
  }

  // dependency order of everything that reaches the master bus (depth-first, sources first)
  rebuild() {
    this.dirty = false;
    const x = this.x;
    if (this.prog) for (const n of this.nodes.values()) if (n.rec) n.silent = !!x.ms_node_silent(n.rec);
    const order = [];
    const seen = new Set();
    const visit = (n) => {
      if (seen.has(n)) return;
      seen.add(n);
      for (const s of n.srcs) visit(s);
      if (n.audio) order.push(n);
    };
    visit(this.master);
    this.order = order;
    this.mods = [...this.nodes.values()].filter((n) => n.modulator);
    for (const n of this.nodes.values()) if (!seen.has(n)) n.silent = true;
    // summing buffers up front: render() must not allocate (a growing heap detaches the views)
    for (const n of order) {
      if (n.sums || n.srcs.length < 2) continue;
      if (this.heap) n.sumPtr = this.heap.alloc(2 * BLOCK * 4);
      n.sums = this.stereo(n.sumPtr);
      if (n.rec) x.ms_node_sum(n.rec, n.sumPtr);
    }
    if (this.prog) this.heap.free(this.prog);
    this.prog = 0;
    if (x && order.every((n) => n.rec)) {
      // [count, then per node: GNode*, source count, source GNode*...] (sources that never
      // render, like modulators, are left out: they are always silent)
      const words = [order.length];
      for (const n of order) {
        const srcs = n.srcs.filter((s) => s.rec);
        words.push(n.rec, srcs.length, ...srcs.map((s) => s.rec));
      }
      this.prog = this.heap.alloc(words.length * 4);
      new Int32Array(this.heap.memory.buffer, this.prog, words.length).set(words);
      for (const n of this.nodes.values()) if (n.rec) x.ms_node_set_silent(n.rec, n.silent ? 1 : 0);
    }
  }

  modulate(m, x) {
    const { outMin, outMax, amp } = m.depth;
    const y = 0.5 + (x - 0.5) * (amp / 100);
    const pos = (outMin + (outMax - outMin) * y) / 100;
    for (const r of m.routes) {
      const v = fromNorm(r, pos);
      if (v === r.last) continue;
      r.last = v;
      r.node.k.param(r.id, v);
      if (r.node.modulator && r.id in r.node.depth) r.node.depth[r.id] = v; // LFO -> LFO depth
      this.pending.add(r);
    }
  }

  // Renders one quantum into L/R (R may be L for mono).
  render(L, R) {
    if (this.dirty) this.rebuild();
    if (this.heap?.grown()) this.remap(); // after rebuild: it may allocate
    for (const m of this.mods) {
      m.k.process(NO_INPUT, m.outs);
      const x = m.k.value;
      if (x !== null && x !== undefined && m.routes.length) this.modulate(m, x);
    }
    if (this.prog) this.master.silent = !this.x.ms_run(this.prog, BLOCK);
    else for (const n of this.order) {
      let live = 0;
      let last = null;
      for (const s of n.srcs) if (!s.silent) { live++; last = s; }
      if (!live && n.passive) { n.silent = true; continue; }
      let ins = NO_INPUT;
      if (live === 1) ins = last.outs;
      else if (live > 1) ins = this.sum(n);
      n.silent = n.k.process(ins, n.outs) === false;
    }
    if (this.scopeH.length) this.scope();
    const m = this.master;
    if (m.silent) {
      L.fill(0);
      if (R !== L) R.fill(0);
    } else if (R !== L) {
      L.set(m.outs[0][0]);
      R.set(m.outs[0][1]);
    } else {
      const [a, b] = m.outs[0];
      for (let i = 0; i < L.length; i++) L[i] = 0.5 * (a[i] + b[i]);
    }
  }

  // Cable scope point: the sample with the largest magnitude (sign kept) of the node's output
  // (L+R)/2 over SCOPE_BLOCKS quanta; 0 while silent or gone. Modulators give their value
  // (LFO bipolar -1..1, others 0..1).
  scope() {
    const H = this.scopeH;
    const pk = this.scopePk;
    const native = this.prog ? this.x : null;
    for (let i = 0; i < H.length; i++) {
      const n = this.nodes.get(H[i]);
      if (!n) continue;
      if (n.modulator) {
        const x = n.k.value;
        if (x !== null && x !== undefined) pk[i] = n.kind === 'lfo' ? 2 * x - 1 : x;
        continue;
      }
      if (native && n.rec ? native.ms_node_silent(n.rec) : n.silent) continue;
      const [a, b] = n.outs[0];
      let p = pk[i];
      let mag = Math.abs(p);
      for (let j = 0; j < BLOCK; j++) {
        const v = 0.5 * (a[j] + b[j]);
        const av = Math.abs(v);
        if (av > mag) { mag = av; p = v; }
      }
      pk[i] = p;
    }
    if (++this.scopeBlk < SCOPE_BLOCKS) return;
    this.scopeBlk = 0;
    let loud = false;
    if (this.scopeN >= SCOPE_MAX) this.scopeN = SCOPE_MAX - 1; // nobody reads: keep the newest
    const at = this.scopeN++ * H.length;
    for (let i = 0; i < H.length; i++) {
      const v = Number.isFinite(pk[i]) ? pk[i] : 0;
      this.scopeBuf[at + i] = v;
      if (v !== 0) loud = true;
      pk[i] = 0;
    }
    this.scopeQuiet = loud ? 0 : this.scopeQuiet + 1;
  }

  sum(n) {
    const [L, R] = n.sums[0]; // allocated by rebuild()
    L.fill(0);
    R.fill(0);
    for (const s of n.srcs) {
      if (s.silent) continue;
      const [a, b] = s.outs[0];
      for (let i = 0; i < BLOCK; i++) { L[i] += a[i]; R[i] += b[i]; }
    }
    return n.sums;
  }

  // Message for the main thread: { time, mods: [handle, controller id, value, ...],
  // scope?: { h: [handles], n: points, v: Float32Array [point][node] } }, or null when there is
  // nothing to tell.
  report(time) {
    let scope = null;
    if (this.scopeN >= 2) { // batch two points (~10 ms) per message
      const H = this.scopeH;
      if (this.scopeQuiet <= SCOPE_QUIET) scope = { h: H, n: this.scopeN, v: this.scopeBuf.slice(0, this.scopeN * H.length) };
      this.scopeN = 0;
    }
    if (!this.pending.size && !this.clock && !scope) return null;
    const mods = [];
    for (const r of this.pending) mods.push(r.node.h, r.id, r.last);
    this.pending.clear();
    return scope ? { time, mods, scope } : { time, mods };
  }
}
