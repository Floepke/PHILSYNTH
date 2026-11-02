// SOUND2CTL kernel: audio voltage -> controller value (0..1, the graph maps it onto Out Min..Out Max).
// The graph applies controllers once per render quantum (128 samples, ~375 Hz at 48 kHz).
//   rate (Audio Rate, Hz): how often a new target is sampled from the input. A phase accumulator
//     ticks per sample; the target is the (stereo-averaged, clamped) sample at the last tick inside
//     the block. At the maximum every sample ticks, so it is the block's last sample, as before.
//   smooth (0..100 %): glide to each new target over smooth × the sampling period (linear, from the
//     current value). 0 jumps; 100 % arrives just as the next target is sampled.
import { Kernel } from '../dsp/kernel.js';

export const RATE_MAX = 48000;
const BLOCK = 128;

export default class Sound2CtlKernel extends Kernel {
  static modulator = true;
  static audioInput = true;

  constructor() {
    super();
    this.value = 0.5;
    this.rate = RATE_MAX;
    this.smooth = 0;
    this.phase = 1; // the first sample takes a target right away
    this.target = 0.5;
    this.step = 0; // glide per block towards target
    this.left = 0; // blocks until the glide arrives (0 = there)
  }

  param(id, v) {
    if (id === 'rate') this.rate = Math.max(1e-3, +v || 0);
    else if (id === 'smooth') this.smooth = Math.min(100, Math.max(0, +v || 0));
  }

  process(inputs) {
    const [left, right = left] = inputs[0];
    const inc = this.rate / sampleRate;
    let at = -1; // index of the last tick in this block
    let phase = this.phase;
    for (let i = 0; i < BLOCK; i++) {
      if (phase >= 1) { phase -= Math.floor(phase); at = i; }
      phase += inc;
    }
    this.phase = phase;
    if (at >= 0) {
      const voltage = left?.length ? 0.5 * (left[at] + right[at]) : 0;
      this.target = (Math.max(-1, Math.min(1, voltage)) + 1) * 0.5;
      const blocks = (this.smooth / 100) * (sampleRate / this.rate) / BLOCK; // glide length in blocks
      if (blocks > 1) { this.step = (this.target - this.value) / blocks; this.left = Math.ceil(blocks); }
      else this.left = 0;
    }
    if (this.left > 0) this.value = --this.left === 0 ? this.target : this.value + this.step;
    else this.value = this.target;
    return false; // control output only; never pass sound to the destination
  }
}
