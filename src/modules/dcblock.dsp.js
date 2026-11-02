// DC BLOCKER kernel: per channel the one-pole high-pass y[n] = x[n] - x[n-1] + R·y[n-1] with a
// fixed CUTOFF_HZ corner: an offset (e.g. a constant 1) glides back to zero (99 % in
// ln(100) / (2π·CUTOFF_HZ) ≈ 37 ms), without a jump. C++ twin: cpp/basic.h DcBlock (same
// operations, same samples).
// Not passive: the filter has memory. A silent input (a source reporting a silent block, e.g. a
// half sine's zero half through a MODULATOR) is filtered as zeros, so the correction it was
// applying fades out instead of being cut to 0 (a click). It reports silence again once both
// channels have settled below SETTLE.
import { Kernel } from '../dsp/kernel.js';

export const CUTOFF_HZ = 20;
const SETTLE = 1e-6;
const ZERO = new Float32Array(0);

export default class DcBlockKernel extends Kernel {
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
    const silent = !i || !i.length;
    if (silent && !this.x1[0] && !this.x1[1] && !this.y1[0] && !this.y1[1]) return false;
    const r = this.r;
    for (let c = 0; c < 2; c++) {
      const src = silent ? ZERO : i[c] ?? i[0]; // mono is upmixed
      const dst = o[c];
      let x1 = this.x1[c];
      let y1 = this.y1[c];
      for (let s = 0; s < dst.length; s++) {
        const x = silent ? 0 : src[s];
        y1 = x - x1 + r * y1;
        x1 = x;
        dst[s] = y1;
      }
      this.x1[c] = x1;
      this.y1[c] = Math.abs(y1) < 1e-20 ? 0 : y1; // no denormals
    }
    if (silent && Math.abs(this.y1[0]) < SETTLE && Math.abs(this.y1[1]) < SETTLE) {
      this.y1 = [0, 0];
      return false;
    }
    return true;
  }
}
