// Multi-mode filter DSP. Runs on the audio thread.
// SVF types use the zero-delay-feedback state variable filter (Cytomic / A. Simper),
// which stays stable under fast cutoff modulation. The ladder is a ZDF 4-pole Moog-style model.
import { Kernel } from '../dsp/kernel.js';
import { newSvf, tickSvf } from '../dsp/svf.js';

const TAIL_BLOCKS = 8; // silent render quanta before an input-less filter stops
const T = {
  LP: 0, HP: 1, BP: 2, NOTCH: 3, PEAK: 4, AP: 5, BELL: 6, LSHELF: 7, HSHELF: 8,
  LADDER: 9, COMB_POS: 10, COMB_NEG: 11, FORMANT: 12,
};
const family = (t) => (t <= T.HSHELF ? 'svf' : t === T.LADDER ? 'ladder' : t === T.FORMANT ? 'formant' : 'comb');

// [frequency Hz, amplitude] for formants F1..F3 (male voice), vowels A E I O U
const VOWELS = [
  [[800, 1], [1150, 0.5], [2900, 0.025]],
  [[350, 1], [2000, 0.1], [2800, 0.18]],
  [[270, 1], [2140, 0.25], [2950, 0.05]],
  [[450, 1], [800, 0.28], [2830, 0.08]],
  [[325, 1], [700, 0.25], [2530, 0.03]],
];

const MAX_STAGES = 4;
const CHANNELS = 2;
const ANTI_DENORMAL = 1e-20;
const LN2 = Math.log(2);

const qFromRes = (r) => 0.5 * Math.pow(80, r); // 0 -> Q 0.5, 1 -> Q 40

export default class FilterKernel extends Kernel {
  constructor() {
    super();
    this.p = {
      type: T.LP, slope: 1, cutoff: 1000, resonance: 0.1, gain: 0, vowel: 0, drive: 0,
      lfoShape: 0, lfoRate: 1, lfoDepth: 0, mix: 1, level: 1,
    };
    // smoothed copies, to avoid zipper noise
    this.s = { logF: Math.log2(1000), res: 0.1, gain: 0, vowel: 0, drive: 0, mix: 1, level: 1 };
    this.smooth = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.fMax = Math.min(20000, sampleRate * 0.45);

    this.svf = Array.from({ length: CHANNELS }, () => Array.from({ length: MAX_STAGES }, newSvf));
    this.ladder = Array.from({ length: CHANNELS }, () => new Float64Array(4));
    this.formant = Array.from({ length: CHANNELS }, () => Array.from({ length: 3 }, newSvf));
    this.combLen = Math.ceil(sampleRate / 10) + 4; // lowest comb frequency: 10 Hz
    this.comb = Array.from({ length: CHANNELS }, () => new Float32Array(this.combLen));
    this.combPos = 0;

    this.lfoPhase = 0;
    this.lfoHold = 0;
    // Random (shape 5): every cycle glides (smoothstep) from the previous target to a new random
    // one, like the LFO module's Random but bipolar (-1..1) around the cutoff
    this.lfoFrom = 0;
    this.lfoTo = Math.random() * 2 - 1;
    this.lfoLast = 0;
    this.v1 = 0;
    this.v2 = 0;

    this.zero = [new Float32Array(128), new Float32Array(128)];
    this.quiet = 0; // render quanta without input and with a silent output (tail done)
    // coefficient caches: recomputed only when the smoothed values they depend on change (the
    // same values as computing them every sample; cpp/filter.h does the same)
    this.c = {
      logF: NaN, fc: 0, wd: 0, drive: NaN, driveGain: 1, driveNorm: 1, res: NaN, gain: NaN, type: -1, svfDirty: true,
      k: 0, a1: 0, a2: 0, a3: 0, kB: 0, b1: 0, b2: 0, b3: 0, A: 1,
      vowel: NaN, oct: NaN, resF: NaN, kF: 0, fmG: [0, 0, 0], fmC1: [0, 0, 0], fmAmp: [0, 0, 0],
    };
  }

  param(id, value) {
    if (id === 'type' && family(value | 0) !== family(this.p.type | 0)) this.reset();
    if (id === 'lfoShape' && (value | 0) === 5 && (this.p.lfoShape | 0) !== 5) {
      this.lfoFrom = this.lfoTo = this.lfoLast; // continue from where the wave is
    }
    this.p[id] = value;
  }

  reset() {
    for (const ch of this.svf) for (const st of ch) st.ic1 = st.ic2 = 0;
    for (const ch of this.formant) for (const st of ch) st.ic1 = st.ic2 = 0;
    for (const st of this.ladder) st.fill(0);
    for (const buf of this.comb) buf.fill(0);
  }

