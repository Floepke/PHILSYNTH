// EQ kernel: 16-band graphic equalizer. Each band is an RBJ peaking biquad (transposed direct
// form II) at a fixed frequency, all with the same Q; bands at 0 dB are skipped. Gains glide per
// render quantum (no zipper noise); the output Level glides linearly inside the quantum.
// After the input stops the filters ring out, then the kernel reports silence.
// C++ twin: cpp/eq.h (same operations, same samples).
import { Kernel } from '../dsp/kernel.js';

// nominal centre frequencies, 2/3 octave apart
export const BANDS = [20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500, 20000];
export const MAX_DB = 12;
const GLIDE_S = 0.02; // gain glide time constant
const SILENT = 1e-6; // ring-out ends below this

// Peaking EQ coefficients [b0, b1, b2, a1, a2] (normalised by a0). The frequency is kept below
// Nyquist so the top band still works at 44.1 kHz.
export function peaking(f, db, q, sr) {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * Math.min(f, 0.45 * sr)) / sr;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const a0 = 1 + al / A;
  return [(1 + al * A) / a0, (-2 * cs) / a0, (1 - al * A) / a0, (-2 * cs) / a0, (1 - al / A) / a0];
}

// Magnitude in dB of the whole EQ at frequency f (for the panel display).
export function responseDb(gains, q, level, f, sr = 48000) {
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let db = level;
  for (let i = 0; i < BANDS.length; i++) {
    if (!gains[i]) continue;
    const [b0, b1, b2, a1, a2] = peaking(BANDS[i], gains[i], q, sr);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
    db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return db;
}

export default class EqKernel extends Kernel {
  constructor() {
    super();
    const n = BANDS.length;
    this.t = new Float64Array(n); // target gains (dB)
    this.g = new Float64Array(n); // current (gliding) gains
    this.c = new Float64Array(n * 5); // coefficients per band
    this.z = new Float64Array(n * 4); // state per band: z1 L, z2 L, z1 R, z2 R
    this.q = 2.1;
    this.level = 0; // dB target
    this.lv = 0; // dB current
    this.dirty = true; // recompute every band's coefficients
    this.live = false; // filter state may be non-zero
    this.zero = [new Float32Array(128), new Float32Array(128)];
  }

  param(id, v) {
    if (id === 'q') { if (v !== this.q) { this.q = v; this.dirty = true; } return; }
    if (id === 'level') { this.level = v; return; }
    if (id[0] === 'b') {
      const i = +id.slice(1);
      if (i >= 0 && i < BANDS.length) this.t[i] = v;
    }
  }

  // one render quantum's glide; recomputes the coefficients of the bands that moved
  glide(n) {
    const k = 1 - Math.exp(-n / (GLIDE_S * sampleRate));
    for (let i = 0; i < BANDS.length; i++) {
      const t = this.t[i];
      let g = this.g[i];
      const moved = g !== t;
      if (moved) {
        g += (t - g) * k;
        if (Math.abs(t - g) < 0.01) g = t;
        this.g[i] = g;
      }
      if (moved || this.dirty) {
        const cf = peaking(BANDS[i], g, this.q, sampleRate);
        for (let j = 0; j < 5; j++) this.c[i * 5 + j] = cf[j];
      }
      if (g === 0) this.z.fill(0, i * 4, i * 4 + 4); // skipped: start clean when it comes back
    }
    this.dirty = false;
  }

  panic() { this.z.fill(0); this.live = false; }

  process(inputs, outputs) {
    const inp = inputs[0];
    const o = outputs[0];
    const n = o[0].length;
    let src = inp;
    if (!inp || !inp.length) {
      if (!this.live) return false;
      if (this.zero[0].length !== n) this.zero = [new Float32Array(n), new Float32Array(n)];
      src = this.zero; // ring out
    }
    this.glide(n);
    const from = Math.pow(10, this.lv / 20);
    let lv = this.lv;
    if (lv !== this.level) {
      lv += (this.level - lv) * (1 - Math.exp(-n / (GLIDE_S * sampleRate)));
      if (Math.abs(this.level - lv) < 0.01) lv = this.level;
      this.lv = lv;
    }
    const to = Math.pow(10, lv / 20);
    const step = (to - from) / n;
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const s = src[ch] ?? src[0]; // mono is upmixed
      const d = o[ch];
      d.set(s);
      for (let b = 0; b < BANDS.length; b++) {
        if (this.g[b] === 0) continue;
        const c = this.c;
        const b0 = c[b * 5], b1 = c[b * 5 + 1], b2 = c[b * 5 + 2], a1 = c[b * 5 + 3], a2 = c[b * 5 + 4];
        const zi = b * 4 + ch * 2;
        let z1 = this.z[zi], z2 = this.z[zi + 1];
        for (let i = 0; i < n; i++) {
          const x = d[i];
          const y = b0 * x + z1;
          z1 = b1 * x - a1 * y + z2;
          z2 = b2 * x - a2 * y;
          d[i] = y;
        }
        this.z[zi] = Math.abs(z1) < 1e-20 ? 0 : z1;
        this.z[zi + 1] = Math.abs(z2) < 1e-20 ? 0 : z2;
      }
      for (let i = 0; i < n; i++) {
        const y = d[i] * (from + step * (i + 1));
        d[i] = y;
        const a = Math.abs(y);
        if (a > peak) peak = a;
      }
    }
    if (src === this.zero && peak < SILENT) {
      this.z.fill(0);
      this.live = false;
      return false;
    }
    this.live = true;
    return true;
  }
}
