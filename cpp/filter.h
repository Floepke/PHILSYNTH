// FILTER: multi-mode filter (ZDF SVF cascade, ZDF ladder, formant, comb). Twin of
// src/modules/filter.dsp.js.
#pragma once
#include "kernel.h"
#include "svf.h"

namespace ms {

struct Filter : Kernel {
  enum { TYPE, SLOPE, CUTOFF, RESONANCE, GAIN, VOWEL, DRIVE, LFO_SHAPE, LFO_RATE, LFO_DEPTH, MIX, LEVEL, PARAMS };
  enum { LP, HP, BP, NOTCH, PEAK, AP, BELL, LSHELF, HSHELF, LADDER, COMB_POS, COMB_NEG, FORMANT };
  static constexpr int TAIL_BLOCKS = 8;
  static constexpr int MAX_STAGES = 4;
  static constexpr int CHANNELS = 2;
  static constexpr double ANTI_DENORMAL = 1e-20;

  double p[PARAMS] = {LP, 1, 1000, 0.1, 0, 0, 0, 0, 1, 0, 1, 1};
  // smoothed copies
  double sLogF, sRes = 0.1, sGain = 0, sVowel = 0, sDrive = 0, sMix = 1, sLevel = 1;
  double smooth, fMax;
  Svf svf[CHANNELS][MAX_STAGES];
  double ladder[CHANNELS][4] = {};
  Svf formant[CHANNELS][3];
  int combLen, combPos = 0;
  float* comb[CHANNELS];
  double lfoPhase = 0, lfoHold = 0, lfoFrom = 0, lfoTo, lfoLast = 0;
  double v1 = 0, v2 = 0;
  int quiet = 0;
  Rng rng;
  // coefficient caches: recomputed only when the smoothed values they depend on change (bit-
  // identical to computing them every sample, which the JS twin did before it got the same caches)
  double cLogF = NAN, fc = 0, wd = 0;
  double cDrive = NAN, driveGain = 1, driveNorm = 1;
  double cRes = NAN, cGain = NAN;
  int cType = -1;
  bool svfDirty = true;
  double k = 0, a1 = 0, a2 = 0, a3 = 0, kB = 0, b1 = 0, b2 = 0, b3 = 0, A = 1;
  double cVowel = NAN, cOct = NAN, cResF = NAN, kF = 0;
  double fmC1[3] = {}, fmG[3] = {}, fmAmp[3] = {};

  Filter(double sampleRate, uint32_t seed) : Kernel(sampleRate), rng(seed) {
    sLogF = log2(1000.0);
    smooth = 1 - exp(-1 / (0.004 * sr));
    fMax = mind(20000, sr * 0.45);
    combLen = (int)ceil(sr / 10) + 4;
    for (auto& c : comb) c = (float*)calloc(combLen, sizeof(float));
    lfoTo = rng.next() * 2 - 1;
  }
  ~Filter() override { for (auto c : comb) free(c); }

  static int family(int t) { return t <= HSHELF ? 0 : t == LADDER ? 1 : t == FORMANT ? 2 : 3; }

  void param(int id, double value) override {
    if (id < 0 || id >= PARAMS) return;
    if (id == TYPE && family(toInt32(value)) != family(toInt32(p[TYPE]))) reset();
    if (id == LFO_SHAPE && toInt32(value) == 5 && toInt32(p[LFO_SHAPE]) != 5) lfoFrom = lfoTo = lfoLast;
    p[id] = value;
  }

  void panic() override { reset(); }
  void reset() {
    for (auto& ch : svf) for (auto& st : ch) st.ic1 = st.ic2 = 0;
    for (auto& ch : formant) for (auto& st : ch) st.ic1 = st.ic2 = 0;
    for (auto& st : ladder) for (auto& x : st) x = 0;
    for (auto c : comb) memset(c, 0, combLen * sizeof(float));
  }

  inline void tick(Svf& st, double x0, double a1, double a2, double a3) {
    st.tick(x0, a1, a2, a3);
    v1 = st.band;
    v2 = st.low;
  }