  // One SVF tick; results in this.v1 (band) and this.v2 (low).
  tick(st, v0, a1, a2, a3) {
    tickSvf(st, v0, a1, a2, a3);
    this.v1 = st.band;
    this.v2 = st.low;
  }

  // need: the value is used (else only the phase moves; lfoLast is only read between blocks, so
  // the last sample of a block always computes it)
  lfo(need = true) {
    const p = this.p;
    const ph = this.lfoPhase;
    let v = this.lfoLast;
    if (need) switch (p.lfoShape | 0) {
      case 1: v = 1 - 4 * Math.abs(ph - 0.5); break; // triangle
      case 2: v = 2 * ph - 1; break; // saw
      case 3: v = ph < 0.5 ? 1 : -1; break; // square
      case 4: v = this.lfoHold; break; // sample & hold
      case 5: { const k = ph * ph * (3 - 2 * ph); v = this.lfoFrom + (this.lfoTo - this.lfoFrom) * k; break; } // random smooth ramps
      default: v = Math.sin(2 * Math.PI * ph);
    }
    this.lfoPhase += p.lfoRate / sampleRate;
    if (this.lfoPhase >= 1) {
      this.lfoPhase -= 1;
      this.lfoHold = Math.random() * 2 - 1;
      this.lfoFrom = this.lfoTo;
      this.lfoTo = Math.random() * 2 - 1;
    }
    this.lfoLast = v;
    return v;
  }

