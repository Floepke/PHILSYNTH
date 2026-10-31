// REVERB: seeded 16-line FDN reverb with early reflections and input diffusion. Twin of
// src/modules/reverb.dsp.js (see there for the signal flow).
#pragma once
#include "kernel.h"

namespace ms {

struct Mulberry32 {
  uint32_t a;
  explicit Mulberry32(uint32_t seed) : a(seed) {}
  double operator()() {
    a += 0x6d2b79f5u;
    uint32_t t = (a ^ (a >> 15)) * (1u | a);
    t = (t + (t ^ (t >> 7)) * (61u | t)) ^ t;
    return (t ^ (t >> 14)) / 4294967296.0;
  }
};

struct Reverb : Kernel {
  enum { MIX, SIZE, DECAY, DAMP, SEED, PREDELAY, EARLY, DIFFUSION, MOD, LOW_CUT, HIGH_CUT, WIDTH, FREEZE, LEVEL, PARAMS };
  static constexpr int N = 16;
  static constexpr double MAX_SCALE = 2;
  static constexpr double LINE_MIN = 0.021, LINE_MAX = 0.067;
  static constexpr double MOD_MAX = 0.0012;
  static constexpr int ER_TAPS = 12;
  static constexpr double ER_MAX = 0.085;
  static constexpr int AP_STAGES = 4;
  static constexpr double AP_MAX = 0.012;
  static constexpr double PREDELAY_MAX = 0.5;
  static constexpr double LATE_GAIN = 0.11;
  static constexpr double SEED_FADE = 0.015;
  static constexpr double SLEEP_AFTER = 0.3;
  static constexpr double SILENT = 1e-6;
  static constexpr double DENORMAL = 1e-18;
  static constexpr double TWO_PI = 2 * PI;

  static double sizeScale(double s) { return 0.08 * pow(25, maxd(0, mind(1, s))); }
  static int pow2(double n) { return 1 << (int)ceil(log2(n)); }

  int salt;
  double p[PARAMS] = {0.3, 0.5, 2.5, 0.5, 1, 0.02, 0.4, 0.75, 0.3, 60, 14000, 1, 0, 1};

  int lineLen, pdLen, apLen;
  float* lines[N];
  float* pd[2];
  float* ap[2][AP_STAGES];
  int w = 0, pw = 0, apw = 0;

  double base[N], inSign[N], outL[N], outR[N], modRate[N], modPhase[N];
  double erT[2][ER_TAPS], erG[2][ER_TAPS];
  int apD[2][AP_STAGES];
  double lp[N] = {}, apIn[N] = {}, apOut[N] = {}, v[N] = {};
  double g0[N] = {}, gStep[N] = {}, a0[N] = {}, aStep[N] = {}, m0[N] = {}, mStep[N] = {};
  double filt[4] = {};

  double activeSeed = 0;
  double scale = 1, pre = 0, mixS = 0, earlyS = 0, widthS = 0, levelS = 0, diffS = 0, frz = 0;
  double fade = 1, quiet = 0;
  bool sleeping = true;

  Reverb(double sampleRate, int salt_) : Kernel(sampleRate), salt(salt_) {
    lineLen = pow2(LINE_MAX * 1.1 * MAX_SCALE * sr + MOD_MAX * sr + 8);
    for (auto& l : lines) l = (float*)calloc(lineLen, sizeof(float));
    pdLen = pow2((PREDELAY_MAX + ER_MAX * MAX_SCALE) * sr + 8);
    for (auto& b : pd) b = (float*)calloc(pdLen, sizeof(float));
    apLen = pow2(AP_MAX * sr + 4);
    for (auto& ch : ap) for (auto& b : ch) b = (float*)calloc(apLen, sizeof(float));
    layout(p[SEED]);
    snap();
  }

  ~Reverb() override {
    for (auto l : lines) free(l);
    for (auto b : pd) free(b);
    for (auto& ch : ap) for (auto b : ch) free(b);
  }

  void param(int id, double value) override {
    if (id < 0 || id >= PARAMS) return;
    p[id] = id == SEED && salt ? jsRound(value) + salt * 1000.0 : value;
  }

