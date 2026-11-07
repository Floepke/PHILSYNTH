// FEEDBACK kernel: output = input × FEEDBACK (0..1, smoothed per sample), limited to ±LIMIT.
// The limit keeps a runaway loop (loop gain above 1) bounded instead of growing to Infinity/NaN,
// which would break every module it reaches. At FEEDBACK 0 it reports silence, so a loop whose
// FEEDBACK modules are all at 0 is silent. C++ twin: cpp/basic.h Feedback (same operations).
// Values below TINY (-300 dB) become 0, so a dying loop reaches true silence (instead of
// circling denormals forever) and reports it: an output of only zeros is silence.
// Passive (memoryless): skipped while its inputs are silent. The gain snaps per sample, so a
// block rendered in one call or sample by sample (inside a loop, see src/dsp/graph.js) is equal.
import { Kernel } from '../dsp/kernel.js';

const SMOOTH_S = 0.005;
export const LIMIT = 2;
const TINY = 1e-15;

const limit = (y) => (y > LIMIT ? LIMIT : y < -LIMIT ? -LIMIT : y > TINY || y < -TINY ? y : 0);

export default class FeedbackKernel extends Kernel {
  static passive = true;

  constructor() {
    super();
    this.t = 0; // target gain
    this.g = 0; // smoothed gain
    this.started = false; // the first sound (after load / panic) starts at the target
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));
  }

  panic() { this.started = false; }

  param(id, v) {
    if (id === 'feedback') this.t = Math.max(0, Math.min(1, +v || 0));
  }

  process(inputs, outputs) {
    const i = inputs[0];
    const o = outputs[0];
    if (!i || !i.length) return false;
    if (!this.started) { this.g = this.t; this.started = true; }
    const t = this.t;
    if (t === 0 && this.g === 0) return false;
    const k = this.k;
    const L = i[0];
    const R = i[1] ?? L; // mono is upmixed
    const oL = o[0];
    const oR = o[1];
    let g = this.g;
    let live = false;
    for (let s = 0; s < oL.length; s++) {
      if (g !== t) {
        g += (t - g) * k;
        if (Math.abs(g - t) < 1e-6) g = t;
      }
      const l = (oL[s] = limit(L[s] * g));
      const r = oR ? (oR[s] = limit(R[s] * g)) : 0;
      if (l !== 0 || r !== 0) live = true;
    }
    this.g = g;
    return live;
  }
}