  process(inputs, outputs) {
    let input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    if (!input || input.length === 0) {
      // no input: let the resonance / comb tail ring out, then go silent
      if (this.quiet > TAIL_BLOCKS) {
        for (const ch of output) ch.fill(0);
        return false;
      }
      if (this.zero[0].length !== n) this.zero = [new Float32Array(n), new Float32Array(n)];
      input = this.zero;
    }

    const p = this.p;
    const s = this.s;
    const sm = this.smooth;
    const type = p.type | 0;
    const nProc = Math.min(input.length, output.length, CHANNELS);
    const targetLogF = Math.log2(Math.max(10, Math.min(this.fMax, p.cutoff)));
    const stages = type <= T.AP ? Math.min(MAX_STAGES, (p.slope | 0) + 1) : 1;
    const c = this.c;

    for (let i = 0; i < n; i++) {
      const lfoOct = p.lfoDepth ? this.lfo(true) * p.lfoDepth : (this.lfo(i === n - 1), 0);
      s.logF += (targetLogF + lfoOct - s.logF) * sm;
      s.res += (p.resonance - s.res) * sm;
      s.gain += (p.gain - s.gain) * sm;
      s.vowel += (p.vowel - s.vowel) * sm;
      s.drive += (p.drive - s.drive) * sm;
      s.mix += (p.mix - s.mix) * sm;
      s.level += (p.level - s.level) * sm;

      if (s.logF !== c.logF) {
        c.logF = s.logF;
        c.fc = Math.max(10, Math.min(this.fMax, Math.exp(s.logF * LN2)));
        c.wd = Math.tan((Math.PI * c.fc) / sampleRate);
        c.svfDirty = true;
      }
      if (s.drive !== c.drive) {
        c.drive = s.drive;
        c.driveGain = 1 + s.drive * 9;
        c.driveNorm = 1 / Math.tanh(c.driveGain);
      }
      const { fc, wd, driveGain, driveNorm } = c;

      // per-sample coefficients shared by all channels
      if (type <= T.HSHELF && (c.svfDirty || s.res !== c.res || s.gain !== c.gain || type !== c.type)) {
        c.svfDirty = false;
        c.res = s.res;
        c.gain = s.gain;
        c.type = type;
        let k, A;
        // shelves only use a gentle Q range; high Q would add a large resonant bump
        const Q = type === T.LSHELF || type === T.HSHELF ? 0.5 + s.res * 1.5 : qFromRes(s.res);
        A = Math.pow(10, s.gain / 40);
        let g = wd;
        k = 1 / Q;
        if (type === T.BELL) k = 1 / (Q * A);
        else if (type === T.LSHELF) g = wd / Math.sqrt(A);
        else if (type === T.HSHELF) g = wd * Math.sqrt(A);
        c.k = k;
        c.A = A;
        c.a1 = 1 / (1 + g * (g + k));
        c.a2 = g * c.a1;
        c.a3 = g * c.a2;
        // earlier cascade stages are Butterworth (Q 0.707); only the last stage resonates
        c.kB = Math.SQRT2;
        c.b1 = 1 / (1 + wd * (wd + c.kB));
        c.b2 = wd * c.b1;
        c.b3 = wd * c.b2;
      }
      const { k, a1, a2, a3, kB, b1, b2, b3, A } = c;
      if (type === T.FORMANT && (s.vowel !== c.vowel || lfoOct !== c.oct || s.res !== c.resF)) {
        c.vowel = s.vowel;
        c.oct = lfoOct;
        c.resF = s.res;
        const vi = Math.max(0, Math.min(4, s.vowel));
        const i0 = Math.min(3, Math.floor(vi));
        const fr = vi - i0;
        const shift = Math.pow(2, lfoOct);
        const Q = 5 + s.res * 25;
        c.kF = 1 / Q;
        for (let f = 0; f < 3; f++) {
          const [f0, g0] = VOWELS[i0][f];
          const [f1, g1] = VOWELS[i0 + 1][f];
          const ff = Math.min(this.fMax, f0 * Math.pow(f1 / f0, fr) * shift);
          c.fmAmp[f] = g0 + (g1 - g0) * fr;
          c.fmG[f] = Math.tan((Math.PI * ff) / sampleRate);
          c.fmC1[f] = 1 / (1 + c.fmG[f] * (c.fmG[f] + c.kF));
        }
      }

      for (let ch = 0; ch < nProc; ch++) {
        const dry = input[ch][i];
        let x = dry;
        if (s.drive > 1e-4) x += (Math.tanh(x * driveGain) * driveNorm - x) * s.drive;
        x += ANTI_DENORMAL;
        let y;

        if (type <= T.HSHELF) {
          const chain = this.svf[ch];
          for (let st = 0; st < stages; st++) {
            const last = st === stages - 1;
            const kk = last ? k : kB;
            if (last) this.tick(chain[st], x, a1, a2, a3);
            else this.tick(chain[st], x, b1, b2, b3);
            const v1 = this.v1;
            const v2 = this.v2;
            switch (type) {
              case T.LP: x = v2; break;
              case T.HP: x = x - kk * v1 - v2; break;
              case T.BP: x = kk * v1; break;
              case T.NOTCH: x = x - kk * v1; break;
              case T.PEAK: x = 2 * v2 - x + kk * v1; break;
              case T.AP: x = x - 2 * kk * v1; break;
              case T.BELL: x = x + k * (A * A - 1) * v1; break;
              case T.LSHELF: x = x + k * (A - 1) * v1 + (A * A - 1) * v2; break;
              case T.HSHELF: x = A * A * x + k * (1 - A) * A * v1 + (1 - A * A) * v2; break;
            }
          }
          y = x;
        } else if (type === T.LADDER) {
          const st = this.ladder[ch];
          const G = wd / (1 + wd);
          const b = 1 - G;
          const kL = s.res * 4.2;
          const G2 = G * G;
          const S = G2 * G * b * st[0] + G2 * b * st[1] + G * b * st[2] + b * st[3];
          let u = Math.tanh((x * (1 + kL * 0.5) - kL * S) / (1 + kL * G2 * G2));
          for (let j = 0; j < 4; j++) {
            const v = (u - st[j]) * G;
            u = v + st[j];
            st[j] = u + v;
          }
          y = u;
        } else if (type === T.FORMANT) {
          y = 0;
          for (let f = 0; f < 3; f++) {
            const g = c.fmG[f];
            const c1 = c.fmC1[f];
            this.tick(this.formant[ch][f], x, c1, g * c1, g * g * c1);
            y += c.kF * this.v1 * c.fmAmp[f];
          }
          y *= 2;
        } else {
          // feedback comb: peaks at multiples of fc (positive) or odd multiples of fc/2 (negative)
          const buf = this.comb[ch];
          const len = this.combLen;
          const fb = (type === T.COMB_NEG ? -1 : 1) * s.res * 0.97;
          const d = Math.min(len - 2, sampleRate / fc);
          let rp = this.combPos - d;
          if (rp < 0) rp += len;
          const r0 = rp | 0;
          const fr = rp - r0;
          const delayed = buf[r0] + (buf[(r0 + 1) % len] - buf[r0]) * fr;
          const w = x + fb * delayed;
          buf[this.combPos] = w;
          y = w * (1 - Math.abs(fb));
        }

        output[ch][i] = (dry + (y - dry) * s.mix) * s.level;
      }
      if (type === T.COMB_POS || type === T.COMB_NEG) this.combPos = (this.combPos + 1) % this.combLen;
    }

    for (let c = nProc; c < output.length; c++) output[c].set(output[nProc - 1]);
    if (input !== this.zero) this.quiet = 0;
    else {
      let peak = 0;
      for (const ch of output) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]));
      this.quiet = peak < 1e-6 ? this.quiet + 1 : 0;
    }
    return true;
  }
}
