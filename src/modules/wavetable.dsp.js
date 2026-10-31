// WAVETABLE DSP kernel (audio thread). A wavetable is a row of single-cycle waveforms ("frames")
// of Block Size samples each, back to back in one mono buffer (the Serum / Vital / Bitwig layout;
// 2048 samples per frame is the common standard, WaveEdit uses 256, Surge stores the size in its
// .wt header). Wave Select (0..100 %) scans through the frames and crossfades between the two
// neighbouring ones, so sweeping it (e.g. with an LFO) morphs smoothly instead of stepping.
// Anti-aliasing: every frame is turned into a set of band-limited copies (mipmaps, one per octave,
// made with an FFT the first time the frame plays); a note reads the copy whose highest harmonic
// stays below Nyquist, so high notes do not alias. Interpolation reads between table samples.
// The table arrives from the main thread: { type: 'table', data: Float32Array | null, frame };
// null = the built-in table (sine -> triangle -> saw -> square).
import { PolyKernel, envTick } from './poly.dsp.js';
import { readWrapped } from './interp.js';
import { fft, nextPow2 } from './fft.js';

export const BLOCK_SIZES = [0, 256, 512, 1024, 2048, 4096]; // 0 = Auto (from the file)
export const BLOCK_NAMES = BLOCK_SIZES.map((s) => (s ? String(s) : 'Auto'));
export const DEFAULT_FRAME = 2048;
const SMOOTH_S = 0.01;

// ---- built-in table: 64 frames morphing sine -> triangle -> saw -> square (band-limited) ----
const BUILTIN_FRAMES = 64;
const KEYS = [
  (_k) => (_k === 1 ? 1 : 0), // sine
  (k) => (k % 2 ? ((8 / (Math.PI * Math.PI)) * (((k - 1) / 2) % 2 ? -1 : 1)) / (k * k) : 0), // triangle
  (k) => ((2 / Math.PI) * (k % 2 ? 1 : -1)) / k, // saw
  (k) => (k % 2 ? 4 / (Math.PI * k) : 0), // square
];
let builtin = null;
export function builtinTable() {
  if (builtin) return builtin;
  const M = DEFAULT_FRAME;
  const data = new Float32Array(M * BUILTIN_FRAMES);
  const re = new Float64Array(M);
  const im = new Float64Array(M);
  for (let f = 0; f < BUILTIN_FRAMES; f++) {
    const x = (f / (BUILTIN_FRAMES - 1)) * (KEYS.length - 1);
    const a = Math.min(KEYS.length - 2, Math.floor(x));
    const t = x - a;
    re.fill(0);
    im.fill(0);
    for (let k = 1; k < M / 2; k++) {
      const b = KEYS[a](k) * (1 - t) + KEYS[a + 1](k) * t; // sine series: x = sum b_k sin(2 pi k n / M)
      im[k] = (-b * M) / 2;
      im[M - k] = (b * M) / 2;
    }
    fft(re, im, true);
    let peak = 1e-9;
    for (let i = 0; i < M; i++) peak = Math.max(peak, Math.abs(re[i]));
    for (let i = 0; i < M; i++) data[f * M + i] = (0.9 * re[i]) / peak;
  }
  builtin = { data, frame: M };
  return builtin;
}

// Band-limited copies of one frame (S samples from `src`): [{ data, size }], level L keeps the
// harmonics up to (M / 2) >> L, M = S rounded up to a power of two (other sizes are resampled).
export function mipmaps(src, S, mode = 2) {
  const M = nextPow2(S);
  const re = new Float64Array(M);
  const im = new Float64Array(M);
  for (let j = 0; j < M; j++) re[j] = S === M ? src[j] : readWrapped(src, S, (j * S) / M, mode);
  fft(re, im);
  const levels = [];
  for (let h = M >> 1; h >= 1; h >>= 1) {
    const size = levels.length ? Math.min(M, Math.max(32, 4 * h)) : M;
    const r = new Float64Array(size);
    const i = new Float64Array(size);
    const top = Math.min(h, size / 2 - 1); // no DC, no Nyquist bin
    const s = size / M;
    for (let k = 1; k <= top; k++) {
      r[k] = re[k] * s; i[k] = im[k] * s;
      r[size - k] = re[k] * s; i[size - k] = -im[k] * s;
    }
    fft(r, i, true);
    const data = new Float32Array(size);
    for (let j = 0; j < size; j++) data[j] = r[j] / size;
    levels.push({ data, size });
  }
  return levels;
}

