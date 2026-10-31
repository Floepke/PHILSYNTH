// COMPRESSOR: feed-forward, stereo-linked compressor with an optional side chain key.
// Signal path: key (own input, or the Side Chain input) -> optional high-pass (Side Chain HPF)
//   -> level detector (Mode) -> gain computer in dB (Threshold, Slope, soft Knee)
//   -> attack / release smoothing of the gain reduction -> audio × gain × Makeup, blended by Mix.
//   Peak               peak detector with LOOKAHEAD_MS look-ahead: the audio is delayed and the
//                      gain reduction is held over the look-ahead window, so the gain is already
//                      going down when a transient arrives (adds LOOKAHEAD_MS latency)
//   RMS                mean square over RMS_MS: reacts to loudness rather than single peaks
//   Peak Zero Latency  peak detector without look-ahead or delay
// Slope = 1 - 1/ratio (0 = no compression, 0.5 = 2:1, 0.75 = 4:1, 1 = limiter ∞:1).
// Side Chain 0 = off (the audio is its own key), k = input k is the key and the other inputs are
// the audio (Graph routes carrierInput kernels: inputs[0] = key, inputs[1] = the rest).
// meter: current gain reduction in dB (>= 0).
import { Kernel } from '../dsp/kernel.js';

export const MODES = ['Peak', 'RMS', 'Peak Zero Latency'];
export const LOOKAHEAD_MS = 5;
export const RMS_MS = 10;
export const HPF_OFF = 20; // Side Chain HPF at (or below) this frequency is off

export const ratioText = (slope) => (slope >= 0.995 ? '∞:1' : `${(1 / (1 - slope)).toFixed(1)}:1`);

// Static curve: gain reduction (dB, >= 0) for a detector level in dB.
export function gainReduction(level, threshold, slope, knee) {
  const over = level - threshold;
  if (knee > 0 && 2 * Math.abs(over) <= knee) return (slope * (over + knee / 2) ** 2) / (2 * knee);
  return over > 0 ? slope * over : 0;
}

const coef = (ms) => (ms > 0 ? Math.exp(-1000 / (ms * sampleRate)) : 0);

export default class CompressorKernel extends Kernel {
  static carrierInput = true;
  static meter = true;

  constructor() {
    super();
    this.carrier = 1e9; // no side chain: every input is audio (Graph: inputs[0] stays empty)
    this.keyed = false;
    this.threshold = -18;
    this.slope = 0.75;
    this.knee = 6;
    this.makeup = 1;
    this.mix = 1;
    this.mode = 0;
    this.aA = coef(10);
    this.aR = coef(150);
    this.la = Math.max(1, Math.round((LOOKAHEAD_MS * sampleRate) / 1000));
    this.dl = [new Float32Array(this.la), new Float32Array(this.la)]; // look-ahead delay line
    this.dpos = 0;
    // sliding maximum of the gain reduction over la + 1 samples (monotonic queue)
    this.cap = this.la + 2;
    this.qv = new Float64Array(this.cap);
    this.qt = new Float64Array(this.cap);
    this.qh = 0;
    this.qn = 0;
    this.t = 0;
    this.rmsN = Math.max(1, Math.round((RMS_MS * sampleRate) / 1000));
    this.rms = new Float64Array(this.rmsN);
    this.rpos = 0;
    this.rsum = 0;
    this.hpf = 0; // Hz, 0 = off
    this.hb = null; // biquad coefficients [b0, b1, b2, a1, a2]
    this.hz = new Float64Array(8); // biquad state: x1, x2, y1, y2 per channel
    this.env = 0; // smoothed gain reduction (dB)
    this.meter = 0;
    this.quiet = Infinity; // samples since the last input
  }

  param(id, v) {
    switch (id) {
      case 'threshold': this.threshold = v; break;
      case 'slope': this.slope = Math.max(0, Math.min(1, v)); break;
      case 'knee': this.knee = Math.max(0, v); break;
      case 'attack': this.aA = coef(v); break;
      case 'release': this.aR = coef(v); break;
      case 'makeup': this.makeup = Math.pow(10, v / 20); break;
      case 'mix': this.mix = Math.max(0, Math.min(1, v / 100)); break;
      case 'mode': {
        const m = Math.max(0, Math.min(MODES.length - 1, v | 0));
        if (m !== this.mode) { this.mode = m; this.reset(false); }
        break;
      }
      case 'sidechain': {
        const k = Math.max(0, v | 0);
        this.keyed = k > 0;
        this.carrier = k > 0 ? k - 1 : 1e9;
        break;
      }
      case 'scHpf': this.setHpf(v); break;
    }
  }

