// EQ: 16-band graphic equalizer. Twin of src/modules/eq.dsp.js (see there); change both together.
#pragma once
#include "kernel.h"

namespace ms {

struct Eq : Kernel {
  static constexpr int N = 16;
  enum { Q = N, LEVEL, PARAMS };  // 0..15: band gains (dB)
  static constexpr double GLIDE_S = 0.02;
  static constexpr double SILENT = 1e-6;
  static constexpr double BANDS[N] = {20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500, 20000};

  double t[N] = {}, g[N] = {}, c[N * 5] = {}, z[N * 4] = {};
  double q = 2.1, level = 0, lv = 0;
  bool dirty = true, live = false;
  float zero[4096] = {};

  explicit Eq(double sampleRate) : Kernel(sampleRate) {}
  void panic() override {
    for (auto& v : z) v = 0;
    live = false;
  }

  void param(int id, double v) override {
    if (id == Q) { if (v != q) { q = v; dirty = true; } }
    else if (id == LEVEL) level = v;
    else if (id >= 0 && id < N) t[id] = v;
  }

  void peaking(double f, double db, double* out) const {
    const double A = pow(10, db / 40);
    const double w = 2 * PI * mind(f, 0.45 * sr) / sr;
    const double cs = cos(w);
    const double al = sin(w) / (2 * q);
    const double a0 = 1 + al / A;
    out[0] = (1 + al * A) / a0;
    out[1] = -2 * cs / a0;
    out[2] = (1 - al * A) / a0;
    out[3] = -2 * cs / a0;
    out[4] = (1 - al / A) / a0;
  }

  void glide(int n) {
    const double k = 1 - exp(-n / (GLIDE_S * sr));
    for (int i = 0; i < N; i++) {
      const double ti = t[i];
      double gi = g[i];
      const bool moved = gi != ti;
      if (moved) {
        gi += (ti - gi) * k;
        if (fabs(ti - gi) < 0.01) gi = ti;
        g[i] = gi;
      }
      if (moved || dirty) peaking(BANDS[i], gi, c + i * 5);
      if (gi == 0) for (int j = 0; j < 4; j++) z[i * 4 + j] = 0;
    }
    dirty = false;
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    const float* src[2] = {inL, inR ? inR : inL};
    const bool ring = !inL;
    if (ring) {
      if (!live) return 0;
      src[0] = src[1] = zero;  // ring out (n <= 4096: the adapter's scratch size)
    }
    glide(n);
    const double from = pow(10, lv / 20);
    if (lv != level) {
      lv += (level - lv) * (1 - exp(-n / (GLIDE_S * sr)));
      if (fabs(level - lv) < 0.01) lv = level;
    }
    const double to = pow(10, lv / 20);
    const double step = (to - from) / n;
    double peak = 0;
    float* dst[2] = {outL, outR};
    const int chans = outR != outL ? 2 : 1;
    for (int ch = 0; ch < chans; ch++) {
      float* d = dst[ch];
      if (d != src[ch]) memcpy(d, src[ch], n * sizeof(float));
      for (int b = 0; b < N; b++) {
        if (g[b] == 0) continue;
        const double b0 = c[b * 5], b1 = c[b * 5 + 1], b2 = c[b * 5 + 2], a1 = c[b * 5 + 3], a2 = c[b * 5 + 4];
        const int zi = b * 4 + ch * 2;
        double z1 = z[zi], z2 = z[zi + 1];
        for (int i = 0; i < n; i++) {
          const double x = d[i];
          const double y = b0 * x + z1;
          z1 = b1 * x - a1 * y + z2;
          z2 = b2 * x - a2 * y;
          d[i] = (float)y;
        }
        z[zi] = fabs(z1) < 1e-20 ? 0 : z1;
        z[zi + 1] = fabs(z2) < 1e-20 ? 0 : z2;
      }
      for (int i = 0; i < n; i++) {
        const double y = d[i] * (from + step * (i + 1));
        d[i] = (float)y;
        const double a = fabs(y);
        if (a > peak) peak = a;
      }
    }
    if (ring && peak < SILENT) {
      for (int i = 0; i < N * 4; i++) z[i] = 0;
      live = false;
      return 0;
    }
    live = true;
    return 1;
  }
};

}  // namespace ms
