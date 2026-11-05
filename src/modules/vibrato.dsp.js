// VIBRATO kernel: pitch vibrato through a modulated delay line (native twin: cpp/vibrato.h).
// The pitch itself follows the Waveform: ratio = 1 + r·w(phase), r = 2^(Amp/1200) − 1, w = sine
// or triangle (−1..1, phase 0 = centre, rising). The delay is the integral of that:
//   delay = BASE + (r / rate) · offset(phase)  (offset ≥ 0, see below)
// so Amp is a pitch depth in cents at any Frequency. Slow rates need long delays; the depth is
// limited so the delay stays within MAX_DELAY. The signal is delayed by about half the swing.
// Set Phase is applied on creation (project load / new module) and on panic; turning it while
// running does not jump. Depth changes (Amp, Frequency, BPM) glide over ~50 ms; switching the
// Waveform glides the jump in delay away too, so no click.
import { Kernel } from '../dsp/kernel.js';
import { lfoRateHz } from './lfo.dsp.js';

export const MAX_DELAY = 2; // s of modulation swing
const BASE = 2; // samples: room for the 4-point interpolation
const TWO_PI = 2 * Math.PI;
// largest offset() per Waveform
export const MAX_OFFSET = [1 / Math.PI, 0.25];

// Integral of w over the cycle up to `phase`, mirrored so it is ≥ 0 (in cycles).
export function vibratoOffset(phase, wave) {
  if (wave === 1) {
    const g = phase < 0.25 ? 2 * phase * phase
      : phase < 0.75 ? 2 * phase - 2 * phase * phase - 0.25
      : 2 * (1 - phase) * (1 - phase);
    return 0.25 - g;
  }
  return (1 + Math.cos(TWO_PI * phase)) / TWO_PI;
}

const wrap = (p) => p - Math.floor(p);

export default class VibratoKernel extends Kernel {
  constructor() {
    super();
    this.wave = 0;
    this.unit = 0;
    this.freq = 5;
    this.amp = 25;
    this.bpm = 120;
    this.startPhase = 0;
    this.phase = 0;
    this.ran = false;
    this.size = Math.ceil(MAX_DELAY * sampleRate) + BASE + 8;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.pos = 0;
    this.smooth = 1 - Math.exp(-1 / (0.05 * sampleRate));
    this.corr = 0; // samples: glides a Waveform switch
    this.idle = this.size; // samples without input (≥ size: the line is empty)
    this.update();
    this.depth = this.target;
  }

  // depth in samples per cycle of offset()
  update() {
    this.rate = lfoRateHz(this.freq, this.unit, this.bpm);
    const r = 2 ** (this.amp / 1200) - 1;
    const k = this.rate > 0 ? r / this.rate : 0;
    this.target = Math.min(k, MAX_DELAY / MAX_OFFSET[this.wave]) * sampleRate;
    if (!this.ran) this.depth = this.target;
  }

  param(id, v) {
    if (id === 'wave') {
      const wave = Math.min(1, Math.max(0, Math.round(v) || 0));
      if (wave === this.wave) return;
      if (this.ran) this.corr += this.depth * (vibratoOffset(this.phase, this.wave) - vibratoOffset(this.phase, wave));
      this.wave = wave;
    } else if (id === 'unit') this.unit = Math.min(3, Math.max(0, Math.round(v) || 0));
    else if (id === 'freq') this.freq = Math.min(50, Math.max(0.01, Number(v) || 0.01));
    else if (id === 'amp') this.amp = Math.min(200, Math.max(0, Number(v) || 0));
    else if (id === 'phase') {
      this.startPhase = wrap(Number(v) || 0);
      if (!this.ran) this.phase = this.startPhase;
      return;
    } else return;
    this.update();
  }

  message(m) {
    if (m.type === 'bpm') { this.bpm = Number(m.value) || 120; this.update(); }
    else super.message(m);
  }

  panic() {
    this.buf[0].fill(0);
    this.buf[1].fill(0);
    this.pos = 0;
    this.phase = this.startPhase;
    this.depth = this.target;
    this.corr = 0;
    this.idle = this.size;
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length;
    const has = !!(inp && inp.length);
    this.ran = true;
    const inc = this.rate / sampleRate;
    const silentTail = !has && this.idle >= BASE
      + Math.max(this.depth, this.target) * MAX_OFFSET[this.wave] + Math.abs(this.corr) + 2;
    if (!has) this.idle += n; else this.idle = 0;
    if (this.idle >= this.size) {
      // nothing in the line: only the clock moves on
      this.idle = this.size;
      this.depth = this.target;
      this.corr = 0;
      this.phase = wrap(this.phase + n * inc);
      return false;
    }
    const src = has ? [inp[0], inp[1] ?? inp[0]] : null;
    const size = this.size;
    if (silentTail) {
      // Keep old history until overwritten: increasing the delay can make it audible again.
      for (const b of this.buf) {
        b.fill(0, this.pos, Math.min(size, this.pos + n));
        if (this.pos + n > size) b.fill(0, 0, this.pos + n - size);
      }
      out[0].fill(0);
      out[1].fill(0);
    }
    let live = false;
    for (let i = 0; i < n; i++) {
      this.depth += (this.target - this.depth) * this.smooth;
      this.corr -= this.corr * this.smooth;
      if (silentTail) {
        this.phase += inc;
        if (this.phase >= 1) this.phase -= 1;
        this.pos = this.pos + 1 === size ? 0 : this.pos + 1;
        continue;
      }
      const d = BASE + this.depth * vibratoOffset(this.phase, this.wave) + this.corr;
      let at = this.pos - d;
      if (at < 0) at += size;
      const j = Math.floor(at);
      const f = at - j;
      const jm = j === 0 ? size - 1 : j - 1;
      const j1 = j + 1 === size ? 0 : j + 1;
      const j2 = j1 + 1 === size ? 0 : j1 + 1;
      for (let c = 0; c < 2; c++) {
        const b = this.buf[c];
        b[this.pos] = src ? src[c][i] : 0;
        const xm = b[jm], x0 = b[j], x1 = b[j1], x2 = b[j2];
        // 4-point Hermite
        const c1 = 0.5 * (x1 - xm);
        const c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
        const y = ((c3 * f + c2) * f + c1) * f + x0;
        out[c][i] = y;
        if (y !== 0) live = true;
      }
      this.phase += inc;
      if (this.phase >= 1) this.phase -= 1;
      this.pos = this.pos + 1 === size ? 0 : this.pos + 1;
    }
    return live;
  }
}
