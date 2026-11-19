import { fft } from './fft.js';
import { SPECTRA_PARTIALS } from './spectra.sample.js';

export const WAVE_SAMPLES = 512;

export function waveformToLevels(samples) {
  const re = Float64Array.from(samples);
  const im = new Float64Array(WAVE_SAMPLES);
  fft(re, im);
  // Ignore DC and phase. If any bin exceeds the Amp range, scale them all to preserve their ratios.
  const levels = Array.from({ length: SPECTRA_PARTIALS }, (_, i) => (200 / WAVE_SAMPLES) * Math.hypot(re[i + 1], im[i + 1]));
  const scale = 100 / Math.max(100, ...levels);
  return levels.map((level) => Math.round(level * scale * 1e6) / 1e6);
}

export function levelsToWaveform(levels) {
  const re = new Float64Array(WAVE_SAMPLES);
  const im = new Float64Array(WAVE_SAMPLES);
  // Conjugate bins give a real, zero-phase sine sum: a reference shape, not the audio loop.
  for (let k = 1; k <= SPECTRA_PARTIALS; k++) {
    im[WAVE_SAMPLES - k] = levels[k - 1] / 200;
    im[k] = -im[WAVE_SAMPLES - k];
  }
  fft(re, im, true);
  return re;
}
