// DC BLOCKER kernel: per channel the one-pole high-pass y[n] = x[n] - x[n-1] + R·y[n-1] with a
// ~10 Hz corner, so offsets are removed while the audible range passes unchanged. C++ twin:
// cpp/basic.h DcBlock (same operations, same samples).
import { Kernel } from '../dsp/kernel.js';

export const CUTOFF_HZ = 10;

export default class DcBlockKernel extends Kernel {
  static passive = true;

  constructor() {
    super();
    this.r = Math.exp((-2 * Math.PI * CUTOFF_HZ) / sampleRate);
    this.x1 = [0, 0];
    this.y1 = [0, 0];
  }

  panic() { this.x1 = [0, 0]; this.y1 = [0, 0]; }

  process(inputs, outputs) {
    const i = inputs[0];
    const o = outputs[0];
    if (!i || !i.length) return false;
    const r = this.r;
    for (let c = 0; c < 2; c++) {
      const src = i[c] ?? i[0]; // mono is upmixed
      const dst = o[c];
      let x1 = this.x1[c];
      let y1 = this.y1[c];
      for (let s = 0; s < dst.length; s++) {
        const x = src[s];
        y1 = x - x1 + r * y1;
        x1 = x;
        dst[s] = y1;
      }
      this.x1[c] = x1;
      this.y1[c] = Math.abs(y1) < 1e-20 ? 0 : y1; // no denormals
    }
    return true;
  }
}