  setHpf(f) {
    if (!(f > HPF_OFF + 0.5)) { this.hpf = 0; this.hb = null; return; }
    this.hpf = Math.min(f, sampleRate * 0.45);
    const w = (2 * Math.PI * this.hpf) / sampleRate;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + al;
    this.hb = [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, (-2 * cs) / a0, (1 - al) / a0];
  }

  reset(all = true) {
    this.dl.forEach((d) => d.fill(0));
    this.qh = this.qn = 0;
    this.rms.fill(0);
    this.rsum = 0;
    if (all) {
      this.hz.fill(0);
      this.env = 0;
      this.meter = 0;
    }
  }

  panic() { this.reset(); this.quiet = Infinity; }

  // gain reduction target held over the look-ahead window
  hold(gr) {
    const { qv, qt, cap } = this;
    while (this.qn && qv[(this.qh + this.qn - 1) % cap] <= gr) this.qn--;
    const i = (this.qh + this.qn) % cap;
    qv[i] = gr;
    qt[i] = this.t;
    this.qn++;
    while (qt[this.qh] <= this.t - this.cap + 1) { this.qh = (this.qh + 1) % cap; this.qn--; }
    return qv[this.qh];
  }

  filter(x, ch) {
    const b = this.hb;
    const z = this.hz;
    const o = ch * 4;
    const y = b[0] * x + b[1] * z[o] + b[2] * z[o + 1] - b[3] * z[o + 2] - b[4] * z[o + 3];
    z[o + 1] = z[o];
    z[o] = x;
    z[o + 3] = z[o + 2];
    z[o + 2] = y;
    return y;
  }

  process(inputs, outputs) {
    const audio = inputs[1];
    const key = this.keyed ? inputs[0] : audio;
    const [L, R] = outputs[0];
    const n = L.length;
    const hasAudio = !!audio?.length;
    const hasKey = !!key?.length;
    const look = this.mode === 0;
    const drain = look ? this.la : 0;
    if (hasAudio || hasKey) this.quiet = 0;
    else if (this.quiet > drain + n && this.env < 1e-3) {
      if (this.env || this.meter) this.reset();
      return false;
    }
    const aL = hasAudio ? audio[0] : null;
    const aR = hasAudio ? audio[1] ?? audio[0] : null;
    const kL = hasKey ? key[0] : null;
    const kR = hasKey ? key[1] ?? key[0] : null;
    const { threshold, slope, knee, aA, aR: rel, makeup, mix, dl, la, rms, rmsN } = this;
    const dry = 1 - mix;
    let env = this.env;
    let maxGr = 0;
    for (let i = 0; i < n; i++, this.t++) {
      let kl = kL ? kL[i] : 0;
      let kr = kR ? kR[i] : 0;
      if (this.hb) { kl = this.filter(kl, 0); kr = this.filter(kr, 1); }
      let level;
      if (this.mode === 1) {
        const sq = 0.5 * (kl * kl + kr * kr);
        this.rsum += sq - rms[this.rpos];
        rms[this.rpos] = sq;
        if (++this.rpos === rmsN) this.rpos = 0;
        const ms = this.rsum > 0 ? this.rsum / rmsN : 0;
        level = ms > 1e-20 ? 10 * Math.log10(ms) : -200;
      } else {
        const pk = Math.max(Math.abs(kl), Math.abs(kr));
        level = pk > 1e-10 ? 20 * Math.log10(pk) : -200;
      }
      let gr = gainReduction(level, threshold, slope, knee);
      if (look) gr = this.hold(gr);
      env = gr > env ? gr + aA * (env - gr) : gr + rel * (env - gr);
      if (env > maxGr) maxGr = env;
      const g = Math.pow(10, -env / 20) * makeup * mix + dry;
      let l = aL ? aL[i] : 0;
      let r = aR ? aR[i] : 0;
      if (look) {
        const p = this.dpos;
        const dlL = dl[0][p];
        const dlR = dl[1][p];
        dl[0][p] = l;
        dl[1][p] = r;
        if (++this.dpos === la) this.dpos = 0;
        l = dlL;
        r = dlR;
      }
      L[i] = l * g;
      R[i] = r * g;
    }
    if (this.mode === 1 && this.t % 65536 < n) { // re-sum now and then: no rounding drift
      let s = 0;
      for (let i = 0; i < rmsN; i++) s += rms[i];
      this.rsum = s;
    }
    this.env = env < 1e-6 ? 0 : env;
    this.meter = maxGr;
    if (!hasAudio) this.quiet += n;
    return hasAudio || this.quiet <= drain;
  }
}
