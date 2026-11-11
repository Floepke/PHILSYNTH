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
//   Sound loops (a cable may close one through two or more FEEDBACK modules, see src/patch.js)
//   render sample by sample: the nodes of a loop (a strongly connected part of the order) form a
//   group rendered at the place of its last member, each member one sample at a time in order. A
//   source that is a later member (or the node itself) gives its previous sample, so a loop adds
//   exactly one sample of delay. Per sample the rules above apply (silent sources skipped,
//   passive nodes without a live source skipped); a silent sample is written as 0 and liveAt[]
//   remembers which samples were live.
//   Tuned loops: a DELAY in Note unit inside a loop gets controller `loop` every quantum (before
//   step 2): the samples the rest of its loop delays the tone, so it rings at the note's pitch.
//   That is one sample per back step of the loop's shortest cycle through the DELAY, plus the
//   phase delay of every FILTER on that cycle at the frequency of the DELAY's newest note
//   (src/dsp/loopphase.js, from the FILTER's controller values; DELAY Loop Tuning Off leaves the
//   FILTERs out). Outside a loop `loop` is 1.
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
import { fromNorm, toNorm } from '../params.js';
import { filterPhaseDelay } from './loopphase.js';
import { noteHz } from '../modules/delaytime.js';
import { AudioAnalysis, ANALYSIS_SIZE } from './analysis.js';

