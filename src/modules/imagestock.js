// Stock image of the IMAGE SAMPLER: plays when no picture is loaded (state imageId null). It is
// generated here, not saved in projects. 256 × 256, laid out as a wavetable for the default
// horizontal Line: every row holds one full cycle from the left to the right edge, and going down
// the rows morph smoothly through a family of waveforms (each one held for a while, then
// crossfaded into the next):
//   sine → triangle → organ (harmonics 1…8) → formant (vocal resonance) → square → saw (the
//   middle row: the default scanner plays it) → hard sync → narrow pulse → stepped (bitcrushed)
//   sine → slow noise (gritty) → fine noise (buzzy hiss)
// so Y (or an LFO / automation on it) sweeps the timbre from soft to bright to noisy. The colours
// differ: red is the waveform, green the same shape an octave up (brighter), blue the shape a bit
// further down the morph and a quarter cycle later; with the default colour mix (red + green left,
// blue + green right) the speakers play related but different waves, and the colour amounts
// mix octave, morph and stereo. Ovals, Triangles and Propellors cross several rows, so they play
// mixtures of the shapes.
import { addImage } from '../samples.js';

export const STOCK_SIZE = 256;
export const STOCK_NAME = 'Stock wavetable';

const TAU = Math.PI * 2;
const frac = (v) => v - Math.floor(v);
const hash = (i, j) => {
  let h = Math.imul(i ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(j ^ 0x61c88647, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967295 * 2 - 1;
};
// noise along the phase that wraps after one cycle (`cells` values per cycle, smooth between them)
const loopNoise = (p, cells, seed) => {
  const x = frac(p) * cells;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return hash(i % cells, seed) * (1 - s) + hash((i + 1) % cells, seed) * s;
};
const organ = (p) => (Math.sin(TAU * p) + Math.sin(TAU * 2 * p) / 2 + Math.sin(TAU * 3 * p) / 3
  + Math.sin(TAU * 4 * p) / 4 + Math.sin(TAU * 6 * p) / 5 + Math.sin(TAU * 8 * p) / 6) / 1.45;

// the waveforms, phase p (cycles) -> −1…1
export const STOCK_SHAPES = [
  ['sine', (p) => Math.sin(TAU * p)],
  ['triangle', (p) => 1 - 4 * Math.abs(frac(p + 0.25) - 0.5)],
  ['organ', organ],
  ['formant', (p) => 0.4 * Math.sin(TAU * p) + 0.9 * Math.sin(TAU * 7 * p) * (0.5 - 0.5 * Math.cos(TAU * p))],
  ['square', (p) => (frac(p) < 0.5 ? 1 : -1)],
  ['saw', (p) => 2 * frac(p + 0.5) - 1],
  ['sync', (p) => 2 * frac(frac(p + 0.5) * 2.6) - 1],
  ['pulse', (p) => (frac(p + 0.1) < 0.2 ? 1 : -0.6)],
  ['stepped', (p) => Math.round(Math.sin(TAU * p) * 2.5) / 2.5],
  ['slow noise', (p) => 1.6 * (loopNoise(p, 9, 1) * 0.65 + loopNoise(p, 23, 2) * 0.35)],
  ['fine noise', (p) => { const v = loopNoise(p, 40, 3); return Math.sign(v) * Math.sqrt(Math.abs(v)) * 1.2; }],
];

// shape at morph position m (0 = first shape, 1 = last): each shape is held for 40 % of its
// stretch and crossfaded (smoothly) into the next one over the other 60 %
export function stockWave(m, p) {
  const pos = Math.min(1, Math.max(0, m)) * (STOCK_SHAPES.length - 1);
  const i = Math.min(STOCK_SHAPES.length - 2, Math.floor(pos));
  let f = Math.min(1, Math.max(0, (pos - i - 0.2) / 0.6));
  f = f * f * (3 - 2 * f);
  const a = STOCK_SHAPES[i][1](p);
  return f <= 0 ? a : a * (1 - f) + STOCK_SHAPES[i + 1][1](p) * f;
}

export function stockImage() {
  const n = STOCK_SIZE;
  const rgb = new Uint8Array(n * n * 3);
  const byte = (v) => Math.round((Math.min(1, Math.max(-1, v)) * 0.5 + 0.5) * 255);
  for (let y = 0; y < n; y++) {
    const m = y / (n - 1);
    for (let x = 0; x < n; x++) {
      const p = x / (n - 1);
      const k = (y * n + x) * 3;
      rgb[k] = byte(stockWave(m, p));
      rgb[k + 1] = byte(stockWave(m, 2 * p));
      rgb[k + 2] = byte(stockWave(m + 0.04, p + 0.25));
    }
  }
  return { width: n, height: n, rgb };
}

let stockId = null;
// the pool id of the stock image (made on first use)
export const stockImageId = () => (stockId ??= addImage(stockImage()));