  void layout(double seed) {
    Mulberry32 r(toUint32(jsRound(seed) * 7919 + 12345));
    int order[N];
    for (int i = 0; i < N; i++) order[i] = i;
    for (int i = N - 1; i > 0; i--) {
      const int j = (int)floor(r() * (i + 1));
      const int t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    for (int k = 0; k < N; k++) {
      const double t = (k + 0.15 + 0.7 * r()) / N;
      base[order[k]] = LINE_MIN * pow(LINE_MAX / LINE_MIN, t) * sr;
    }
    auto sign = [&]() { return r() < 0.5 ? -1.0 : 1.0; };
    for (int i = 0; i < N; i++) {
      inSign[i] = sign();
      outL[i] = sign();
      outR[i] = sign();
      modRate[i] = 0.2 + 0.9 * r();
      modPhase[i] = r() * TWO_PI;
    }
    static const double ranges[AP_STAGES][2] = {{1.1, 2.9}, {2.7, 4.9}, {4.6, 7.8}, {7.4, 11.5}};
    for (int ch = 0; ch < 2; ch++) {
      double energy = 0;
      for (int k = 0; k < ER_TAPS; k++) {
        const double t = ER_MAX * (0.04 + 0.96 * pow((k + r()) / ER_TAPS, 1.3));
        const double s = sign();
        const double g = s * (1 - 0.8 * (t / ER_MAX)) * (0.6 + 0.4 * r());
        erT[ch][k] = t * sr;
        erG[ch][k] = g;
        energy += g * g;
      }
      const double norm = 1 / sqrt(energy);
      for (int k = 0; k < ER_TAPS; k++) erG[ch][k] *= norm;
      for (int s = 0; s < AP_STAGES; s++) {
        const double lo = ranges[s][0], hi = ranges[s][1];
        apD[ch][s] = (int)jsRound(((lo + (hi - lo) * r()) / 1000) * sr);
      }
    }
    activeSeed = seed;
  }

  void snap() {
    scale = sizeScale(p[SIZE]);
    pre = mind(PREDELAY_MAX, maxd(0, p[PREDELAY])) * sr;
    mixS = p[MIX];
    earlyS = p[EARLY];
    widthS = p[WIDTH];
    levelS = p[LEVEL];
    diffS = p[DIFFUSION];
    frz = p[FREEZE] != 0 ? 1 : 0;
    blockCoefs(0);
    for (int i = 0; i < N; i++) gStep[i] = aStep[i] = mStep[i] = 0;
  }

  void blockCoefs(int n) {
    const double rt = maxd(0.05, p[DECAY]);
    const double rtHi = rt * (1 - 0.94 * maxd(0, mind(1, p[DAMP])));
    const double f = frz;
    const double depth = maxd(0, mind(1, p[MOD])) * MOD_MAX * sr;
    const double inv = n > 0 ? 1.0 / n : 0;
    for (int i = 0; i < N; i++) {
      const double len = base[i] * scale;
      const double gDc = pow(10, (-3 * len) / (rt * sr));
      const double gHi = pow(10, (-3 * len) / (rtHi * sr));
      const double ratio = gHi / gDc;
      const double g = gDc * (1 - f) + f;
      const double a = ((1 - ratio) / (1 + ratio)) * (1 - f);
      modPhase[i] += (TWO_PI * modRate[i] * n) / sr;
      if (modPhase[i] > TWO_PI) modPhase[i] -= TWO_PI;
      const double m = depth * (1 + sin(modPhase[i]));
      if (n > 0) {
        g0[i] += gStep[i] * n;
        a0[i] += aStep[i] * n;
        m0[i] += mStep[i] * n;
        gStep[i] = (g - g0[i]) * inv;
        aStep[i] = (a - a0[i]) * inv;
        mStep[i] = (m - m0[i]) * inv;
      } else {
        g0[i] = g;
        a0[i] = a;
        m0[i] = m;
      }
    }
  }

  void clearLate() {
    for (auto l : lines) memset(l, 0, lineLen * sizeof(float));
    for (auto& ch : ap) for (auto b : ch) memset(b, 0, apLen * sizeof(float));
    for (int i = 0; i < N; i++) lp[i] = apIn[i] = apOut[i] = 0;
  }

  void clear() {
    clearLate();
    for (auto b : pd) memset(b, 0, pdLen * sizeof(float));
    for (auto& f : filt) f = 0;
  }

  // silent at once, asleep until the next input (which snaps the smoothers again)
  void panic() override {
    clear();
    sleeping = true;
    quiet = 0;
  }

  int process(const float* iL, const float* iR, float* oL, float* oR, int n) override {
    if (iL && !iR) iR = iL;
    double inPeak = 0;
    if (iL) for (int s = 0; s < n; s++) inPeak = maxd(inPeak, maxd(fabs(iL[s]), fabs(iR[s])));
    if (sleeping) {
      if (inPeak < SILENT) {
        memset(oL, 0, n * sizeof(float));
        if (oR != oL) memset(oR, 0, n * sizeof(float));
        return 0;
      }
      sleeping = false;
      quiet = 0;
      if (p[SEED] != activeSeed) layout(p[SEED]);
      snap();
    }

    const double k20 = 1 - exp(-1 / (0.02 * sr));
    const double kSize = 1 - exp(-1 / (0.12 * sr));
    const double scaleT = sizeScale(p[SIZE]);
    const double preT = mind(PREDELAY_MAX, maxd(0, p[PREDELAY])) * sr;
    const double mixT = maxd(0, mind(1, p[MIX]));
    const double earlyT = maxd(0, mind(1, p[EARLY]));
    const double widthT = maxd(0, mind(1, p[WIDTH]));
    const double levelT = p[LEVEL];
    const double diffT = maxd(0, mind(1, p[DIFFUSION]));
    const double cLow = 1 - exp((-TWO_PI * maxd(10, p[LOW_CUT])) / sr);
    const double cHigh = 1 - exp((-TWO_PI * mind(sr * 0.45, maxd(200, p[HIGH_CUT]))) / sr);
    const double freezeT = p[FREEZE] != 0 ? 1 : 0;

    frz += (freezeT - frz) * (1 - exp(-n / (0.04 * sr)));
    if (fabs(frz - freezeT) < 1e-4) frz = freezeT;
    blockCoefs(n);

    const double fadeStep = 1 / (SEED_FADE * sr);
    const double wantSeed = p[SEED];
    const int lm = lineLen - 1;
    const int pm = pdLen - 1;
    const int apm = apLen - 1;
    float* pdL = pd[0];
    float* pdR = pd[1];
    double wetPeak = 0;
    double cMix = NAN, dryG = 0, wetG = 0;

    for (int s = 0; s < n; s++) {
      scale += (scaleT - scale) * kSize;
      pre += (preT - pre) * k20;
      mixS += (mixT - mixS) * k20;
      earlyS += (earlyT - earlyS) * k20;
      widthS += (widthT - widthS) * k20;
      levelS += (levelT - levelS) * k20;
      diffS += (diffT - diffS) * k20;
      if (wantSeed != activeSeed) {
        fade -= fadeStep;
        if (fade <= 0) {
          fade = 0;
          layout(wantSeed);
          clearLate();
        }
      } else if (fade < 1) fade = mind(1, fade + fadeStep);

      const double dl = iL ? (double)iL[s] : 0.0;
      const double dr = iR ? (double)iR[s] : 0.0;

      filt[0] += cLow * (dl - filt[0]);
      filt[1] += cLow * (dr - filt[1]);
      filt[2] += cHigh * (dl - filt[0] - filt[2]);
      filt[3] += cHigh * (dr - filt[1] - filt[3]);
      pdL[pw] = (float)(filt[2] + DENORMAL);
      pdR[pw] = (float)(filt[3] + DENORMAL);

      double pos = pw - pre;
      int i0 = (int)floor(pos);
      double fr = pos - i0;
      double x0 = pdL[i0 & pm];
      const double pl = x0 + fr * (pdL[(i0 + 1) & pm] - x0);
      x0 = pdR[i0 & pm];
      const double pr = x0 + fr * (pdR[(i0 + 1) & pm] - x0);

      // early reflections: tap positions two at a time (SIMD), reads and sums in order
      alignas(16) double tapF[2 * ER_TAPS], tapFr[2 * ER_TAPS];
      {
        const d2 at = splat(pw - pre), sc = splat(scale);
        const double* t = &erT[0][0];
        for (int k = 0; k < 2 * ER_TAPS; k += 2) {
          const d2 ps = at - load2(t + k) * sc;
          const d2 f = floor2(ps);
          store2(tapF + k, f);
          store2(tapFr + k, ps - f);
        }
      }
      double erL = 0, erR = 0;
      for (int k = 0; k < ER_TAPS; k++) {
        i0 = (int)tapF[k];
        x0 = pdL[i0 & pm];
        erL += erG[0][k] * (x0 + tapFr[k] * (pdL[(i0 + 1) & pm] - x0));
        i0 = (int)tapF[ER_TAPS + k];
        x0 = pdR[i0 & pm];
        erR += erG[1][k] * (x0 + tapFr[ER_TAPS + k] * (pdR[(i0 + 1) & pm] - x0));
      }
      pw = (pw + 1) & pm;

      const double gAp = 0.75 * diffS;
      double ul = pl, ur = pr;
      for (int st = 0; st < AP_STAGES; st++) {
        float* bl = ap[0][st];
        double z = bl[(apw - apD[0][st]) & apm];
        double t = ul + gAp * z;
        bl[apw] = (float)t;
        ul = z - gAp * t;
        float* br = ap[1][st];
        z = br[(apw - apD[1][st]) & apm];
        t = ur + gAp * z;
        br[apw] = (float)t;
        ur = z - gAp * t;
      }
      apw = (apw + 1) & apm;

      // late: the 16 lines two at a time (SIMD) around the delay-line reads; sums in order
      alignas(16) double lineF[N], eta[N], xin[N];
      const d2 sc = splat(scale), sv = splat(s);
      for (int i = 0; i < N; i += 2) {
        const d2 d = load2(base + i) * sc + load2(m0 + i) + load2(mStep + i) * sv + 2.0;
        const d2 f = floor2(d - 0.5);
        const d2 frac = d - f;
        store2(lineF + i, f);
        store2(eta + i, (1.0 - frac) / (1.0 + frac));
      }
      for (int i = 0; i < N; i++) xin[i] = lines[i][(w - (int)lineF[i]) & lm];
      for (int i = 0; i < N; i += 2) {
        const d2 e = load2(eta + i), xi = load2(xin + i);
        const d2 x = e * xi + load2(apIn + i) - e * load2(apOut + i);
        store2(apIn + i, xi);
        store2(apOut + i, x);
        const d2 a = load2(a0 + i) + load2(aStep + i) * sv;
        const d2 l = a * load2(lp + i) + (1.0 - a) * x;
        store2(lp + i, l);
        store2(v + i, (load2(g0 + i) + load2(gStep + i) * sv) * l);
      }
      double lateL = 0, lateR = 0;
      for (int i = 0; i < N; i++) {
        lateL += outL[i] * v[i];
        lateR += outR[i] * v[i];
      }
      for (int h = 1; h < N; h <<= 1) {
        for (int i = 0; i < N; i += h << 1) {
          for (int j = i; j < i + h; j++) {
            const double a = v[j];
            const double b = v[j + h];
            v[j] = a + b;
            v[j + h] = a - b;
          }
        }
      }
      const double inG = (1 - frz) * fade;
      for (int i = 0; i < N; i++) lines[i][w] = (float)(0.25 * v[i] + inG * inSign[i] * (i & 1 ? ur : ul));
      w = (w + 1) & lm;

      double wl = earlyS * erL + LATE_GAIN * lateL;
      double wr = earlyS * erR + LATE_GAIN * lateR;
      const double mid = 0.5 * (wl + wr);
      const double side = 0.5 * (wl - wr) * widthS;
      wl = (mid + side) * fade;
      wr = (mid - side) * fade;
      const double aw = fabs(wl) + fabs(wr);
      if (aw > wetPeak) wetPeak = aw;

      if (mixS != cMix) {  // only while the mix glides
        cMix = mixS;
        dryG = cos(mixS * PI * 0.5);
        wetG = sin(mixS * PI * 0.5);
      }
      if (oR != oL) {
        oL[s] = (float)(levelS * (dryG * dl + wetG * wl));
        oR[s] = (float)(levelS * (dryG * dr + wetG * wr));
      } else oL[s] = (float)(levelS * (dryG * 0.5 * (dl + dr) + wetG * 0.5 * (wl + wr)));
    }

    if (inPeak < SILENT && wetPeak < SILENT && frz == 0) {
      quiet += n;
      if (quiet > SLEEP_AFTER * sr) {
        sleeping = true;
        clear();
      }
    } else quiet = 0;
    return 1;
  }
};

}  // namespace ms
