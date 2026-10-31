// Microphones for the INPUT module. Each opened device is one MediaStreamSource connected to an
// input slot of the engine worklet (src/engine.worklet.js passes the worklet inputs to the graph,
// the INPUT kernel reads its slot). INPUT modules on the same device share one stream and slot.
// Browser audio processing (echo cancellation, noise suppression, auto gain) is switched off: a
// synth wants the plain signal.
//
//   devices                 [{ id, label }] audio inputs (labels appear once access is granted)
//   status                  'unknown' | 'ok' | 'none' (no microphone) | 'denied' | 'unsupported'
//   await refresh()         re-read the device list
//   await acquire(id)       open device id ('' = system default): its slot, or -1 when unavailable
//   release(id)             one user of device id less (closed when unused)
//   watch(fn) -> unwatch    fn() after the device list or status changed
export const MIC_SLOTS = 8;

const SKIP = new Set(['default', 'communications']); // Chrome's aliases of real devices

export class MicHub {
  constructor(ctx, node, slots = MIC_SLOTS) {
    this.ctx = ctx;
    this.node = node;
    this.slots = Array(slots).fill(null); // slot -> device id in use
    this.open = new Map(); // device id -> { slot, refs, stream, source, ready }
    this.devices = [];
    this.status = 'unknown';
    this.watchers = new Set();
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) this.status = 'unsupported';
    md?.addEventListener?.('devicechange', () => this.refresh());
  }

  watch(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  // a snapshot: a watcher may watch / unwatch (rebuild a panel) while being notified
  emit() { [...this.watchers].forEach((fn) => fn()); }

  // notify only when something changed: refresh() runs after every opened device
  changed() {
    const sig = `${this.status}\n${this.devices.map((d) => `${d.id}\t${d.label}`).join('\n')}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.emit();
  }

  async refresh() {
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.enumerateDevices) return;
    try {
      const all = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      this.devices = all.filter((d) => d.deviceId && !SKIP.has(d.deviceId))
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
      if (!all.length) this.status = 'none';
      else if (this.status === 'none') this.status = 'unknown';
    } catch {
      this.devices = [];
    }
    this.changed();
  }

  async acquire(id = '') {
    if (this.status === 'unsupported') return -1;
    let o = this.open.get(id);
    if (!o) {
      const slot = this.slots.indexOf(null);
      if (slot < 0) return -1;
      this.slots[slot] = id;
      o = { slot, refs: 0, stream: null, source: null };
      this.open.set(id, o);
      o.ready = this.start(id, o);
    }
    o.refs++;
    return (await o.ready) ? o.slot : -1;
  }

  async start(id, o) {
    try {
      o.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id ? { exact: id } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
      if (this.open.get(id) !== o) { this.stop(o); return false; } // released while asking
      o.source = this.ctx.createMediaStreamSource(o.stream);
      o.source.connect(this.node, 0, o.slot);
      this.status = 'ok';
      await this.refresh(); // labels are only readable after access was granted
      return true;
    } catch (err) {
      const name = err?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.status = 'denied';
      else if (name === 'NotFoundError' && !id) this.status = 'none';
      console.warn('Microphone unavailable:', err);
      if (this.open.get(id) === o) this.drop(id, o);
      if (!globalThis.navigator?.mediaDevices?.enumerateDevices) this.changed();
      await this.refresh();
      return false;
    }
  }

  release(id = '') {
    const o = this.open.get(id);
    if (!o || --o.refs > 0) return;
    this.drop(id, o);
  }

  drop(id, o) {
    this.open.delete(id);
    this.slots[o.slot] = null;
    this.stop(o);
  }

  stop(o) {
    try { o.source?.disconnect(); } catch { /* already gone */ }
    o.stream?.getTracks().forEach((t) => t.stop());
    o.source = null;
    o.stream = null;
  }
}