const BLOCK = 128;
const NO_INPUT = [[]];
// Cable scope: the waveform of every watched node, one point per SCOPE_DECIM samples (the mean of
// (L+R)/2 over them, so SCOPE_PTS points per quantum), sent with the reports. After SCOPE_QUIET
// silent points in a row nothing is sent until sound returns. Per watched node it also flags
// whether any raw sample went beyond ±1 since the last report (the cable shows it, cablescope.js).
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
    this.plan = []; // the order with sound loops as groups (see loops())
    this.mods = []; // modulator nodes
    this.tuned = []; // DELAY nodes in a sound loop (see tuneLoops)
    this.dirty = true;
    this.clock = false;
    this.pending = new Set(); // routes whose applied value changed since the last report
    this.scopeH = []; // watched node handles
    this.scopeBuf = new Float32Array(0); // points since the last report: [point][node]
    this.scopeN = 0;
    this.scopeQuiet = SCOPE_QUIET + 1;
    this.scopeClip = new Uint8Array(0); // per watched node: a sample beyond ±1 since the last report
    this.meters = new Set(); // nodes whose kernel has a `meter` value (static meter = true)
    this.ext = null; // inputs of the engine worklet (microphones, see src/mics.js) for this quantum
    this.analysis = null;
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
      case 'analyse': this.setAnalysis(a, b); break;
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
      through: !!K.audioThrough, // LFO: audio node only while sound is cabled in (see rebuild)
      passive: !!K.passive,
      carrierInputs: K.carrierInput ? [[], []] : null,
      outs: null,
      outPtr: 0, // heap: [L, R] buffers of outs
      sums: null, // [[L, R]] scratch for summing several inputs (allocated on demand)
      sumPtr: 0,
      rec: 0, // native: the node's GNode record
      silent: true,
      loop: null, // the sound-loop group the node renders in (see loops()), or null
      rank: 0, // its place in that group
      loopSrcs: null, // per source { s, inner: in the group, back: gives its previous sample }
      liveAt: null, // in a loop: which samples of outs were live (Uint8Array(BLOCK))
      one: null, // in a loop: one-sample input / carrier / output buffers (see oneBuffers)
      onePtr: 0,
      routes: [], // modulators: [{ node, id, min, max, scale, step, lo, hi, last }]
      depth: { outMin: 0, outMax: 100, amp: 100, outSmooth: 0 }, // modulators: mapping controllers
      values: {}, // last controller values, also the starting point of a new smoothed route
      depthIds: K.depthIds ?? null, // more mapping controllers (MULTICTL route ranges: lo / hi of a route)
      tune: null, // DELAY in a sound loop: { filters, back, key } (see loops / tuneLoops)
      loopSent: 1, // DELAY: last `loop` controller value given to the kernel
      notePitch: 60, // DELAY: pitch of its newest note
      noteId: null,
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

  // one-sample buffers of a loop node: input L/R, carrier L/R, output L/R (6 floats at ptr)
  oneBuffers(ptr) {
    const [inL, inR, carL, carR, outL, outR] = [0, 1, 2, 3, 4, 5].map((k) => (this.heap ? this.heap.f32(ptr + k * 4, 1) : new Float32Array(1)));
    return { inL, inR, ins: [[inL, inR]], car: [carL, carR], outL, outR, outs: [[outL, outR]] };
  }

  // the wasm memory grew: views made before are detached
  remap() {
    for (const n of this.nodes.values()) {
      n.outs = this.stereo(n.outPtr);
      if (n.sums) n.sums = this.stereo(n.sumPtr);
      if (n.one) n.one = this.oneBuffers(n.onePtr);
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
      this.heap.free(node.onePtr);
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
    if (node.kind === 'delay') {
      if (m.type === 'noteOn') { node.noteId = m.id; node.notePitch = +m.pitch || 0; }
      else if (m.type === 'noteMod') for (const [id, pitch] of m.notes) if (id === node.noteId) node.notePitch = +pitch || 0;
    }
    if (m.type !== 'param') return;
    if (node.through && m.id === 'mode') this.dirty = true;
    node.values[m.id] = m.value;
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
      n.liveAt?.fill(0);
      if (n.rec) this.x.ms_node_set_silent(n.rec, 1);
    }
  }

  setRoutes(h, list) {
    const node = this.nodes.get(h);
    if (!node) return;
    for (const r of node.routes) this.pending.delete(r);
    node.routes = list
      .map((r) => ({ node: this.nodes.get(r.to), id: r.id, min: r.min, max: r.max, scale: r.scale, step: r.step, lo: r.lo ?? null, hi: r.hi ?? null, last: NaN, smoothed: NaN }))
      .filter((r) => r.node);
    if (node.audioInput) this.dirty = true;
  }

  setScope(list) {
    this.scopeH = [...list];
    this.scopeBuf = new Float32Array(list.length * SCOPE_MAX);
    this.scopeN = 0;
    this.scopeClip = new Uint8Array(list.length);
  }

  setAnalysis(h, size = ANALYSIS_SIZE) {
    if ((this.analysis?.h ?? null) === h && (h === null || this.analysis.size === size)) return;
    this.analysis = h === null ? null : new AudioAnalysis(h, size);
    this.dirty = true;
  }

  // dependency order of everything that reaches the master bus (depth-first, sources first)
  rebuild() {
    this.dirty = false;
    const x = this.x;
    if (this.prog) for (const n of this.nodes.values()) if (n.rec) n.silent = !!x.ms_node_silent(n.rec);
    // Audio modes render in audio order; controller mode ignores incoming sound.
    for (const n of this.nodes.values()) if (n.through) {
      n.audio = n.audioInput = n.k.mode > 0 && n.srcs.length > 0;
      if (!n.audio) n.silent = true;
    }
    const order = [];
    const seen = new Set();
    const visit = (n) => {
      if (seen.has(n)) return;
      seen.add(n);
      for (const s of n.srcs) visit(s);
      if (n.audio) order.push(n);
    };
    // Monitoring an uncabled module must not route it to the speakers. Visit it first so
    // the native runner still ends with the master bus, whose silence flag it returns.
    const monitored = this.nodes.get(this.analysis?.h);
    if (monitored?.audio) visit(monitored);
    visit(this.master);
    // Audio-driven controllers need their sources even if no audio cable reaches the Output.
    for (const n of this.nodes.values()) if (n.audioInput && n.routes.length) visit(n);
    this.order = order;
    this.plan = this.loops(order);
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
      // A loop group is [0, member count, then per member: GNode*, source count, and per source
      // GNode* and 0 outside the group / 1 inside / 2 inside, previous sample].
      const words = [this.plan.length];
      for (const e of this.plan) {
        if (!e.members) {
          words.push(e.rec, e.srcs.length, ...e.srcs.map((s) => s.rec));
          continue;
        }
        words.push(0, e.members.length);
        for (const n of e.members) {
          words.push(n.rec, n.loopSrcs.length);
          for (const l of n.loopSrcs) words.push(l.s.rec, l.inner ? (l.back ? 2 : 1) : 0);
        }
      }
      this.prog = this.heap.alloc(words.length * 4);
      new Int32Array(this.heap.memory.buffer, this.prog, words.length).set(words);
      for (const n of this.nodes.values()) if (n.rec) x.ms_node_set_silent(n.rec, n.silent ? 1 : 0);
    }
    // like ms_node_set_silent: only the last sample of the previous block counts as live (it is
    // what a source back in a loop gives first)
    for (const n of this.nodes.values()) {
      if (!n.liveAt) continue;
      n.liveAt.fill(0);
      n.liveAt[BLOCK - 1] = n.silent ? 0 : 1;
    }
  }

  // The render plan: the order with every sound loop (a strongly connected part, Tarjan) replaced
  // by one group { members } at the place of its last member. Depth-first order puts every
  // source of a group from outside before that place, and no node between two members depends
  // on a member (it would be part of the loop).
  loops(order) {
    const at = new Map(order.map((n, i) => [n, i]));
    for (const n of this.nodes.values()) { n.loop = null; n.loopSrcs = null; n.tune = null; }
    this.tuned = [];
    const num = new Map();
    const low = new Map();
    const stack = [];
    const on = new Set();
    const groups = [];
    const strong = (n) => {
      num.set(n, num.size);
      low.set(n, num.get(n));
      stack.push(n);
      on.add(n);
      for (const s of n.srcs) {
        if (!at.has(s)) continue;
        if (!num.has(s)) {
          strong(s);
          low.set(n, Math.min(low.get(n), low.get(s)));
        } else if (on.has(s)) low.set(n, Math.min(low.get(n), num.get(s)));
      }
      if (low.get(n) !== num.get(n)) return;
      const part = [];
      let m;
      do { m = stack.pop(); on.delete(m); part.push(m); } while (m !== n);
      if (part.length > 1 || n.srcs.includes(n)) groups.push(part);
    };
    for (const n of order) if (!num.has(n)) strong(n);
    if (!groups.length) { this.untune(); return order; }
    const last = new Map();
    for (const part of groups) {
      const members = part.sort((a, b) => at.get(a) - at.get(b));
      const group = { members };
      members.forEach((n, i) => { n.loop = group; n.rank = i; });
      for (const n of members) {
        n.loopSrcs = n.srcs.map((s) => ({ s, inner: s.loop === group, back: s.loop === group && s.rank >= n.rank }));
        if (!n.one) {
          if (this.heap) n.onePtr = this.heap.alloc(6 * 4);
          n.one = this.oneBuffers(n.onePtr);
          n.liveAt = new Uint8Array(BLOCK);
        }
      }
      last.set(members[members.length - 1], group);
      for (const n of members) if (n.kind === 'delay') this.tuneOf(n, group);
    }
    this.untune();
    const plan = [];
    for (const n of order) {
      if (!n.loop) plan.push(n);
      else if (last.has(n)) plan.push(last.get(n));
    }
    return plan;
  }

  // The shortest cycle from a DELAY back to itself inside its loop group (breadth-first): the
  // samples its back steps add (a source at or after its destination in the group gives its
  // previous sample) and the FILTERs on it.
  tuneOf(d, group) {
    const prev = new Map();
    const queue = [d];
    for (let qi = 0; qi < queue.length && !prev.has(d); qi++) {
      const a = queue[qi];
      for (const b of a.dsts) {
        if (b.loop !== group || prev.has(b)) continue;
        prev.set(b, a);
        if (b === d) break;
        queue.push(b);
      }
    }
    if (!prev.has(d)) return;
    const filters = [];
    let back = 0;
    let b = d;
    do {
      const a = prev.get(b);
      if (a.rank >= b.rank) back++;
      if (a.kind === 'filter') filters.push(a);
      b = a;
    } while (b !== d);
    d.tune = { filters, back, key: null };
    this.tuned.push(d);
  }

  // a DELAY that left its loop gets the plain one-sample correction back
  untune() {
    for (const n of this.nodes.values()) {
      if (n.kind !== 'delay' || n.tune || n.loopSent === 1) continue;
      n.loopSent = 1;
      n.k.param('loop', 1);
    }
  }

  // `loop` of every DELAY in a sound loop for this quantum (see the header); recomputed only when
  // the note's pitch, Loop Tuning or a controller of a FILTER on the cycle changed
  tuneLoops() {
    for (const n of this.tuned) {
      const t = n.tune;
      const on = (n.values.tune ?? 1) >= 0.5;
      let key = `${n.notePitch}|${on}`;
      if (on) for (const f of t.filters) {
        const v = f.values;
        key += `|${v.type},${v.slope},${v.cutoff},${v.resonance},${v.gain},${v.vowel},${v.mix}`;
      }
      if (key === t.key) continue;
      t.key = key;
      let loop = t.back;
      if (on) {
        const hz = noteHz(n.notePitch);
        for (const f of t.filters) loop += filterPhaseDelay(f.values, hz, sampleRate);
      }
      if (loop === n.loopSent) continue;
      n.loopSent = loop;
      n.k.param('loop', loop);
    }
  }

  // One sound-loop group, sample by sample (see the header).
  renderLoop({ members }) {
    for (const n of members) n.silent = true;
    for (let i = 0; i < BLOCK; i++) {
      const prev = i ? i - 1 : BLOCK - 1;
      for (const n of members) {
        const o = n.one;
        const carrier = n.carrierInputs ? n.srcs[n.k.carrier] : null;
        let live = 0;
        let carried = false;
        o.inL[0] = 0;
        o.inR[0] = 0;
        for (const { s, inner, back } of n.loopSrcs) {
          const j = back ? prev : i;
          if (inner ? !s.liveAt[j] : s.silent) continue;
          const [a, b] = s.outs[0];
          if (s === carrier) { o.car[0][0] = a[j]; o.car[1][0] = b[j]; carried = true; }
          else { o.inL[0] += a[j]; o.inR[0] += b[j]; live++; }
        }
        let on;
        if (n.carrierInputs) {
          n.carrierInputs[0] = carried ? o.car : NO_INPUT[0];
          n.carrierInputs[1] = live ? o.ins[0] : NO_INPUT[0];
          on = n.k.process(n.carrierInputs, o.outs) !== false;
        } else if (!live && (n.passive || n.k.dormant)) on = false;
        else on = n.k.process(live ? o.ins : NO_INPUT, o.outs) !== false;
        const [L, R] = n.outs[0];
        L[i] = on ? o.outL[0] : 0;
        R[i] = on ? o.outR[0] : 0;
        n.liveAt[i] = on ? 1 : 0;
        if (on) n.silent = false;
      }
    }
  }

  modulate(m, x) {
    if (m.through && m.k.mode > 0) return;
    const { outMin, outMax, amp, outSmooth } = m.depth;
    const y = 0.5 + (x - 0.5) * (amp / 100);
    const pos = (outMin + (outMax - outMin) * y) / 100;
    const smoothing = outSmooth > 0;
    const alpha = smoothing ? -Math.expm1(-BLOCK * 1000 / (sampleRate * outSmooth)) : 1;
    for (const r of m.routes) {
      // a route with its own range (MULTICTL): Out Min..Out Max is mapped once more onto lo..hi
      let at = pos;
      if (r.lo !== null) {
        const lo = m.depth[r.lo] ?? 0;
        at = (lo + ((m.depth[r.hi] ?? 100) - lo) * pos) / 100;
      }
      at = Math.min(1, Math.max(0, at));
      if (smoothing) {
        if (!Number.isFinite(r.smoothed)) {
          const initial = toNorm(r, r.node.values[r.id]);
          r.smoothed = Number.isFinite(initial) ? Math.min(1, Math.max(0, initial)) : at;
        }
        r.smoothed = Math.abs(at - r.smoothed) < 1e-9 ? at : r.smoothed + (at - r.smoothed) * alpha;
      } else r.smoothed = at;
      const v = fromNorm(r, r.smoothed);
      if (v === r.last) continue;
      r.last = v;
      r.node.k.param(r.id, v);
      if (r.node.through && r.id === 'mode') this.dirty = true;
      r.node.values[r.id] = v;
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
    if (this.tuned.length) this.tuneLoops();
    // A modulated wavetable Block Size can replace its prepared layout and grow the heap.
    if (this.heap?.grown()) this.remap();
    if (this.prog) this.master.silent = !this.x.ms_run(this.prog, BLOCK);
    else for (const n of this.plan) {
      if (n.members) { this.renderLoop(n); continue; }
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
    if (this.analysis) {
      const n = this.nodes.get(this.analysis.h);
      const silent = !n || !n.audio || (this.prog && n.rec ? this.x.ms_node_silent(n.rec) : n.silent);
      this.analysis.push(silent ? null : n.outs[0][0], silent ? null : n.outs[0][1]);
    }
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
    const clip = this.scopeClip;
    const native = this.prog ? this.x : null;
    if (this.scopeN + SCOPE_PTS > SCOPE_MAX) this.scopeN = 0; // nobody reads: start over
    const at = this.scopeN;
    let loud = false;
    for (let i = 0; i < nH; i++) {
      const n = this.nodes.get(H[i]);
      let a = null, b = null, c = 0;
      if (n?.modulator && !(n.through && n.k.mode > 0)) {
        const x = n.k.value;
        if (x !== null && x !== undefined) c = n.kind === 'lfo' ? 2 * x - 1 : x;
        if (!Number.isFinite(c)) c = 0;
      } else if (n && !(native && n.rec ? native.ms_node_silent(n.rec) : n.silent)) {
        [a, b] = n.outs[0];
        if (!clip[i]) for (let j = 0; j < BLOCK; j++) if (Math.abs(a[j]) > 1 || Math.abs(b[j]) > 1) { clip[i] = 1; break; }
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
  // scope?: { h: [handles], n: points, v: Float32Array [point][node], clip: Uint8Array [node] } },
  // or null when there is
  // nothing to tell. withScope = false keeps the scope points for a later report (the worklet
  // sends them at display rate, modulation and clock at full rate).
  report(time, withScope = true) {
    let scope = null;
    if (withScope && this.scopeN > 0) {
      const H = this.scopeH;
      // sent while the batch starts within SCOPE_QUIET silent points
      if (this.scopeQuiet - this.scopeN <= SCOPE_QUIET) scope = { h: H, n: this.scopeN, v: this.scopeBuf.slice(0, this.scopeN * H.length), clip: this.scopeClip.slice() };
      this.scopeN = 0;
      this.scopeClip.fill(0);
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
