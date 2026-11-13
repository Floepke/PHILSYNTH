// PATCH instances on worker threads. The engine worklet (src/engine.worklet.js) renders the whole
// project in one Graph (src/dsp/graph.js); with a pool, the audio modules of every extra instance
// of a PATCH (instance 2..16; instance 1, the one being edited, stays on the audio thread so its
// scopes and meters work) are rendered by up to POOL_MAX workers (src/dsp/instanceworker.js),
// within the same render quantum, so no latency is added.
//
// Each instance copy is a partition (`part`, see src/patch.js): its modules go to worker
// (part - 1) % workers. In the audio thread's Graph they stay as remote nodes (same handle,
// topology and output buffers, a forwarding kernel) so the order and the cables work as before.
// Audio crossing the border uses shared slots:
//   import: an audio-thread node cabled into a remote node (e.g. the PATCH input into an
//           instance's Input Module); the worker holds a stand-in node with the same handle
//   export: a remote node cabled into an audio-thread node (an instance's Output into the
//           PATCH output bus); the audio thread copies it into the remote node's buffers
// Per quantum the audio thread kicks every worker (after the modulators, so their controller
// changes go along), renders what doesn't need the workers, waits for the exports it needs
// and publishes imports as soon as they are rendered. A worker that is still busy or late
// (deadline DEADLINE of a quantum) leaves its instances silent for that quantum.
//
// Modulators, INPUT (microphones) and the LFO (audio through) of an instance stay on the audio
// thread; their controller changes go to the workers as messages. A sound loop through the
// border (FEEDBACK cables between the audio thread and a worker) is not supported: it renders
// late (silent) instead of hanging.
//
// One SharedArrayBuffer per worker (needs a cross-origin isolated page, COOP/COEP headers, see
// server.mjs and coi-sw.js): control words, per slot stamp (the quantum it was written for) and silent flag,
// stereo audio slots and a ring of op batches (JSON text as UTF-16 code units). Batches that
// can't go as JSON (typed arrays, non-finite numbers) or don't fit go by MessagePort; every batch
// has a sequence number so the worker applies them in order.
const BLOCK = 128;
export const POOL_MAX = 4;
export const SLOTS = 64; // imports and exports per worker
const RING = 1 << 16; // UTF-16 code units
const DEADLINE = 0.7; // of a quantum's duration
const CTRL = 8; // KICK, DONE, SEQ, HEAD, TAIL, READY
const KICK = 0, DONE = 1, SEQ = 2, HEAD = 3, TAIL = 4, READY = 5;
const IN_STAMP = CTRL * 4;
const IN_SILENT = IN_STAMP + SLOTS * 4;
const OUT_STAMP = IN_SILENT + SLOTS * 4;
const OUT_SILENT = OUT_STAMP + SLOTS * 4;
const IN_AUDIO = OUT_SILENT + SLOTS * 4;
const OUT_AUDIO = IN_AUDIO + SLOTS * 2 * BLOCK * 4;
const RING_AT = OUT_AUDIO + SLOTS * 2 * BLOCK * 4;
export const POOL_BYTES = RING_AT + RING * 2;
const DEAD_BLOCKS = 4000; // a worker that hasn't finished for this long is given up

const budgetMs = () => DEADLINE * (BLOCK / sampleRate) * 1000;
const now = globalThis.performance?.now ? () => performance.now() : () => Date.now();

// workers worth starting on this machine (the audio thread and the main thread keep a core each)
export const poolSize = (cores = globalThis.navigator?.hardwareConcurrency ?? 1) => Math.min(POOL_MAX, Math.max(0, cores - 2));

function views(sab) {
  const slots = (at) => Array.from({ length: SLOTS }, (_, i) => [
    new Float32Array(sab, at + i * 2 * BLOCK * 4, BLOCK),
    new Float32Array(sab, at + (i * 2 + 1) * BLOCK * 4, BLOCK),
  ]);
  return {
    ctrl: new Int32Array(sab, 0, CTRL),
    inStamp: new Int32Array(sab, IN_STAMP, SLOTS),
    inSilent: new Int32Array(sab, IN_SILENT, SLOTS),
    outStamp: new Int32Array(sab, OUT_STAMP, SLOTS),
    outSilent: new Int32Array(sab, OUT_SILENT, SLOTS),
    ins: slots(IN_AUDIO),
    outs: slots(OUT_AUDIO),
    ring: new Uint16Array(sab, RING_AT, RING),
  };
}

