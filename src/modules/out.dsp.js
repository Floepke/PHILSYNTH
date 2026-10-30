// Output module kernel: sum of its inputs × Master volume (smoothed, no zipper noise).
import { Kernel } from '../dsp/kernel.js';

const SMOOTH_S = 0.01;

export default class OutKernel extends Kernel {
  static passive = true;

  constructor() {
    super();
    this.volume = 0.8;
    this.g = null; // smoothed gain (snaps to the first value)
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));
  }

  param(id, v) {
    if (id === 'volume') {
      this.volume = v;
      this.g ??= v;
    }
  }

  process(inputs, outputs) {
    const i = inputs[0];
    const [L, R] = outputs[0];
    if (!i || !i.length) return false;
    const a = i[0];
    const b = i[1] ?? a;
    const t = this.volume;
    const k = this.k;
    let g = this.g ?? t;
    for (let s = 0; s < L.length; s++) {
      g += (t - g) * k;
      L[s] = a[s] * g;
      R[s] = b[s] * g;
    }
    this.g = Math.abs(g - t) < 1e-6 ? t : g;
    return true;
  }
}
