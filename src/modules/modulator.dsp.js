// A carrier and the sum of all other inputs arrive separately (Graph handles the routing).
// PM is a causal variable delay; absolute PM uses |modulator| instead of a bipolar offset.
import { Kernel } from '../dsp/kernel.js';

const pcm = (x) => Math.max(-32768, Math.min(32767, Math.trunc(x * 32768)));

export default class ModulatorKernel extends Kernel {
  static carrierInput = true;

  constructor() {
    super();
    this.type = 0;
    this.carrier = 0;
    this.interpolation = 1;
    this.maxDelay = sampleRate * 0.04;
    this.size = Math.ceil(this.maxDelay) + 4;
    this.buffers = [new Float32Array(this.size), new Float32Array(this.size)];
    this.pos = 0;
    this.zeroRun = this.size;
  }

  param(id, value) {
    if (id === 'type') this.type = Math.max(0, Math.min(10, value | 0));
    else if (id === 'interpolation') this.interpolation = Math.max(0, Math.min(2, value | 0));
    else if (id === 'carrier') {
      const index = Math.max(0, value | 0);
      if (index !== this.carrier) {
        this.carrier = index;
        this.panic();
      }
    }
  }

  sample(ch, age) {
    const index = this.pos - age;
    return this.buffers[ch][index < 0 ? index + this.size : index];
  }

  read(ch, delay) {
    if (this.interpolation === 0) return this.sample(ch, Math.round(delay));
    const age = Math.floor(delay);
    const f = delay - age;
    const buffer = this.buffers[ch];
    let index = this.pos - age;
    if (index < 0) index += this.size;
    const a = buffer[index];
    const b = buffer[index === 0 ? this.size - 1 : index - 1];
    if (this.interpolation === 1) return a + (b - a) * f;
    // At zero delay the future sample is unavailable; extrapolate the end slope.
    const before = age > 0 ? buffer[index + 1 === this.size ? 0 : index + 1] : 2 * a - b;
    const after = buffer[index < 2 ? index + this.size - 2 : index - 2];
    return ((0.5 * (-before + 3 * a - 3 * b + after) * f
      + before - 2.5 * a + 2 * b - 0.5 * after) * f + 0.5 * (b - before)) * f + a;
  }

  panic() {
    for (const b of this.buffers) b.fill(0);
    this.zeroRun = this.size;
  }

  process(inputs, outputs) {
    const carrier = inputs[0];
    const mod = inputs[1];
    const out = outputs[0];
    const length = out[0].length;
    const phase = this.type === 1 || this.type === 2;
    // A fully overwritten history is empty even if a live modulator keeps changing the delay.
    if (!carrier?.length && this.zeroRun >= this.size && (phase || !mod?.length)) {
      this.pos = (this.pos + length) % this.size;
      return false;
    }
    const cL = carrier?.[0], cR = carrier?.[1] ?? cL;
    const mL = mod?.[0], mR = mod?.[1] ?? mL;
    let live = false;
    for (let i = 0; i < length; i++) {
      let zero = true;
      for (let ch = 0; ch < 2; ch++) {
        const c = (ch ? cR : cL)?.[i] ?? 0;
        const m = (ch ? mR : mL)?.[i] ?? 0;
        if (c !== 0) zero = false;
        this.buffers[ch][this.pos] = c;
        let y;
        switch (this.type) {
          case 0: y = c * m; break;
          case 1: y = this.read(ch, (Math.max(-1, Math.min(1, m)) + 1) * 0.5 * this.maxDelay); break;
          case 2: y = this.read(ch, Math.min(1, Math.abs(m)) * this.maxDelay); break;
          case 3: y = c + m; break;
          case 4: y = c - m; break;
          case 5: y = Math.min(c, m); break;
          case 6: y = Math.max(c, m); break;
          case 7: y = (pcm(c) & pcm(m)) / 32768; break;
          case 8: y = (pcm(c) ^ pcm(m)) / 32768; break;
          case 9: y = Math.abs(c) <= Math.abs(m) ? c : m; break;
          case 10: y = Math.abs(c) >= Math.abs(m) ? c : m; break;
        }
        if (out[ch]) out[ch][i] = y;
        if (y !== 0) live = true;
      }
      this.zeroRun = zero ? Math.min(this.size, this.zeroRun + 1) : 0;
      if (++this.pos === this.size) this.pos = 0;
    }
    return live;
  }
}
