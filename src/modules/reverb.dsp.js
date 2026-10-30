// Algorithmic stereo reverb DSP kernel (see src/dsp/kernel.js). Runs on the audio thread.
//
//   in ─> low cut ─> high cut ─> pre-delay ─┬─> early reflections (seeded multi-tap) ───────┐
//                                           └─> diffusion (4 all-passes) ─> 16-line FDN ─────┴─> width ─> wet
//
// Late reverb: a feedback delay network of 16 modulated delay lines mixed by a Hadamard matrix
// (lossless, so the loop gain is set by the per-line filters only). Each line has a Jot absorption
// filter: its DC gain gives the "Decay" RT60, its Nyquist gain a shorter RT60 set by "Damp", so
// highs die away faster than lows like in a real room. "Room size" scales every delay length,
// "Seed" picks the delay lengths, reflection pattern, signs and modulation rates: every seed is a
// different room. Seed changes dip the wet signal for a few ms so the swap is click-free.
// The processor sleeps (near-zero CPU) after the input and tail have been silent for a while.

import { Kernel } from '../dsp/kernel.js';

const N = 16;
const MAX_SCALE = 2;
const LINE_MIN = 0.021; // s, shortest/longest FDN line at size scale 1
const LINE_MAX = 0.067;
const MOD_MAX = 0.0012; // s of delay-line modulation at Modulation 100 %
const ER_TAPS = 12;
const ER_MAX = 0.085; // s, latest early reflection at size scale 1
const AP_STAGES = 4;
const AP_MAX = 0.012;
const PREDELAY_MAX = 0.5;
const LATE_GAIN = 0.11; // output normalisation of the 16 summed lines (see test/reverb.test.mjs)
const SEED_FADE = 0.015; // s, wet dip when the seed changes
const SLEEP_AFTER = 0.3; // s
const SILENT = 1e-6;
const DENORMAL = 1e-18;
const TWO_PI = 2 * Math.PI;

