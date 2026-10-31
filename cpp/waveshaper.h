// WAVESHAPER: drive -> curve table (optionally oversampled) -> DC blocker, dry/wet, level. Twin of
// src/modules/waveshaper.dsp.js. The table is built from the curve on the JS side (curve.js) and
// written into data(0) by the adapter (src/dsp/wasm.js), which also handles 'range'.
#pragma once
#include "kernel.h"

namespace ms {

struct Waveshaper : Kernel {
  enum { DRIVE, RANGE, OVERSAMPLE, MIX, LEVEL, PARAMS };
  static constexpr int TABLE = 4096;
  static constexpr double SMOOTH_S = 0.01;
  static constexpr double DC_HZ = 8;
  enum { T_DRIVE, T_WET, T_DRY, T_LEVEL, T_N };

  float table[TABLE];
  int os = 1;
  double t[T_N] = {1, 1, 0, 1};  // targets
  double s[T_N] = {1, 1, 0, 1};  // smoothed
  double k, dcR;
  struct Ch { double prev = 0, x1 = 0, y1 = 0; } ch[2];
  void panic() override { for (auto& c : ch) c.prev = c.x1 = c.y1 = 0; }

  explicit Waveshaper(double sampleRate) : Kernel(sampleRate) {
    for (int i = 0; i < TABLE; i++) table[i] = (float)(-1 + (2.0 * i) / (TABLE - 1));
    k = 1 - exp(-1 / (SMOOTH_S * sr));
    dcR = exp((-2 * PI * DC_HZ) / sr);
  }

  void param(int id, double v) override {
    if (id == DRIVE) t[T_DRIVE] = pow(10, v / 20);
    else if (id == OVERSAMPLE) {
      const int i = toInt32(v);
      os = i == 1 ? 2 : i == 2 ? 4 : 1;
    } else if (id == MIX) { t[T_WET] = v / 100; t[T_DRY] = 1 - v / 100; }
    else if (id == LEVEL) t[T_LEVEL] = v;
  }

  float* data(int slot, int size) override { return slot == 0 && size == TABLE ? table : nullptr; }

  inline double shape(double x) const {
    const int last = TABLE - 1;
    const double f = (x + 1) * 0.5 * last;
    if (f <= 0) return table[0];
    if (f >= last) return table[last];
    const int i = (int)f;
    return table[i] + ((double)table[i + 1] - table[i]) * (f - i);
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    if (!inL) return 0;
    double s0[T_N];
    for (int j = 0; j < T_N; j++) s0[j] = s[j];
    const double kb = 1 - pow(1 - k, n);
    for (int j = 0; j < T_N; j++) s[j] = fabs(t[j] - s[j]) < 1e-6 ? t[j] : s[j] + (t[j] - s[j]) * kb;
    const float* src[2] = {inL, inR ? inR : inL};
    float* dst[2] = {outL, outR};
    const int chans = outR != outL ? 2 : 1;
    for (int c = 0; c < chans; c++) {
      Ch& st = ch[c];
      double prev = st.prev, x1 = st.x1, y1 = st.y1;
      for (int i = 0; i < n; i++) {
        const double u = (double)i / n;
        const double drive = s0[T_DRIVE] + (s[T_DRIVE] - s0[T_DRIVE]) * u;
        const double x = src[c][i];
        double w;
        if (os == 1) w = shape(x * drive);
        else {
          w = 0;
          for (int j = 1; j <= os; j++) w += shape((prev + (x - prev) * ((double)j / os)) * drive);
          w /= os;
        }
        prev = x;
        const double y = w - x1 + dcR * y1;
        x1 = w;
        y1 = y;
        const double wet = s0[T_WET] + (s[T_WET] - s0[T_WET]) * u;
        const double dry = s0[T_DRY] + (s[T_DRY] - s0[T_DRY]) * u;
        const double level = s0[T_LEVEL] + (s[T_LEVEL] - s0[T_LEVEL]) * u;
        dst[c][i] = (float)((y * wet + x * dry) * level);
      }
      st.prev = prev;
      st.x1 = x1;
      st.y1 = fabs(y1) < 1e-20 ? 0 : y1;
    }
    return 1;
  }
};

}  // namespace ms