// plain JSON survives the round trip unchanged (no typed arrays, NaN, Infinity or array holes)
function jsonSafe(v) {
  if (v === null) return true;
  switch (typeof v) {
    case 'number': return Number.isFinite(v);
    case 'string': case 'boolean': return true;
    case 'object':
      if (Array.isArray(v)) {
        for (const x of v) if (x === undefined || !jsonSafe(x)) return false;
        return true;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype) return false;
      for (const k in v) if (v[k] !== undefined && !jsonSafe(v[k])) return false;
      return true;
    default: return false;
  }
}

// Wait until stamp[slot] is `block` (true) or the deadline passed (false).
function await_(stamp, slot, block, deadline) {
  for (let i = 1; Atomics.load(stamp, slot) !== block; i++) if (!(i & 63) && now() > deadline) return false;
  return true;
}

class SlotTable {
  constructor() { this.free = Array.from({ length: SLOTS }, (_, i) => SLOTS - 1 - i); }
  take() { return this.free.pop() ?? -1; }
  give(slot) { this.free.push(slot); }
}

// forwards what the audio thread's Graph does to a remote node's kernel
class RemoteKernel {
  constructor(link, h) { this.link = link; this.h = h; }
  message(m) { this.link.post(['msg', this.h, m]); }
  param(id, value) { this.link.post(['msg', this.h, { type: 'param', id, value }]); }
}

// audio-thread side of one worker
class PoolLink {
  constructor(sab, port) {
    Object.assign(this, views(sab));
    this.port = port;
    this.queue = [];
    this.seq = 0;
    this.nodes = 0; // remote nodes on this worker
    this.last = 0; // last kicked quantum
    this.block = 0;
    this.kicked = false;
    this.late = false;
    this.lag = 0;
    this.dead = false;
    this.deadline = 0;
    this.imports = new Map(); // local handle -> { slot, dsts: Set(remote handles) }
    this.exports = new Map(); // remote handle -> slot
    this.inSlots = new SlotTable();
    this.outSlots = new SlotTable();
  }

  proxy(h) { return new RemoteKernel(this, h); }

  post(op) { if (!this.dead) this.queue.push(op); }

  flush() {
    if (!this.queue.length) return;
    const ops = this.queue;
    this.queue = [];
    const seq = ++this.seq;
    if (!(jsonSafe(ops) && this.write(seq, JSON.stringify(ops)))) this.port.postMessage([seq, ops]);
    Atomics.store(this.ctrl, SEQ, seq);
  }

  write(seq, str) {
    const { ctrl, ring } = this;
    let p = ctrl[HEAD];
    const free = (Atomics.load(ctrl, TAIL) - p - 1 + RING) % RING;
    if (str.length + 4 > free) return false;
    for (const w of [str.length & 0xffff, str.length >>> 16, seq & 0xffff, seq >>> 16]) { ring[p] = w; p = (p + 1) % RING; }
    for (let i = 0; i < str.length; i++) { ring[p] = str.charCodeAt(i); p = (p + 1) % RING; }
    Atomics.store(ctrl, HEAD, p);
    return true;
  }

  kick(block, deadline) {
    this.kicked = false;
    this.late = false;
    this.deadline = deadline;
    if (this.dead || !Atomics.load(this.ctrl, READY)) return;
    // the worker publishes its exports before it stores DONE: it is about to finish (unless it
    // has been lagging already: then it isn't waited for)
    const done = this.lag ? Atomics.load(this.ctrl, DONE) === this.last : await_(this.ctrl, DONE, this.last, deadline);
    if (!done) {
      if (++this.lag > DEAD_BLOCKS) { this.dead = true; this.queue = []; }
      return;
    }
    this.lag = 0;
    if (!this.nodes && !this.queue.length) return;
    this.flush();
    this.block = this.last = block;
    this.kicked = true;
    Atomics.store(this.ctrl, KICK, block);
    Atomics.notify(this.ctrl, KICK);
  }

