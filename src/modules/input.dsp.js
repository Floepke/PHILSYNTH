// INPUT: plays a microphone. The main thread opens the device (src/mics.js) and tells the kernel
// which input slot of the engine worklet carries it ({ type: 'slot', slot }, -1 = none).
// meter: peak level in dBFS (falls 20 dB/s), after Gain.
import { Kernel } from '../dsp/kernel.js';

export const CHANNELS = ['Stereo', 'Left', 'Right', 'Mono'];
export const METER_FLOOR = -90;
const FALL_DB_PER_S = 20;

export default class InputKernel extends Kernel {
  static external = true;
  static meter = true;

  constructor() {
    super();
    this.graph = null; // set by the graph (static external)
    this.slot = -1;
    this.gain = 1;
    this.channel = 0;
    this.peak = 0;
    this.meter = METER_FLOOR;
  }

  message(m) {
    if (m.type === 'slot') this.slot = Number.isInteger(m.slot) ? m.slot : -1;
    else super.message(m);
  }

  param(id, v) {
    if (id === 'gain') this.gain = Math.pow(10, v / 20);
    else if (id === 'channel') this.channel = Math.max(0, Math.min(CHANNELS.length - 1, v | 0));
  }

  process(_inputs, outputs) {
    const src = this.slot >= 0 ? this.graph?.ext?.[this.slot] : null;
    const n = outputs[0][0].length;
    this.peak *= Math.pow(10, -FALL_DB_PER_S * (n / sampleRate) / 20);
    if (!src?.length) {
      this.meter = this.peak > 1e-5 ? 20 * Math.log10(this.peak) : METER_FLOOR;
      return false;
    }
    const [L, R] = outputs[0];
    const a = src[0];
    const b = src[1] ?? src[0];
    const g = this.gain;
    const c = this.channel;
    let pk = 0;
    for (let i = 0; i < n; i++) {
      let l = a[i];
      let r = b[i];
      if (c === 1) r = l;
      else if (c === 2) l = r;
      else if (c === 3) l = r = 0.5 * (l + r);
      l *= g;
      r *= g;
      L[i] = l;
      R[i] = r;
      const m = Math.max(Math.abs(l), Math.abs(r));
      if (m > pk) pk = m;
    }
    if (pk > this.peak) this.peak = pk;
    this.meter = this.peak > 1e-5 ? Math.max(METER_FLOOR, 20 * Math.log10(this.peak)) : METER_FLOOR;
    return true;
  }
}
