// LFO kernel (see src/dsp/kernel.js), control rate: steps once per render quantum on the audio
// clock (keeps running in background tabs). Its unipolar value (0..1) is mapped by the engine
// graph onto the controllers its cables point to.
import { Kernel } from '../dsp/kernel.js';

const BEATS_PER_UNIT = [0, 1, 0.5, 0.25];
// Synced cycle lengths, in units (e.g. 4 × 1/4 = one bar of 4/4).
const PERIODS = [64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1.5, 1, 3 / 4, 2 / 3, 1 / 2, 1 / 3, 1 / 4];

export function syncedPeriod(freq) {
  const want = Math.log(1 / freq);
  return PERIODS.reduce((best, p) => (Math.abs(Math.log(p) - want) < Math.abs(Math.log(best) - want) ? p : best));
}

// Frequency + Freq Unit (0 = Hz, else cycles per note value synced to `bpm`) -> Hz
export function lfoRateHz(freq, unit, bpm) {
  if (!unit) return freq;
  return bpm / (60 * BEATS_PER_UNIT[unit] * syncedPeriod(freq));
}

export default class LfoKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.freq = 1;
    this.unit = 0;
    this.bpm = 120;
    this.rate = 1; // Hz
    this.wave = 0;
    this.phase = 0;
    // Random: every cycle glides (smoothstep) from the previous target to a new random one
    this.from = 0.5;
    this.to = Math.random();
    this.value = this.at();
  }

  param(id, v) {
    if (id === 'freq' || id === 'unit') {
      this[id] = id === 'unit' ? v | 0 : v;
      this.updateRate();
    } else if (id === 'wave') {
      v |= 0;
      if (v === 4 && this.wave !== 4) this.from = this.to = this.at(); // continue from where the wave is
      this.wave = v;
    }
  }

  message(m) {
    if (m.type === 'param') this.param(m.id, m.value);
    else if (m.type === 'bpm') { this.bpm = m.value; this.updateRate(); }
    else if (m.type === 'reset') this.phase = 0;
  }

  updateRate() {
    this.rate = lfoRateHz(this.freq, this.unit, this.bpm);
  }

  at() {
    const ph = this.phase;
    switch (this.wave) {
      case 1: return ph < 0.5 ? ph * 2 : 2 - ph * 2; // triangle
      case 2: return ph; // saw (ramp up)
      case 3: return ph < 0.5 ? 1 : 0; // square
      case 4: { const k = ph * ph * (3 - 2 * ph); return this.from + (this.to - this.from) * k; } // random smooth ramps
      default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * ph); // sine, starts at the bottom
    }
  }

  process(_inputs, outputs) {
    const n = outputs[0]?.[0]?.length ?? 128;
    this.value = this.at();
    this.phase += (this.rate * n) / sampleRate;
    if (this.phase >= 1) {
      this.from = this.to;
      this.to = Math.random();
    }
    this.phase -= Math.floor(this.phase);
    return false;
  }
}
