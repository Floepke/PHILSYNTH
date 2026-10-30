// AMP kernel: gain (Amplification × ±1 for Inverse) and balance panning, all smoothed.
import { Kernel } from '../dsp/kernel.js';

const SMOOTH_S = 0.005; // avoids zipper noise and clicks when sliders move

// balance law: center leaves both channels untouched, panning fades the other side out
export const panGains = (pan) => [Math.min(1, 1 - pan), Math.min(1, 1 + pan)];

export default class AmpKernel extends Kernel {
  static passive = true;

  constructor() {
    super();
    this.amp = 1;
    this.inverse = 0;
    this.pan = 0;
    this.t = [1, 1]; // target L/R gains
    this.g = [1, 1]; // smoothed
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));
  }

  param(id, v) {
    if (id === 'amp' || id === 'inverse' || id === 'pan') this[id] = v;
    else return;
    const a = this.amp * (this.inverse >= 0.5 ? -1 : 1);
    const [l, r] = panGains(this.pan);
    this.t = [a * l, a * r];
  }

  process(inputs, outputs) {
    const i = inputs[0];
    const o = outputs[0];
    if (!i || !i.length) return false;
    const k = this.k;
    for (let c = 0; c < 2; c++) {
      const src = i[c] ?? i[0]; // mono is upmixed
      const dst = o[c];
      const t = this.t[c];
      let g = this.g[c];
      if (g === t) for (let s = 0; s < dst.length; s++) dst[s] = src[s] * g;
      else {
        for (let s = 0; s < dst.length; s++) { g += (t - g) * k; dst[s] = src[s] * g; }
        this.g[c] = Math.abs(g - t) < 1e-6 ? t : g;
      }
    }
    return true;
  }
}
