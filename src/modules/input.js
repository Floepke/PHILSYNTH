// INPUT: a microphone (or any audio input of the computer) as a sound source. DSP: input.dsp.js;
// the device is opened on the main thread by the engine's MicHub (src/mics.js).
// Microphone 0 = the system default device, k = the k-th device of the list. The list (and the
// device names) only becomes known once the browser / OS granted microphone access.
// Offline renders (WAV export) have no microphones: the module is silent there.
import { CHANNELS, METER_FLOOR } from './input.dsp.js';
import { createMeter } from './meter.js';

const STATUS = {
  unsupported: 'Microphones not supported here',
  none: 'No microphone found',
  denied: 'Microphone access denied',
};

export default {
  type: 'INPUT',
  color: '#8fbf6a',
  label: 'Input (microphone)',
  acceptsMidi: false,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'mic', label: 'Microphone', min: 0, max: 0, default: 0, step: 1, format: (v) => (v ? `Microphone ${v}` : 'System default') },
    { id: 'gain', label: 'Gain', min: -24, max: 24, default: 0, step: 0.1, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
    { id: 'channel', label: 'Channels', min: 0, max: CHANNELS.length - 1, default: 0, step: 1, options: CHANNELS },
  ],
  view(entry, api) {
    const inst = entry.inst;
    const el = document.createElement('div');
    el.className = 'input-view';
    const info = document.createElement('p');
    info.className = 'hint input-status';
    const meter = createMeter({
      label: 'Level', min: METER_FLOOR, max: 0, color: api.color,
      text: (v) => (v <= METER_FLOOR ? '-∞ dB' : `${v.toFixed(1)} dB`),
    });
    el.append(meter.el, info);
    const show = () => {
      info.textContent = inst.statusText();
      info.classList.toggle('error', inst.status() !== 'ok' && inst.status() !== 'unknown');
    };
    show();
    inst.onLevel = (v) => meter.set(v);
    inst.onStatus = show;
    meter.set(inst.level);
    // the Microphone list changed: rebuild the panel for the new controller range (later, not
    // inside the notification: the new panel watches again)
    const devices = () => (inst.devices?.() ?? []).map((d) => d.label).join('\n');
    const shown = devices();
    const unwatch = inst.watch(() => {
      show();
      if (devices() === shown) return;
      unwatch();
      setTimeout(() => { if (el.isConnected) api.rebuild?.(); });
    });
    return { el, refresh: show };
  },
  create(_ctx, def, host) {
    const node = host.dsp.create('input');
    const mics = host.mics;
    let entry = null;
    let want; // device id asked for ('' = default, null = not in the list (yet))
    let held = null; // device id currently open
    let token = 0;
    let dead = false;
    const inst = {
      node,
      level: METER_FLOOR,
      onLevel: null,
      onStatus: null,
      attach(e) { entry = e; },
      status: () => mics?.status ?? 'unsupported',
      statusText() {
        const s = inst.status();
        if (STATUS[s]) return STATUS[s];
        if (s === 'unknown') return 'Waiting for microphone access…';
        if (mics.open.size >= mics.slots.length && held === null) return `All ${mics.slots.length} microphone slots are in use`;
        return held === null ? 'Microphone not connected' : 'Listening';
      },
      deviceName(v) {
        const s = inst.status();
        if (STATUS[s]) return STATUS[s];
        if (!v) return 'System default';
        const d = mics.devices[v - 1];
        return d ? d.label : s === 'ok' ? `Microphone ${v} (not connected)` : `Microphone ${v}`;
      },
      params() {
        return def.params.map((p) => p.id !== 'mic' ? p : {
          ...p,
          max: Math.max(0, mics?.devices.length ?? 0, entry?.values.mic | 0),
          format: (v) => inst.deviceName(v),
        });
      },
      devices: () => mics?.devices ?? [],
      watch: (fn) => mics?.watch(fn) ?? (() => {}),
      setParam(id, v) {
        if (id === 'mic') select(v);
        else node.param(id, v);
      },
      destroy() {
        dead = true;
        unwatch();
        token++;
        if (held !== null) mics.release(held);
        held = null;
        node.destroy();
      },
    };
    node.onMeter = (v) => { inst.level = v; inst.onLevel?.(v); };

    function select(v) {
      if (!mics || dead) return;
      const id = !v ? '' : mics.devices[v - 1]?.id ?? null;
      if (id === want) return;
      want = id;
      if (id !== null && id === held) return; // still the open device
      const t = ++token;
      if (held !== null) {
        mics.release(held);
        held = null;
        node.send({ type: 'slot', slot: -1 });
      }
      if (id === null) {
        if (mics.status === 'unknown') mics.acquire('').then((s) => { if (s >= 0) mics.release(''); }); // ask for access: the list gets its devices
        return;
      }
      mics.acquire(id).then((slot) => {
        if (slot < 0) { inst.onStatus?.(); return; } // tried again when the device list changes
        if (t !== token || dead) { mics.release(id); return; }
        held = id;
        node.send({ type: 'slot', slot });
        inst.onStatus?.();
      });
    }
    // the device list changed (plugged in / out, access granted): follow the chosen entry
    let list = '';
    const unwatch = mics?.watch(() => {
      const ids = mics.devices.map((d) => d.id).join('\n');
      if (ids !== list) { list = ids; want = undefined; } // a failed device may be back: try again
      if (entry) select(entry.values.mic);
    }) ?? (() => {});
    return inst;
  },
};
