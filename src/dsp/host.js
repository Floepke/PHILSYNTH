// Main-thread side of the DSP engine. Modules create nodes here instead of Web Audio nodes;
// every call becomes a message for the engine graph (src/dsp/graph.js) running in the single
// engine AudioWorklet. Messages are batched per microtask (one postMessage per event-loop task).
//
// DspNode mimics the bit of AudioNode the patch code uses: connect(node) / disconnect(node?)
// (`out` mirrors the connections), plus:
//   inputs               incoming sources in connection order (for carrier selectors)
//   send(message)        message for the node's kernel (port.postMessage, as before the engine)
//   param(id, value)     = send({ type: 'param', id, value })
//   routes(list)         modulators: the controllers they drive (see Graph.setRoutes)
//   onMod(id, value)     set by the patch: a modulated controller of this node changed
//   onMeter(value)       the kernel's meter changed (kernels with static meter = true)
//   destroy()
export class DspNode {
  constructor(host, h) {
    this.host = host;
    this.h = h;
    this.out = new Set();
    this.inputs = new Set(); // incoming audio sources, in cable connection order
    this.onMod = null;
    this.onMeter = null;
    this.dead = false;
    this.port = { postMessage: (m) => host.post(['msg', h, m]) };
  }

  connect(node) {
    if (!this.out.has(node)) {
      this.out.add(node);
      node.inputs.add(this);
      this.host.post(['con', this.h, node.h]);
    }
    return node;
  }

  disconnect(node) {
    if (node) {
      if (this.out.delete(node)) {
        node.inputs.delete(this);
        this.host.post(['dis', this.h, node.h]);
      }
      return;
    }
    for (const n of this.out) {
      n.inputs.delete(this);
      this.host.post(['dis', this.h, n.h]);
    }
    this.out.clear();
  }

  send(m) { this.port.postMessage(m); }

  param(id, value) { this.send({ type: 'param', id, value }); }

  routes(list) { this.host.post(['routes', this.h, list]); }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    for (const n of this.out) n.inputs.delete(this);
    for (const n of this.inputs) n.out.delete(this);
    this.out.clear();
    this.inputs.clear();
    this.onMod = null;
    this.onMeter = null;
    this.host.nodes.delete(this.h);
    this.host.post(['del', this.h]);
  }
}

export class DspHost {
  // port: the engine AudioWorkletNode's port (or a test double). sync: post every message at once.
  constructor(port, { sync = false } = {}) {
    this.port = port;
    this.sync = sync;
    this.nodes = new Map();
    this.next = 1;
    this.queue = [];
    this.scheduled = false;
    this.clocks = new Set();
    this.onError = null; // fn(message): a kernel threw on the audio thread
    this.onScope = null; // fn({ h, n, v }): cable scope points (src/cablescope.js)
    this.destination = new DspNode(this, 0); // master bus = the worklet's output
    this.nodes.set(0, this.destination);
    port.onmessage = (e) => this.receive(e.data);
  }

  create(kind, opts = null) {
    const node = new DspNode(this, this.next++);
    this.nodes.set(node.h, node);
    this.post(['add', node.h, kind, opts]);
    return node;
  }

  post(op) {
    this.queue.push(op);
    if (this.sync) this.flush();
    else if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush() {
    this.scheduled = false;
    if (!this.queue.length) return;
    const q = this.queue;
    this.queue = [];
    this.port.postMessage(q);
  }

  // fn(audioTime) about every 5 ms while subscribed (the audio clock keeps running in background
  // tabs, unlike main-thread timers). Returns the unsubscribe function.
  onClock(fn) {
    this.clocks.add(fn);
    if (this.clocks.size === 1) this.post(['clock', true]);
    return () => {
      if (this.clocks.delete(fn) && !this.clocks.size) this.post(['clock', false]);
    };
  }

  // MIDI/audio panic on the audio thread (see Graph.panic).
  panic() { this.post(['panic']); }

  // Cable display: the graph reports the output of these nodes (see Graph.scope) to onScope.
  scope(handles) { this.post(['scope', handles]); }

  // report from the graph: { time, mods: [handle, controller id, value, ...], scope?, meters?: [handle, value, ...] }
  receive(r) {
    if (!r) return;
    if (r.error) { this.onError?.(r.error); return; }
    if (r.info) { this.onInfo?.(r.info); return; }
    if (r.scope) this.onScope?.(r.scope);
    const m = r.mods;
    if (m) for (let i = 0; i < m.length; i += 3) this.nodes.get(m[i])?.onMod?.(m[i + 1], m[i + 2]);
    const v = r.meters;
    if (v) for (let i = 0; i < v.length; i += 2) this.nodes.get(v[i])?.onMeter?.(v[i + 1]);
    if (r.time !== undefined) for (const fn of this.clocks) fn(r.time);
  }
}