  // need: the value is used (else only the phase moves; lfoLast is only read between blocks, so
  // the last sample of a block always computes it)
  double lfo(bool need) {
    const double ph = lfoPhase;
    double v = lfoLast;
    if (need) switch (toInt32(p[LFO_SHAPE])) {
      case 1: v = 1 - 4 * fabs(ph - 0.5); break;
      case 2: v = 2 * ph - 1; break;
      case 3: v = ph < 0.5 ? 1 : -1; break;
      case 4: v = lfoHold; break;
      case 5: { const double k = ph * ph * (3 - 2 * ph); v = lfoFrom + (lfoTo - lfoFrom) * k; break; }
      default: v = sin(2 * PI * ph);
    }
    lfoPhase += p[LFO_RATE] / sr;
    if (lfoPhase >= 1) {
      lfoPhase -= 1;
      lfoHold = rng.next() * 2 - 1;
      lfoFrom = lfoTo;
      lfoTo = rng.next() * 2 - 1;
    }
    lfoLast = v;
    return v;
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    const bool live = inL != nullptr;
    if (!live && quiet > TAIL_BLOCKS) {
      memset(outL, 0, n * sizeof(float));
      if (outR != outL) memset(outR, 0, n * sizeof(float));
      return 0;
    }
    const float* in[CHANNELS] = {inL, inR ? inR : inL};
    float* out[CHANNELS] = {outL, outR};
    const int nProc = outR != outL ? 2 : 1;

    static const double VOWELS[5][3][2] = {
      {{800, 1}, {1150, 0.5}, {2900, 0.025}},
      {{350, 1}, {2000, 0.1}, {2800, 0.18}},
      {{270, 1}, {2140, 0.25}, {2950, 0.05}},
      {{450, 1}, {800, 0.28}, {2830, 0.08}},
      {{325, 1}, {700, 0.25}, {2530, 0.03}},
    };
    const double sm = smooth;
    const int type = toInt32(p[TYPE]);
    const double targetLogF = log2(maxd(10, mind(fMax, p[CUTOFF])));
    int stages = 1;
    if (type <= AP) {
      const int s = toInt32(p[SLOPE]) + 1;
      stages = s < MAX_STAGES ? s : MAX_STAGES;
    }
    const double lfoDepth = p[LFO_DEPTH];

    for (int i = 0; i < n; i++) {
      double lfoOct;
      if (lfoDepth != 0 && lfoDepth == lfoDepth) lfoOct = lfo(true) * lfoDepth;
      else { lfo(i == n - 1); lfoOct = 0; }
      sLogF += (targetLogF + lfoOct - sLogF) * sm;
      sRes += (p[RESONANCE] - sRes) * sm;
      sGain += (p[GAIN] - sGain) * sm;
      sVowel += (p[VOWEL] - sVowel) * sm;
      sDrive += (p[DRIVE] - sDrive) * sm;
      sMix += (p[MIX] - sMix) * sm;
      sLevel += (p[LEVEL] - sLevel) * sm;

      if (sLogF != cLogF) {
        cLogF = sLogF;
        fc = maxd(10, mind(fMax, exp(sLogF * LN2)));
        wd = tan((PI * fc) / sr);
        svfDirty = true;
      }
      if (sDrive != cDrive) {
        cDrive = sDrive;
        driveGain = 1 + sDrive * 9;
        driveNorm = 1 / tanh(driveGain);
      }

      if (type <= HSHELF && (svfDirty || sRes != cRes || sGain != cGain || type != cType)) {
        svfDirty = false;
        cRes = sRes;
        cGain = sGain;
        cType = type;
        const double Q = type == LSHELF || type == HSHELF ? 0.5 + sRes * 1.5 : 0.5 * pow(80, sRes);
        A = pow(10, sGain / 40);
        double g = wd;
        k = 1 / Q;
        if (type == BELL) k = 1 / (Q * A);
        else if (type == LSHELF) g = wd / sqrt(A);
        else if (type == HSHELF) g = wd * sqrt(A);
        a1 = 1 / (1 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
        kB = SQRT2;
        b1 = 1 / (1 + wd * (wd + kB));
        b2 = wd * b1;
        b3 = wd * b2;
      }
      if (type == FORMANT && (sVowel != cVowel || lfoOct != cOct || sRes != cResF)) {
        cVowel = sVowel;
        cOct = lfoOct;
        cResF = sRes;
        const double vi = maxd(0, mind(4, sVowel));
        const int i0 = (int)mind(3, floor(vi));
        const double fr = vi - i0;
        const double shift = pow(2, lfoOct);
        const double Q = 5 + sRes * 25;
        kF = 1 / Q;
        for (int f = 0; f < 3; f++) {
          const double f0 = VOWELS[i0][f][0], g0 = VOWELS[i0][f][1];
          const double f1 = VOWELS[i0 + 1][f][0], g1 = VOWELS[i0 + 1][f][1];
          const double ff = mind(fMax, f0 * pow(f1 / f0, fr) * shift);
          fmAmp[f] = g0 + (g1 - g0) * fr;
          fmG[f] = tan((PI * ff) / sr);
          fmC1[f] = 1 / (1 + fmG[f] * (fmG[f] + kF));
        }
      }

      for (int c = 0; c < nProc; c++) {
        const double dry = live ? (double)in[c][i] : 0.0;
        double x = dry;
        if (sDrive > 1e-4) x += (tanh(x * driveGain) * driveNorm - x) * sDrive;
        x += ANTI_DENORMAL;
        double y;

        if (type <= HSHELF) {
          Svf* chain = svf[c];
          for (int st = 0; st < stages; st++) {
            const bool last = st == stages - 1;
            const double kk = last ? k : kB;
            if (last) tick(chain[st], x, a1, a2, a3);
            else tick(chain[st], x, b1, b2, b3);
            switch (type) {
              case LP: x = v2; break;
              case HP: x = x - kk * v1 - v2; break;
              case BP: x = kk * v1; break;
              case NOTCH: x = x - kk * v1; break;
              case PEAK: x = 2 * v2 - x + kk * v1; break;
              case AP: x = x - 2 * kk * v1; break;
              case BELL: x = x + k * (A * A - 1) * v1; break;
              case LSHELF: x = x + k * (A - 1) * v1 + (A * A - 1) * v2; break;
              case HSHELF: x = A * A * x + k * (1 - A) * A * v1 + (1 - A * A) * v2; break;
            }
          }
          y = x;
        } else if (type == LADDER) {
          double* st = ladder[c];
          const double G = wd / (1 + wd);
          const double b = 1 - G;
          const double kL = sRes * 4.2;
          const double G2 = G * G;
          const double S = G2 * G * b * st[0] + G2 * b * st[1] + G * b * st[2] + b * st[3];
          double u = tanh((x * (1 + kL * 0.5) - kL * S) / (1 + kL * G2 * G2));
          for (int j = 0; j < 4; j++) {
            const double v = (u - st[j]) * G;
            u = v + st[j];
            st[j] = u + v;
          }
          y = u;
        } else if (type == FORMANT) {
          y = 0;
          for (int f = 0; f < 3; f++) {
            const double g = fmG[f], c1 = fmC1[f];
            tick(formant[c][f], x, c1, g * c1, g * g * c1);
            y += kF * v1 * fmAmp[f];
          }
          y *= 2;
        } else {
          float* buf = comb[c];
          const int len = combLen;
          const double fb = (type == COMB_NEG ? -1 : 1) * sRes * 0.97;
          const double d = mind(len - 2, sr / fc);
          double rp = combPos - d;
          if (rp < 0) rp += len;
          const int r0 = (int)rp;
          const double fr = rp - r0;
          const double delayed = buf[r0] + ((double)buf[(r0 + 1) % len] - buf[r0]) * fr;
          const double w = x + fb * delayed;
          buf[combPos] = (float)w;
          y = w * (1 - fabs(fb));
        }

        out[c][i] = (float)((dry + (y - dry) * sMix) * sLevel);
      }
      if (type == COMB_POS || type == COMB_NEG) combPos = (combPos + 1) % combLen;
    }

    if (live) quiet = 0;
    else {
      double peak = 0;
      for (int c = 0; c < nProc; c++)
        for (int i = 0; i < n; i++) peak = maxd(peak, fabs(out[c][i]));
      quiet = peak < 1e-6 ? quiet + 1 : 0;
    }
    return 1;
  }
};

}  // namespace ms