  // an export into outs; true if silent (not rendered in time)
  fetch(slot, [L, R]) {
    if (!this.kicked || this.late) return true;
    if (!await_(this.outStamp, slot, this.block, this.deadline)) { this.late = true; return true; }
    if (this.outSilent[slot]) return true;
    L.set(this.outs[slot][0]);
    R.set(this.outs[slot][1]);
    return false;
  }

  publish(slot, [L, R], silent) {
    if (!this.kicked) return;
    if (!silent) { this.ins[slot][0].set(L); this.ins[slot][1].set(R); }
    this.inSilent[slot] = silent ? 1 : 0;
    Atomics.store(this.inStamp, slot, this.block);
  }
}

// The audio thread's pool: one link per worker ({ sabs, ports } from src/engine.js).
// budget: how long to wait for the workers per quantum, ms (tests)
export class InstancePool {
  constructor({ sabs, ports }, { budget = null } = {}) {
    this.budget = budget;
    this.links = sabs.map((sab, i) => new PoolLink(sab, ports[i]));
  }

  linkFor(part) { return this.links[(part - 1) % this.links.length]; }

  broadcast(op) { for (const l of this.links) if (l.nodes) l.post(op); }

  begin(block) {
    const deadline = now() + (this.budget ?? budgetMs());
    for (const l of this.links) l.kick(block, deadline);
  }

  // After a topology change (Graph.rebuild): the cables crossing the border become imports /
  // exports (stand-in nodes and slots on the workers); sets node.taps and node.stand.
  sync(nodes) {
    const imp = this.links.map(() => new Map()); // local node -> Set(remote handles)
    const exp = this.links.map(() => new Set()); // remote nodes
    for (const n of nodes) {
      n.taps = null;
      if (!n.link) continue;
      n.stand = null;
      const w = this.links.indexOf(n.link);
      for (const s of n.srcs) {
        if (s.link) continue; // same worker: forwarded by connect(); other worker: can't happen
        let set = imp[w].get(s);
        if (!set) imp[w].set(s, set = new Set());
        set.add(n.h);
      }
      if (n.dsts.some((d) => !d.link)) exp[w].add(n);
    }
    this.links.forEach((l, w) => {
      const want = imp[w];
      const byH = new Map([...want.keys()].map((n) => [n.h, n]));
      for (const [h, rec] of l.imports) {
        const dsts = want.get(byH.get(h));
        for (const d of rec.dsts) if (!dsts?.has(d)) { l.post(['dis', h, d]); rec.dsts.delete(d); }
        if (dsts) continue;
        l.post(['xinend', h]);
        l.inSlots.give(rec.slot);
        l.imports.delete(h);
      }
      for (const [n, dsts] of want) {
        let rec = l.imports.get(n.h);
        if (!rec) {
          const slot = l.inSlots.take();
          if (slot < 0) continue;
          l.imports.set(n.h, rec = { slot, dsts: new Set() });
          l.post(['xin', n.h, slot]);
        }
        for (const d of dsts) if (!rec.dsts.has(d)) { l.post(['con', n.h, d]); rec.dsts.add(d); }
        (n.taps ??= []).push({ io: l, slot: rec.slot });
      }
      const outs = new Set([...exp[w]].map((n) => n.h));
      for (const [h, slot] of l.exports) if (!outs.has(h)) { l.post(['xend', h]); l.outSlots.give(slot); l.exports.delete(h); }
      for (const n of exp[w]) {
        let slot = l.exports.get(n.h);
        if (slot === undefined) {
          slot = l.outSlots.take();
          if (slot < 0) continue;
          l.exports.set(n.h, slot);
          l.post(['xout', n.h, slot]);
        }
        n.stand = { io: l, slot };
      }
    });
  }
}

// back to the event loop once (worker only: the AudioWorklet scope has no MessageChannel)
let yieldOnce = () => {
  if (typeof setImmediate === 'function') yieldOnce = () => new Promise((r) => setImmediate(r));
  else {
    const ch = new MessageChannel();
    const waiting = [];
    ch.port1.onmessage = () => waiting.shift()?.();
    yieldOnce = () => new Promise((r) => { waiting.push(r); ch.port2.postMessage(0); });
  }
  return yieldOnce();
};

