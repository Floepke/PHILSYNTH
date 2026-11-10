import { ANALYSIS_SIZE } from './dsp/analysis.js';

export const dbFS = value => value > 0 ? 20 * Math.log10(value) : -Infinity;

export class Spectrum {
  constructor() {
    const n = ANALYSIS_SIZE;
    this.real = new Float64Array(n);
    this.imag = new Float64Array(n);
    this.power = new Float64Array(n / 2);
    this.levels = new Float32Array(n / 2);
    this.window = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  }

  measure(samples) {
    const n = ANALYSIS_SIZE;
    const { real, imag, power, levels, window } = this;
    power.fill(0);
    for (let channel = 0; channel < 2; channel++) {
      imag.fill(0);
      for (let i = 0; i < n; i++) real[i] = samples[channel * n + i] * window[i];
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) [real[i], real[j]] = [real[j], real[i]];
      }
      for (let size = 2; size <= n; size *= 2) {
        const angle = -2 * Math.PI / size;
        const wr = Math.cos(angle), wi = Math.sin(angle);
        for (let start = 0; start < n; start += size) {
          let ur = 1, ui = 0;
          for (let j = 0; j < size / 2; j++) {
            const a = start + j, b = a + size / 2;
            const tr = ur * real[b] - ui * imag[b];
            const ti = ur * imag[b] + ui * real[b];
            real[b] = real[a] - tr;
            imag[b] = imag[a] - ti;
            real[a] += tr;
            imag[a] += ti;
            const next = ur * wr - ui * wi;
            ui = ur * wi + ui * wr;
            ur = next;
          }
        }
      }
      // Hann coherent gain = 1/2; combine channel energies, never L+R (which can cancel).
      for (let i = 0; i < power.length; i++) power[i] += (real[i] ** 2 + imag[i] ** 2) * (i ? 16 : 4) / (n * n * 2);
    }
    for (let i = 0; i < levels.length; i++) levels[i] = power[i] > 0 ? 10 * Math.log10(power[i]) : -Infinity;
    return levels;
  }
}
