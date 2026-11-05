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
//      Carrier-aware kernels receive their chosen source separately from the sum of the rest.
//   SOUND2CTL and its audio sources also render when routed; its sampled voltage is applied
//   after step 2 for the next quantum (control feedback is therefore one block delayed).
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
// Cable scope: the waveform of every watched node, one point per SCOPE_DECIM samples (the mean of
// (L+R)/2 over them, so SCOPE_PTS points per quantum), sent with the reports. After SCOPE_QUIET
// silent points in a row nothing is sent until sound returns.
export const SCOPE_DECIM = 4;
export const SCOPE_PTS = BLOCK / SCOPE_DECIM;
export const SCOPE_QUIET = 8192;
const SCOPE_MAX = SCOPE_PTS * 32; // points kept between two reports (older ones are dropped)

// controller `id` of a modulator node is one of its mapping controllers (kept in node.depth)
const isDepth = (node, id) => node.modulator && (id in node.depth || !!node.depthIds?.test(id));

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
    this.scopeBuf = new Float32Array(0); // points since the last report: [point][node]
    this.scopeN = 0;
    this.scopeQuiet = SCOPE_QUIET + 1;
    this.meters = new Set(); // nodes whose kernel has a `meter` value (static meter = true)
    this.ext = null; // inputs of the engine worklet (microphones, see src/mics.js) for this quantum
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
      case 'panic': this.panic(); break;
    }
  }

  add(h, kind, opts) {
    const K = this.kernels[kind];
    if (!K) throw new Error(`Unknown DSP kernel: ${kind}`);
    const node = {
      h, kind, k: new K(opts ?? {}),
      srcs: [], dsts: [],
      modulator: !!K.modulator,
      audio: K.audio !== false && (!K.modulator || !!K.audioInput),
      audioInput: !!K.audioInput,
      passive: !!K.passive,
      carrierInputs: K.carrierInput ? [[], []] : null,
      outs: null,
      outPtr: 0, // heap: [L, R] buffers of outs
      sums: null, // [[L, R]] scratch for summing several inputs (allocated on demand)
      sumPtr: 0,
      rec: 0, // native: the node's GNode record
      silent: true,
      routes: [], // modulators: [{ node, id, min, max, scale, step, lo, hi, last }]
      depth: { outMin: 0, outMax: 100, amp: 100 }, // modulators: mapping controllers
      depthIds: K.depthIds ?? null, // more mapping controllers (MULTICTL route ranges: lo / hi of a route)
    };
    if (this.heap) node.outPtr = this.heap.alloc(2 * BLOCK * 4);
    node.outs = this.stereo(node.outPtr);
    if (K.external) node.k.graph = this; // reads this.ext (e.g. the INPUT kernel)
    if (K.meter) { node.meterSent = NaN; this.meters.add(node); }
    if (this.x && K.wasm) node.rec = this.x.ms_node(node.k.ptr, node.outPtr, (node.passive ? 1 : 0) | (node.carrierInputs ? 2 : 0));
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
    this.meters.delete(node);
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
    if (isDepth(node, m.id)) node.depth[m.id] = m.value;
    // a controller set by hand while modulated: re-apply the modulation on the next block
    for (const mod of this.mods) for (const r of mod.routes) if (r.node === node && r.id === m.id) r.last = NaN;
  }

  // MIDI/audio panic: every kernel drops its sounding state and the last block outputs are cleared
  // (a feedback cable would otherwise feed them back in)
  panic() {
    for (const n of this.nodes.values()) {
      n.k.panic?.();
      for (const bufs of [n.outs, n.sums]) if (bufs) for (const [l, r] of bufs) { l.fill(0); r.fill(0); }
      n.silent = true;
      if (n.rec) this.x.ms_node_set_silent(n.rec, 1);
    }
  }

  setRoutes(h, list) {
    const node = this.nodes.get(h);
    if (!node) return;
    for (const r of node.routes) this.pending.delete(r);
    node.routes = list
      .map((r) => ({ node: this.nodes.get(r.to), id: r.id, min: r.min, max: r.max, scale: r.scale, step: r.step, lo: r.lo ?? null, hi: r.hi ?? null, last: NaN }))
      .filter((r) => r.node);
    if (node.audioInput) this.dirty = true;
  }

  setScope(list) {
    this.scopeH = [...list];
    this.scopeBuf = new Float32Array(list.length * SCOPE_MAX);
    this.scopeN = 0;
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
    // Audio-driven controllers need their sources even if no audio cable reaches the Output.
    for (const n of this.nodes.values()) if (n.audioInput && n.routes.length) visit(n);
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
      // Non-native sources outside the render order are silent placeholders, so carrier
      // input numbering stays the same in native and mixed graphs.
      const words = [order.length];
      for (const n of order) {
        words.push(n.rec, n.srcs.length, ...n.srcs.map((s) => s.rec));
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
      // a route with its own range (MULTICTL): Out Min..Out Max is mapped once more onto lo..hi
      let at = pos;
      if (r.lo !== null) {
        const lo = m.depth[r.lo] ?? 0;
        at = (lo + ((m.depth[r.hi] ?? 100) - lo) * pos) / 100;
      }
      const v = fromNorm(r, at);
      if (v === r.last) continue;
      r.last = v;
      r.node.k.param(r.id, v);
      if (isDepth(r.node, r.id)) r.node.depth[r.id] = v; // LFO -> LFO depth
      this.pending.add(r);
    }
  }

  // Renders one quantum into L/R (R may be L for mono).
  render(L, R) {
    if (this.dirty) this.rebuild();
    if (this.heap?.grown()) this.remap(); // after rebuild: it may allocate
    for (const m of this.mods) {
      if (m.audioInput) continue;
      m.k.process(NO_INPUT, m.outs);
      const x = m.k.value;
      if (x !== null && x !== undefined && m.routes.length) this.modulate(m, x);
    }
    // A modulated wavetable Block Size can replace its prepared layout and grow the heap.
    if (this.heap?.grown()) this.remap();
    if (this.prog) this.master.silent = !this.x.ms_run(this.prog, BLOCK);
    else for (const n of this.order) {
      if (n.carrierInputs) {
        const carrier = n.srcs[n.k.carrier];
        let live = 0;
        let last = null;
        for (const s of n.srcs) if (s !== carrier && !s.silent) { live++; last = s; }
        n.carrierInputs[0] = carrier && !carrier.silent ? carrier.outs[0] : NO_INPUT[0];
        n.carrierInputs[1] = live === 0 ? NO_INPUT[0] : live === 1 ? last.outs[0] : this.sum(n, carrier)[0];
        n.silent = n.k.process(n.carrierInputs, n.outs) === false;
        continue;
      }
      let live = 0;
      let last = null;
      for (const s of n.srcs) if (!s.silent) { live++; last = s; }
      if (!live && n.passive) { n.silent = true; continue; }
      if (!live && n.k.dormant) { n.silent = true; continue; }
      let ins = NO_INPUT;
      if (live === 1) ins = last.outs;
      else if (live > 1) ins = this.sum(n);
      n.silent = n.k.process(ins, n.outs) === false;
    }
    // Apply after rendering: audio-derived control feeds the next quantum, including feedback
    // to its own source, without a circular audio dependency or insertion-order differences.
    for (const m of this.mods) if (m.audioInput && m.routes.length) this.modulate(m, m.k.value);
    if (this.heap?.grown()) this.remap();
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

  // Cable scope points of this quantum: per watched node SCOPE_PTS means of (L+R)/2 over
  // SCOPE_DECIM samples; 0 while silent or gone. Modulators give their value for the whole
  // quantum (LFO bipolar -1..1, others 0..1).
  scope() {
    const H = this.scopeH;
    const nH = H.length;
    const buf = this.scopeBuf;
    const native = this.prog ? this.x : null;
    if (this.scopeN + SCOPE_PTS > SCOPE_MAX) this.scopeN = 0; // nobody reads: start over
    const at = this.scopeN;
    let loud = false;
    for (let i = 0; i < nH; i++) {
      const n = this.nodes.get(H[i]);
      let a = null, b = null, c = 0;
      if (n?.modulator) {
        const x = n.k.value;
        if (x !== null && x !== undefined) c = n.kind === 'lfo' ? 2 * x - 1 : x;
        if (!Number.isFinite(c)) c = 0;
      } else if (n && !(native && n.rec ? native.ms_node_silent(n.rec) : n.silent)) {
        [a, b] = n.outs[0];
      }
      for (let p = 0; p < SCOPE_PTS; p++) {
        let v = c;
        if (a) {
          let s = 0;
          for (let j = p * SCOPE_DECIM, e = j + SCOPE_DECIM; j < e; j++) s += a[j] + b[j];
          v = s * (0.5 / SCOPE_DECIM);
          if (!Number.isFinite(v)) v = 0;
        }
        buf[(at + p) * nH + i] = v;
        if (v !== 0) loud = true;
      }
    }
    this.scopeN += SCOPE_PTS;
    this.scopeQuiet = loud ? 0 : this.scopeQuiet + SCOPE_PTS;
  }

  sum(n, skip = null) {
    const [L, R] = n.sums[0]; // allocated by rebuild()
    L.fill(0);
    R.fill(0);
    for (const s of n.srcs) {
      if (s === skip || s.silent) continue;
      const [a, b] = s.outs[0];
      for (let i = 0; i < BLOCK; i++) { L[i] += a[i]; R[i] += b[i]; }
    }
    return n.sums;
  }

  // Message for the main thread: { time, mods: [handle, controller id, value, ...],
  // scope?: { h: [handles], n: points, v: Float32Array [point][node] } }, or null when there is
  // nothing to tell. withScope = false keeps the scope points for a later report (the worklet
  // sends them at display rate, modulation and clock at full rate).
  report(time, withScope = true) {
    let scope = null;
    if (withScope && this.scopeN > 0) {
      const H = this.scopeH;
      // sent while the batch starts within SCOPE_QUIET silent points
      if (this.scopeQuiet - this.scopeN <= SCOPE_QUIET) scope = { h: H, n: this.scopeN, v: this.scopeBuf.slice(0, this.scopeN * H.length) };
      this.scopeN = 0;
    }
    let meters = null;
    for (const n of this.meters) {
      const v = n.k.meter;
      if (!(Math.abs(v - n.meterSent) < 0.01)) (meters ??= []).push(n.h, (n.meterSent = v));
    }
    if (!this.pending.size && !this.clock && !scope && !meters) return null;
    const mods = [];
    for (const r of this.pending) mods.push(r.node.h, r.id, r.last);
    this.pending.clear();
    const r = { time, mods };
    if (scope) r.scope = scope;
    if (meters) r.meters = meters;
    return r;
  }
}