// Worker side: applies the op batches to its own Graph and renders it when kicked.
export class PoolWorker {
  constructor({ sab, port, graph, onError = null, budget = null }) {
    Object.assign(this, views(sab));
    this.budget = budget;
    this.graph = graph;
    this.onError = onError;
    this.seq = 0;
    this.ringNext = null;
    this.portQueue = [];
    this.block = 0;
    this.deadline = 0;
    this.late = false;
    this.L = new Float32Array(BLOCK);
    this.R = new Float32Array(BLOCK);
    port.onmessage = (e) => this.portQueue.push(e.data);
    port.start?.();
  }

  op(op) {
    const g = this.graph;
    switch (op[0]) {
      case 'xin': g.addStand(op[1], { io: this, slot: op[2] }); break;
      case 'xinend': g.remove(op[1]); break;
      case 'xout': g.setTaps(op[1], [{ io: this, slot: op[2] }]); break;
      case 'xend': g.setTaps(op[1], null); break;
      default: g.op(op);
    }
  }

  readRing() {
    const { ctrl, ring } = this;
    let p = ctrl[TAIL];
    if (p === Atomics.load(ctrl, HEAD)) return null;
    const w = [];
    for (let i = 0; i < 4; i++) { w.push(ring[p]); p = (p + 1) % RING; }
    const len = w[0] | (w[1] << 16);
    const seq = w[2] | (w[3] << 16);
    let str = '';
    for (let i = 0; i < len;) {
      const n = Math.min(len - i, 4096, RING - p);
      str += String.fromCharCode.apply(null, ring.subarray(p, p + n));
      p = (p + n) % RING;
      i += n;
    }
    Atomics.store(ctrl, TAIL, p);
    return [seq, str];
  }

  // applies batches up to `target`; false while one sent by MessagePort hasn't arrived yet
  apply(target) {
    while (this.seq < target) {
      const want = this.seq + 1;
      this.ringNext ??= this.readRing();
      let ops = null;
      if (this.ringNext?.[0] === want) { ops = JSON.parse(this.ringNext[1]); this.ringNext = null; }
      else if (this.portQueue[0]?.[0] === want) ops = this.portQueue.shift()[1];
      else return false;
      this.seq = want;
      for (const op of ops) {
        try { this.op(op); }
        catch (err) { this.onError?.(err); }
      }
    }
    return true;
  }

  render(block) {
    this.block = block;
    this.late = false;
    this.deadline = now() + (this.budget ?? budgetMs());
    try { this.graph.render(this.L, this.R); }
    catch (err) { this.onError?.(err); }
    Atomics.store(this.ctrl, DONE, block);
  }

  // one kick, if there is one: applies the ops and renders (used by run() and by tests)
  async step(timeout = 20) {
    const { ctrl } = this;
    if (Atomics.wait(ctrl, KICK, this.block, timeout) === 'timed-out') return false;
    const block = Atomics.load(ctrl, KICK);
    if (block === this.block) return false;
    while (!this.apply(Atomics.load(ctrl, SEQ))) await yieldOnce();
    this.render(block);
    return true;
  }

  async run() {
    Atomics.store(this.ctrl, READY, 1);
    for (;;) if (!(await this.step())) await yieldOnce(); // idle: let MessagePort batches in
  }

  // an import into outs; true if silent (not published in time)
  fetch(slot, [L, R]) {
    if (this.late || !await_(this.inStamp, slot, this.block, this.deadline)) { this.late = true; return true; }
    if (this.inSilent[slot]) return true;
    L.set(this.ins[slot][0]);
    R.set(this.ins[slot][1]);
    return false;
  }

  publish(slot, [L, R], silent) {
    if (!silent) { this.outs[slot][0].set(L); this.outs[slot][1].set(R); }
    this.outSilent[slot] = silent ? 1 : 0;
    Atomics.store(this.outStamp, slot, this.block);
  }
}
