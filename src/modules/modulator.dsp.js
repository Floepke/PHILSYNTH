// A carrier and the sum of all other inputs arrive separately (Graph handles the routing).
// PM is a causal variable delay; absolute PM uses |modulator| instead of a bipolar offset.
// Oversampling (2x / 4x): carrier and modulator are upsampled with half-band filters, combined at
// the higher rate (the PM delay line runs at that rate too) and filtered back down, so sum
// frequencies and sidebands above Nyquist are removed instead of folding back as inharmonic tones.
import { Kernel } from '../dsp/kernel.js';
import { Halfband, HALFBAND_STEEP, HALFBAND_LIGHT } from '../dsp/halfband.js';

const pcm = (x) => Math.max(-32768, Math.min(32767, Math.trunc(x * 32768)));

export default class ModulatorKernel extends Kernel {
  static carrierInput = true;

  constructor() {
    super();
    this.type = 0;
    this.carrier = 0;
    this.interpolation = 1;
    this.os = 1;
    // per channel: carrier / modulator upsampling, output downsampling; [0] steep (base rate), [1] light (2x)
    const stages = () => [new Halfband(HALFBAND_STEEP), new Halfband(HALFBAND_LIGHT)];
    this.filters = [0, 1].map(() => ({ c: stages(), m: stages(), y: stages() }));
    this.cu = new Float64Array(8); // oversampled carrier, modulator, output: [ch * 4 + j]
    this.mu = new Float64Array(8);
    this.yu = new Float64Array(8);
    this.resize();
  }

  // The PM history holds 40 ms at the (oversampled) processing rate.
  resize() {
    this.maxDelay = sampleRate * this.os * 0.04;
    this.size = Math.ceil(this.maxDelay) + 4;
    this.buffers = [new Float32Array(this.size), new Float32Array(this.size)];
    this.pos = 0;
    this.zeroRun = this.size;
  }

  param(id, value) {
    if (id === 'type') this.type = Math.max(0, Math.min(10, value | 0));
    else if (id === 'interpolation') this.interpolation = Math.max(0, Math.min(2, value | 0));
    else if (id === 'oversample') {
      const os = [1, 2, 4][Math.max(0, Math.min(2, value | 0))];
      if (os !== this.os) {
        this.os = os;
        this.resize();
        this.clearFilters();
      }
    }
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
    this.clearFilters();
  }

  clearFilters() {
    for (const f of this.filters) for (const list of [f.c, f.m, f.y]) for (const h of list) h.clear();
  }

  combine(ch, c, m) {
    switch (this.type) {
      case 0: return c * m;
      case 1: return this.read(ch, (Math.max(-1, Math.min(1, m)) + 1) * 0.5 * this.maxDelay);
      case 2: return this.read(ch, Math.min(1, Math.abs(m)) * this.maxDelay);
      case 3: return c + m;
      case 4: return c - m;
      case 5: return Math.min(c, m);
      case 6: return Math.max(c, m);
      case 7: return (pcm(c) & pcm(m)) / 32768;
      case 8: return (pcm(c) ^ pcm(m)) / 32768;
      case 9: return Math.abs(c) <= Math.abs(m) ? c : m;
      default: return Math.abs(c) >= Math.abs(m) ? c : m;
    }
  }

  // os samples of `v` into `to` from index `at`
  upsample(stages, v, to, at) {
    const [s1, s2] = stages;
    s1.up(v);
    if (this.os === 2) { to[at] = s1.a; to[at + 1] = s1.b; return; }
    const b = s1.b;
    s2.up(s1.a); to[at] = s2.a; to[at + 1] = s2.b;
    s2.up(b); to[at + 2] = s2.a; to[at + 3] = s2.b;
  }

  downsample(stages, from, at) {
    const [s1, s2] = stages;
    if (this.os === 2) return s1.down(from[at], from[at + 1]);
    const first = s2.down(from[at], from[at + 1]);
    return s1.down(first, s2.down(from[at + 2], from[at + 3]));
  }

  process(inputs, outputs) {
    const carrier = inputs[0];
    const mod = inputs[1];
    const out = outputs[0];
    const length = out[0].length;
    const phase = this.type === 1 || this.type === 2;
    // A fully overwritten history is empty even if a live modulator keeps changing the delay.
    if (!carrier?.length && this.zeroRun >= this.size && (phase || !mod?.length)) {
      this.pos = (this.pos + length * this.os) % this.size;
      if (this.os > 1) this.clearFilters();
      return false;
    }
    const cL = carrier?.[0], cR = carrier?.[1] ?? cL;
    const mL = mod?.[0], mR = mod?.[1] ?? mL;
    if (this.os > 1) return this.processOversampled(cL, cR, mL, mR, out, length);
    let live = false;
    for (let i = 0; i < length; i++) {
      let zero = true;
      for (let ch = 0; ch < 2; ch++) {
        const c = (ch ? cR : cL)?.[i] ?? 0;
        const m = (ch ? mR : mL)?.[i] ?? 0;
        if (c !== 0) zero = false;
        this.buffers[ch][this.pos] = c;
        const y = this.combine(ch, c, m);
        if (out[ch]) out[ch][i] = y;
        if (y !== 0) live = true;
      }
      this.zeroRun = zero ? Math.min(this.size, this.zeroRun + 1) : 0;
      if (++this.pos === this.size) this.pos = 0;
    }
    return live;
  }

  processOversampled(cL, cR, mL, mR, out, length) {
    const { os, cu, mu, yu, filters } = this;
    let live = false;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < 2; ch++) {
        this.upsample(filters[ch].c, (ch ? cR : cL)?.[i] ?? 0, cu, ch * 4);
        this.upsample(filters[ch].m, (ch ? mR : mL)?.[i] ?? 0, mu, ch * 4);
      }
      for (let j = 0; j < os; j++) {
        let zero = true;
        for (let ch = 0; ch < 2; ch++) {
          const c = cu[ch * 4 + j];
          if (c !== 0) zero = false;
          this.buffers[ch][this.pos] = c;
          yu[ch * 4 + j] = this.combine(ch, c, mu[ch * 4 + j]);
        }
        this.zeroRun = zero ? Math.min(this.size, this.zeroRun + 1) : 0;
        if (++this.pos === this.size) this.pos = 0;
      }
      for (let ch = 0; ch < 2; ch++) {
        const y = this.downsample(filters[ch].y, yu, ch * 4);
        if (out[ch]) out[ch][i] = y;
        if (y !== 0) live = true;
      }
    }
    for (const f of filters) for (const list of [f.c, f.m, f.y]) for (const h of list) h.flush();
    return live;
  }
}