export default class WavetableKernel extends PolyKernel {
  constructor() {
    super({ position: 0, block: 0, interpolation: 2 });
    this.table = builtinTable();
    this.size = 0; // samples per frame in use
    this.frames = 0;
    this.cache = [];
    this.pos = 0; // smoothed position 0..1
    this.layout();
  }

  param(id, value) {
    super.param(id, value);
    if (id === 'block') this.layout();
  }

  message(m) {
    if (m.type !== 'table') return super.message(m);
    this.table = m.data?.length ? { data: m.data, frame: m.frame > 0 ? m.frame | 0 : DEFAULT_FRAME } : builtinTable();
    this.layout();
  }

  // frames of the current Block Size (Auto = the size detected from the file)
  layout() {
    const len = this.table.data.length;
    const want = BLOCK_SIZES[Math.max(0, Math.min(BLOCK_SIZES.length - 1, this.p.block | 0))] || this.table.frame;
    const size = Math.max(1, Math.min(want, len));
    if (size === this.size && this.frames === Math.floor(len / size) && this.cache.data === this.table.data) return;
    this.size = size;
    this.frames = Math.max(1, Math.floor(len / size));
    this.cache = [];
    this.cache.data = this.table.data;
  }

  frame(f) {
    return (this.cache[f] ??= mipmaps(this.table.data.subarray(f * this.size, (f + 1) * this.size), this.size));
  }

  start(v, phase) {
    v.pos = Number.isFinite(phase) ? phase - Math.floor(phase) : 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const buf = out[0];
    buf.fill(0);
    const e = this.blockEnv(n);
    const mode = Math.max(0, Math.min(2, this.p.interpolation | 0));
    const last = this.frames - 1;
    const posT = Math.min(1, Math.max(0, this.p.position / 100));
    const pos0 = this.pos;
    const k = 1 - Math.exp(-n / (SMOOTH_S * sampleRate));
    this.pos = Math.abs(posT - pos0) < 1e-6 ? posT : pos0 + (posT - pos0) * k;
    const posStep = (this.pos - pos0) / n;
    let active = 0;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      let vel = v.vel;
      const velStep = this.glide(v, e.k, n);
      const inc = Math.min(0.45, (440 * Math.pow(2, (v.pitch - 69) / 12)) / sampleRate);
      const M = this.frame(0)[0].size;
      const levels = this.frame(0).length;
      const L = Math.max(0, Math.min(levels - 1, Math.ceil(Math.log2(M * inc))));
      for (let i = 0; i < n; i++) {
        const lvl = envTick(v, e);
        if (!v.stage) break;
        vel += velStep;
        const fp = (pos0 + posStep * i) * last;
        const f0 = Math.floor(fp);
        const t = fp - f0;
        const a = this.frame(f0)[L];
        let y = readWrapped(a.data, a.size, v.pos * a.size, mode);
        if (t > 0 && f0 < last) {
          const b = this.frame(f0 + 1)[L];
          y += (readWrapped(b.data, b.size, v.pos * b.size, mode) - y) * t;
        }
        buf[i] += y * lvl * vel;
        v.pos += inc;
        if (v.pos >= 1) v.pos -= 1;
      }
    }
    const g = this.p.gain * 0.5;
    for (let i = 0; i < n; i++) buf[i] *= g;
    for (let c = 1; c < out.length; c++) out[c].set(buf);
    return active > 0;
  }
}
