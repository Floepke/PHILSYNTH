// The small audio kernels, so a graph can run entirely in C++ (engine.cpp ms_run): the signal bus
// (src/dsp/kernel.js BusKernel), AMP (src/modules/amp.dsp.js) and the Output module
// (src/modules/out.dsp.js) and the DC BLOCKER (src/modules/dcblock.dsp.js). Twins of the JS kernels.
#pragma once
#include "kernel.h"

namespace ms {

struct Bus : Kernel {
  enum { PARAMS };
  explicit Bus(double sampleRate) : Kernel(sampleRate) {}

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    if (!inL) return 0;
    memcpy(outL, inL, n * sizeof(float));
    if (outR != outL) memcpy(outR, inR ? inR : inL, n * sizeof(float));
    return 1;
  }
};

struct Amp : Kernel {
  enum { AMP, INVERSE, PAN, PARAMS };
  static constexpr double SMOOTH_S = 0.005;
  double amp = 1, inverse = 0, pan = 0;
  double t[2] = {1, 1}, g[2] = {1, 1};
  double k;

  explicit Amp(double sampleRate) : Kernel(sampleRate) { k = 1 - exp(-1 / (SMOOTH_S * sr)); }

  void param(int id, double v) override {
    if (id == AMP) amp = v;
    else if (id == INVERSE) inverse = v;
    else if (id == PAN) pan = v;
    else return;
    const double a = amp * (inverse >= 0.5 ? -1 : 1);
    t[0] = a * mind(1, 1 - pan);
    t[1] = a * mind(1, 1 + pan);
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    if (!inL) return 0;
    const float* src[2] = {inL, inR ? inR : inL};
    float* dst[2] = {outL, outR};
    const int chans = outR != outL ? 2 : 1;
    for (int c = 0; c < chans; c++) {
      const float* s = src[c];
      float* d = dst[c];
      const double tc = t[c];
      double gc = g[c];
      if (gc == tc) {
        const float gf = (float)gc;
        // float × double rounded to float: the same as JS when the gain is exactly a float
        if ((double)gf == gc) for (int i = 0; i < n; i++) d[i] = s[i] * gf;
        else for (int i = 0; i < n; i++) d[i] = (float)(s[i] * gc);
      } else {
        for (int i = 0; i < n; i++) { gc += (tc - gc) * k; d[i] = (float)(s[i] * gc); }
        g[c] = fabs(gc - tc) < 1e-6 ? tc : gc;
      }
    }
    return 1;
  }
};

struct Out : Kernel {
  enum { VOLUME, BPM, PARAMS };
  static constexpr double SMOOTH_S = 0.01;
  double volume = 0.8, g = 0, k;
  bool hasG = false;

  explicit Out(double sampleRate) : Kernel(sampleRate) { k = 1 - exp(-1 / (SMOOTH_S * sr)); }

  void param(int id, double v) override {
    if (id != VOLUME) return;
    volume = v;
    if (!hasG) { g = v; hasG = true; }
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    if (!inL) return 0;
    const float* b = inR ? inR : inL;
    const double t = volume;
    double gg = hasG ? g : t;
    for (int i = 0; i < n; i++) {
      gg += (t - gg) * k;
      outL[i] = (float)(inL[i] * gg);
      outR[i] = (float)(b[i] * gg);  // mono (outR == outL): R wins, like the JS kernel
    }
    g = fabs(gg - t) < 1e-6 ? t : gg;
    hasG = true;
    return 1;
  }
};

// one-pole high-pass y = x - x1 + r * y1, ~10 Hz corner
struct DcBlock : Kernel {
  enum { PARAMS };
  static constexpr double CUTOFF_HZ = 10;
  double r, x1[2] = {0, 0}, y1[2] = {0, 0};

  explicit DcBlock(double sampleRate) : Kernel(sampleRate) { r = exp(-2 * PI * CUTOFF_HZ / sr); }
  void panic() override { x1[0] = x1[1] = y1[0] = y1[1] = 0; }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    if (!inL) return 0;
    const float* src[2] = {inL, inR ? inR : inL};
    float* dst[2] = {outL, outR};
    const int chans = outR != outL ? 2 : 1;
    for (int c = 0; c < chans; c++) {
      const float* s = src[c];
      float* d = dst[c];
      double x1c = x1[c], y1c = y1[c];
      for (int i = 0; i < n; i++) {
        const double x = s[i];
        y1c = x - x1c + r * y1c;
        x1c = x;
        d[i] = (float)y1c;
      }
      x1[c] = x1c;
      y1[c] = fabs(y1c) < 1e-20 ? 0 : y1c;
    }
    return 1;
  }
};

}  // namespace ms
