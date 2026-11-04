import { Kernel } from '../dsp/kernel.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fold = (x) => 1 - Math.abs(((x + 1) % 4 + 4) % 4 - 2);

export function distortionShape(x, type) {
  const a = Math.abs(x), sign = Math.sign(x);
  switch (type) {
    case 1: return clamp(x, -1, 1);
    case 2: return fold(x);
    case 3: return a <= 1 ? x : sign * fold(2 * a - 1);
    case 4: return sign * (1 - Math.abs(a % 2 - 1));
    case 5: return a <= 1 ? x : sign * (a % 1);
    case 6: return a <= 1 ? x : ((x + 1) % 2 + 2) % 2 - 1;
    case 7: return clamp(1.5 * x - 0.5 * x * x * x, -1, 1);
    case 8: return Math.sin(x);
    case 9: return sign * (1 - (1 - Math.min(a, 1)) ** 2);
    case 10: return x / Math.hypot(1, x);
    case 11: return x / (1 + a);
    default: return x;
  }
}

// Drive -> shape -> signed PCM quantization -> stereo-linked sample-and-hold.
// 16 bits bypasses quantization; 0 Hz bypasses the hold. No anti-alias filtering:
// the aliases are part of this effect, particularly at low bit depths / frequencies.
export default class DistortionKernel extends Kernel {
  constructor() {
    super();
    this.type = 1;
    this.bits = 16;
    this.rate = 1;
    this.targetPower = this.power = 1;
    this.smooth = 1 - Math.exp(-1 / (0.01 * sampleRate));
    this.held = [0, 0];
    this.phase = 1;
    this.started = false;
  }

  param(id, v) {
    if (id === 'type') this.type = clamp(Math.round(v), 0, 11);
    else if (id === 'power') this.targetPower = clamp(v, 0, 100);
    else if (id === 'bits') this.bits = clamp(Math.round(v), 1, 16);
    else if (id === 'frequency') {
      const rate = v <= 0 ? 1 : Math.min(clamp(v, 1, 48000) / sampleRate, 1);
      if (rate === 1 && this.rate < 1) this.phase = 1;
      this.rate = rate;
    }
  }

  panic() {
    this.held.fill(0);
    this.phase = 1;
    this.started = false;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const silent = !inp || !inp.length;
    if (!this.started) {
      if (silent) return false;
      this.power = this.targetPower;
      this.started = true;
    }
    const q = 2 ** (this.bits - 1);
    let live = false;
    for (let i = 0; i < out[0].length; i++) {
      this.power += (this.targetPower - this.power) * this.smooth;
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        for (let c = 0; c < 2; c++) {
          const x = silent ? 0 : (inp[c] ?? inp[0])[i];
          const y = distortionShape(x * this.power, this.type);
          this.held[c] = this.bits === 16 ? y : clamp(Math.floor(y * q + 0.5), -q, q - 1) / q;
        }
      }
      this.phase += this.rate;
      out[0][i] = this.held[0];
      out[1][i] = this.held[1];
      live ||= this.held[0] !== 0 || this.held[1] !== 0;
    }
    return live;
  }
}