const sizeScale = (s) => 0.08 * Math.pow(25, Math.max(0, Math.min(1, s))); // 0..1 -> 0.08..2
const pow2 = (n) => 1 << Math.ceil(Math.log2(n));

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default class ReverbKernel extends Kernel {
  // salt: Patch instances (Instances > 1) each get their own: same Seed, different room per instance
  constructor({ salt = 0 } = {}) {
    super();
    this.salt = salt | 0;
    const sr = sampleRate;
    this.p = {
      mix: 0.3, size: 0.5, decay: 2.5, damp: 0.5, seed: 1, predelay: 0.02, early: 0.4, diffusion: 0.75,
      mod: 0.3, lowCut: 60, highCut: 14000, width: 1, freeze: 0, level: 1,
    };

    this.lineLen = pow2(LINE_MAX * 1.1 * MAX_SCALE * sr + MOD_MAX * sr + 8);
    this.lines = Array.from({ length: N }, () => new Float32Array(this.lineLen));
    this.w = 0;
    this.pdLen = pow2((PREDELAY_MAX + ER_MAX * MAX_SCALE) * sr + 8);
    this.pd = [new Float32Array(this.pdLen), new Float32Array(this.pdLen)];
    this.pw = 0;
    this.apLen = pow2(AP_MAX * sr + 4);
    this.ap = [0, 1].map(() => Array.from({ length: AP_STAGES }, () => new Float32Array(this.apLen)));
    this.apw = 0;

    this.base = new Float64Array(N); // line lengths in samples at scale 1
    this.inSign = new Float64Array(N);
    this.outL = new Float64Array(N);
    this.outR = new Float64Array(N);
    this.modRate = new Float64Array(N);
    this.modPhase = new Float64Array(N);
    this.erT = [new Float64Array(ER_TAPS), new Float64Array(ER_TAPS)]; // samples at scale 1
    this.erG = [new Float64Array(ER_TAPS), new Float64Array(ER_TAPS)];
    this.apD = [new Int32Array(AP_STAGES), new Int32Array(AP_STAGES)];

    this.lp = new Float64Array(N); // absorption filter states
    this.apIn = new Float64Array(N); // all-pass interpolator states
    this.apOut = new Float64Array(N);
    this.v = new Float64Array(N); // scratch for the matrix
    this.g0 = new Float64Array(N); // per-block interpolation start/step for gain, pole and modulation
    this.gStep = new Float64Array(N);
    this.a0 = new Float64Array(N);
    this.aStep = new Float64Array(N);
    this.m0 = new Float64Array(N);
    this.mStep = new Float64Array(N);
    this.filt = new Float64Array(4); // low cut / high cut states L,R

    this.layout(this.p.seed);
    this.snap();
    this.fade = 1;
    this.quiet = 0;
    // start asleep: the first input wakes it and snaps the smoothers to the params received by then
    this.sleeping = true;

  }

  param(id, value) {
    this.p[id] = id === 'seed' && this.salt ? Math.round(value) + this.salt * 1000 : value;
  }

  // Seed -> room: delay lengths, tap pattern, signs, modulation and diffuser lengths.
  layout(seed) {
    const sr = sampleRate;
    const r = mulberry32(Math.round(seed) * 7919 + 12345);
    const order = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // log-spaced slots with a random position inside each slot: no two lines share a length
    for (let k = 0; k < N; k++) {
      const t = (k + 0.15 + 0.7 * r()) / N;
      this.base[order[k]] = LINE_MIN * Math.pow(LINE_MAX / LINE_MIN, t) * sr;
    }
    const sign = () => (r() < 0.5 ? -1 : 1);
    for (let i = 0; i < N; i++) {
      this.inSign[i] = sign();
      this.outL[i] = sign();
      this.outR[i] = sign();
      this.modRate[i] = 0.2 + 0.9 * r();
      this.modPhase[i] = r() * TWO_PI;
    }
    for (let ch = 0; ch < 2; ch++) {
      let energy = 0;
      for (let k = 0; k < ER_TAPS; k++) {
        const t = ER_MAX * (0.04 + 0.96 * Math.pow((k + r()) / ER_TAPS, 1.3));
        const g = sign() * (1 - 0.8 * (t / ER_MAX)) * (0.6 + 0.4 * r());
        this.erT[ch][k] = t * sr;
        this.erG[ch][k] = g;
        energy += g * g;
      }
      const norm = 1 / Math.sqrt(energy);
      for (let k = 0; k < ER_TAPS; k++) this.erG[ch][k] *= norm;
      const ranges = [[1.1, 2.9], [2.7, 4.9], [4.6, 7.8], [7.4, 11.5]];
      for (let s = 0; s < AP_STAGES; s++) {
        const [lo, hi] = ranges[s];
        this.apD[ch][s] = Math.round(((lo + (hi - lo) * r()) / 1000) * sr);
      }
    }
    this.activeSeed = seed;
  }

  // Jump all smoothed values to their targets (start-up and wake from sleep: the wet path is silent).
  snap() {
    const p = this.p;
    this.scale = sizeScale(p.size);
    this.pre = Math.min(PREDELAY_MAX, Math.max(0, p.predelay)) * sampleRate;
    this.mixS = p.mix;
    this.earlyS = p.early;
    this.widthS = p.width;
    this.levelS = p.level;
    this.diffS = p.diffusion;
    this.frz = p.freeze ? 1 : 0;
    this.blockCoefs(0);
    this.gStep.fill(0);
    this.aStep.fill(0);
    this.mStep.fill(0);
  }

  // Per-block targets for loop gain, damping pole and modulation offset; interpolated per sample.
  blockCoefs(n) {
    const p = this.p;
    const sr = sampleRate;
    const rt = Math.max(0.05, p.decay);
    const rtHi = rt * (1 - 0.94 * Math.max(0, Math.min(1, p.damp)));
    const f = this.frz;
    const depth = Math.max(0, Math.min(1, p.mod)) * MOD_MAX * sr;
    const inv = n > 0 ? 1 / n : 0;
    for (let i = 0; i < N; i++) {
      const len = this.base[i] * this.scale;
      const gDc = Math.pow(10, (-3 * len) / (rt * sr));
      const gHi = Math.pow(10, (-3 * len) / (rtHi * sr));
      const ratio = gHi / gDc;
      const g = gDc * (1 - f) + f;
      const a = ((1 - ratio) / (1 + ratio)) * (1 - f);
      this.modPhase[i] += (TWO_PI * this.modRate[i] * n) / sr;
      if (this.modPhase[i] > TWO_PI) this.modPhase[i] -= TWO_PI;
      const m = depth * (1 + Math.sin(this.modPhase[i]));
      if (n > 0) {
        this.g0[i] += this.gStep[i] * n;
        this.a0[i] += this.aStep[i] * n;
        this.m0[i] += this.mStep[i] * n;
        this.gStep[i] = (g - this.g0[i]) * inv;
        this.aStep[i] = (a - this.a0[i]) * inv;
        this.mStep[i] = (m - this.m0[i]) * inv;
      } else {
        this.g0[i] = g;
        this.a0[i] = a;
        this.m0[i] = m;
      }
    }
  }

  clear() {
    for (const l of this.lines) l.fill(0);
    for (const b of this.pd) b.fill(0);
    for (const ch of this.ap) for (const b of ch) b.fill(0);
    this.lp.fill(0);
    this.apIn.fill(0);
    this.apOut.fill(0);
    this.filt.fill(0);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    const inp = inputs[0];
    const iL = inp && inp.length ? inp[0] : null;
    const iR = inp && inp.length ? inp[1] || inp[0] : null;

    let inPeak = 0;
    if (iL) for (let s = 0; s < n; s++) inPeak = Math.max(inPeak, Math.abs(iL[s]), Math.abs(iR[s]));
    if (this.sleeping) {
      if (inPeak < SILENT) {
        oL.fill(0);
        if (oR !== oL) oR.fill(0);
        return false;
      }
      this.sleeping = false;
      this.quiet = 0;
      if (this.p.seed !== this.activeSeed) this.layout(this.p.seed);
      this.snap();
    }

    const p = this.p;
    const sr = sampleRate;
    const k20 = 1 - Math.exp(-1 / (0.02 * sr));
    const kSize = 1 - Math.exp(-1 / (0.12 * sr));
    const scaleT = sizeScale(p.size);
    const preT = Math.min(PREDELAY_MAX, Math.max(0, p.predelay)) * sr;
    const mixT = Math.max(0, Math.min(1, p.mix));
    const earlyT = Math.max(0, Math.min(1, p.early));
    const widthT = Math.max(0, Math.min(1, p.width));
    const levelT = p.level;
    const diffT = Math.max(0, Math.min(1, p.diffusion));
    const cLow = 1 - Math.exp((-TWO_PI * Math.max(10, p.lowCut)) / sr);
    const cHigh = 1 - Math.exp((-TWO_PI * Math.min(sr * 0.45, Math.max(200, p.highCut))) / sr);

    // freeze is smoothed per block (~40 ms) and folded into the per-line gain/pole targets
    this.frz += ((p.freeze ? 1 : 0) - this.frz) * (1 - Math.exp(-n / (0.04 * sr)));
    if (Math.abs(this.frz - (p.freeze ? 1 : 0)) < 1e-4) this.frz = p.freeze ? 1 : 0;
    this.blockCoefs(n);

    // seed change: fade the wet path out, swap the room, fade back in
    const fadeStep = 1 / (SEED_FADE * sr);
    const wantSeed = p.seed;

    const lines = this.lines;
    const lm = this.lineLen - 1;
    const base = this.base;
    const lp = this.lp;
    const apIn = this.apIn;
    const apOut = this.apOut;
    const v = this.v;
    const g0 = this.g0, gS = this.gStep, a0 = this.a0, aS = this.aStep, m0 = this.m0, mS = this.mStep;
    const inSign = this.inSign, outL = this.outL, outR = this.outR;
    const [pdL, pdR] = this.pd;
    const pm = this.pdLen - 1;
    const [erTL, erTR] = this.erT;
    const [erGL, erGR] = this.erG;
    const apm = this.apLen - 1;
    const filt = this.filt;
    let w = this.w, pw = this.pw, apw = this.apw;
    let scale = this.scale, pre = this.pre, mixS = this.mixS, earlyS = this.earlyS;
    let widthS = this.widthS, levelS = this.levelS, diffS = this.diffS, fade = this.fade;
    let wetPeak = 0;
    let cMix = NaN, dryG = 0, wetG = 0;

    for (let s = 0; s < n; s++) {
      scale += (scaleT - scale) * kSize;
      pre += (preT - pre) * k20;
      mixS += (mixT - mixS) * k20;
      earlyS += (earlyT - earlyS) * k20;
      widthS += (widthT - widthS) * k20;
      levelS += (levelT - levelS) * k20;
      diffS += (diffT - diffS) * k20;
      if (wantSeed !== this.activeSeed) {
        fade -= fadeStep;
        if (fade <= 0) {
          fade = 0;
          // new room: the old tail can't be carried over (the read-position jump would circulate
          // in the loop as a click), so restart the late network while the wet path is silent
          this.layout(wantSeed);
          for (const l of lines) l.fill(0);
          for (const ch of this.ap) for (const b of ch) b.fill(0);
          lp.fill(0);
          apIn.fill(0);
          apOut.fill(0);
        }
      } else if (fade < 1) fade = Math.min(1, fade + fadeStep);

      const dl = iL ? iL[s] : 0;
      const dr = iR ? iR[s] : 0;

      // tone: one-pole low cut + one-pole high cut on the wet input
      filt[0] += cLow * (dl - filt[0]);
      filt[1] += cLow * (dr - filt[1]);
      filt[2] += cHigh * (dl - filt[0] - filt[2]);
      filt[3] += cHigh * (dr - filt[1] - filt[3]);
      pdL[pw] = filt[2] + DENORMAL;
      pdR[pw] = filt[3] + DENORMAL;

      // pre-delay read (fractional)
      let pos = pw - pre;
      let i0 = Math.floor(pos);
      let fr = pos - i0;
      let x0 = pdL[i0 & pm];
      const pl = x0 + fr * (pdL[(i0 + 1) & pm] - x0);
      x0 = pdR[i0 & pm];
      const pr = x0 + fr * (pdR[(i0 + 1) & pm] - x0);

      // early reflections: taps behind the pre-delay, spread with the room size
      let erL = 0;
      let erR = 0;
      for (let k = 0; k < ER_TAPS; k++) {
        pos = pw - pre - erTL[k] * scale;
        i0 = Math.floor(pos);
        fr = pos - i0;
        x0 = pdL[i0 & pm];
        erL += erGL[k] * (x0 + fr * (pdL[(i0 + 1) & pm] - x0));
        pos = pw - pre - erTR[k] * scale;
        i0 = Math.floor(pos);
        fr = pos - i0;
        x0 = pdR[i0 & pm];
        erR += erGR[k] * (x0 + fr * (pdR[(i0 + 1) & pm] - x0));
      }
      pw = (pw + 1) & pm;

      // input diffusion: series Schroeder all-passes smear the attack into a dense wash
      const gAp = 0.75 * diffS;
      let ul = pl;
      let ur = pr;
      for (let st = 0; st < AP_STAGES; st++) {
        const bl = this.ap[0][st];
        let z = bl[(apw - this.apD[0][st]) & apm];
        let t = ul + gAp * z;
        bl[apw] = t;
        ul = z - gAp * t;
        const br = this.ap[1][st];
        z = br[(apw - this.apD[1][st]) & apm];
        t = ur + gAp * z;
        br[apw] = t;
        ur = z - gAp * t;
      }
      apw = (apw + 1) & apm;

      // FDN: read modulated lines, absorb, tap outputs, mix, feed back
      let lateL = 0;
      let lateR = 0;
      for (let i = 0; i < N; i++) {
        // all-pass fractional delay (flat magnitude, unlike linear interpolation which would add
        // a hidden low-pass to every pass through the loop). Fraction kept in [0.5, 1.5) for stability.
        const d = base[i] * scale + m0[i] + mS[i] * s + 2;
        const mi = Math.floor(d - 0.5);
        const frac = d - mi;
        const eta = (1 - frac) / (1 + frac);
        const xin = lines[i][(w - mi) & lm];
        const x = eta * xin + apIn[i] - eta * apOut[i];
        apIn[i] = xin;
        apOut[i] = x;
        const a = a0[i] + aS[i] * s;
        lp[i] = a * lp[i] + (1 - a) * x;
        const y = (g0[i] + gS[i] * s) * lp[i];
        v[i] = y;
        lateL += outL[i] * y;
        lateR += outR[i] * y;
      }
      for (let h = 1; h < N; h <<= 1) {
        for (let i = 0; i < N; i += h << 1) {
          for (let j = i; j < i + h; j++) {
            const a = v[j];
            const b = v[j + h];
            v[j] = a + b;
            v[j + h] = a - b;
          }
        }
      }
      const inG = (1 - this.frz) * fade; // fade: the new room after a seed swap builds up smoothly
      for (let i = 0; i < N; i++) {
        lines[i][w] = 0.25 * v[i] + inG * inSign[i] * (i & 1 ? ur : ul);
      }
      w = (w + 1) & lm;

      // wet = early + late, stereo width (mid/side), seed fade
      let wl = earlyS * erL + LATE_GAIN * lateL;
      let wr = earlyS * erR + LATE_GAIN * lateR;
      const mid = 0.5 * (wl + wr);
      const side = 0.5 * (wl - wr) * widthS;
      wl = (mid + side) * fade;
      wr = (mid - side) * fade;
      const aw = Math.abs(wl) + Math.abs(wr);
      if (aw > wetPeak) wetPeak = aw;

      // equal-power dry/wet
      if (mixS !== cMix) { // only while the mix glides
        cMix = mixS;
        dryG = Math.cos(mixS * Math.PI * 0.5);
        wetG = Math.sin(mixS * Math.PI * 0.5);
      }
      oL[s] = levelS * (dryG * dl + wetG * wl);
      if (oR !== oL) oR[s] = levelS * (dryG * dr + wetG * wr);
      else oL[s] = levelS * (dryG * 0.5 * (dl + dr) + wetG * 0.5 * (wl + wr));
    }

    this.w = w;
    this.pw = pw;
    this.apw = apw;
    Object.assign(this, { scale, pre, mixS, earlyS, widthS, levelS, diffS, fade });

    // idle detection: nothing coming in and the tail has died away -> sleep
    if (inPeak < SILENT && wetPeak < SILENT && this.frz === 0) {
      this.quiet += n;
      if (this.quiet > SLEEP_AFTER * sr) {
        this.sleeping = true;
        this.clear();
      }
    } else this.quiet = 0;
    return true;
  }
}
