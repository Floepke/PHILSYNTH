#pragma once
#include "kernel.h"

namespace ms {

struct Modulator : Kernel {
  enum { TYPE, CARRIER, INTERPOLATION, PARAMS };
  int type = 0, carrierIndex = 0, interpolation = 1, pos = 0, size;
  double maxDelay;
  float* buffers[2];

  explicit Modulator(double sr) : Kernel(sr) {
    maxDelay = sr * 0.04;
    size = (int)ceil(maxDelay) + 4;
    for (int ch = 0; ch < 2; ch++) buffers[ch] = (float*)calloc(size, sizeof(float));
  }
  ~Modulator() override { for (int ch = 0; ch < 2; ch++) free(buffers[ch]); }

  int carrier() const override { return carrierIndex; }
  void param(int id, double value) override {
    if (id == TYPE) type = (int)clampd(toInt32(value), 0, 10);
    else if (id == INTERPOLATION) interpolation = (int)clampd(toInt32(value), 0, 2);
    else if (id == CARRIER) {
      int index = (int)maxd(0, toInt32(value));
      if (index != carrierIndex) {
        carrierIndex = index;
        for (int ch = 0; ch < 2; ch++) memset(buffers[ch], 0, size * sizeof(float));
      }
    }
  }

  double sample(int ch, int age) const { return buffers[ch][(pos - age + size) % size]; }
  double read(int ch, double delay) const {
    if (interpolation == 0) return sample(ch, (int)jsRound(delay));
    int age = (int)floor(delay);
    double f = delay - age, a = sample(ch, age), b = sample(ch, age + 1);
    if (interpolation == 1) return a + (b - a) * f;
    double before = age > 0 ? sample(ch, age - 1) : 2 * a - b;
    double after = sample(ch, age + 2);
    return ((0.5 * (-before + 3 * a - 3 * b + after) * f
      + before - 2.5 * a + 2 * b - 0.5 * after) * f + 0.5 * (b - before)) * f + a;
  }

  static int32_t pcm(double x) { return toInt32(clampd(trunc(x * 32768), -32768, 32767)); }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    return processModulated(inL, inR, nullptr, nullptr, outL, outR, n);
  }
  int processModulated(const float* inL, const float* inR, const float* modL, const float* modR,
                       float* outL, float* outR, int n) override {
    const float* inputs[2] = { inL, inR ? inR : inL };
    const float* mods[2] = { modL, modR ? modR : modL };
    bool live = false;
    for (int i = 0; i < n; i++) {
      for (int ch = 0; ch < 2; ch++) {
        double c = inputs[ch] ? inputs[ch][i] : 0, m = mods[ch] ? mods[ch][i] : 0;
        buffers[ch][pos] = (float)c;
        double y = 0;
        switch (type) {
          case 0: y = c * m; break;
          case 1: y = read(ch, (clampd(m, -1, 1) + 1) * 0.5 * maxDelay); break;
          case 2: y = read(ch, mind(1, fabs(m)) * maxDelay); break;
          case 3: y = c + m; break;
          case 4: y = c - m; break;
          case 5: y = mind(c, m); break;
          case 6: y = maxd(c, m); break;
          case 7: y = (pcm(c) & pcm(m)) / 32768.0; break;
          case 8: y = (pcm(c) ^ pcm(m)) / 32768.0; break;
          case 9: y = fabs(c) <= fabs(m) ? c : m; break;
          case 10: y = fabs(c) >= fabs(m) ? c : m; break;
        }
        if (ch == 0) outL[i] = (float)y;
        else if (outR != outL) outR[i] = (float)y;
        if (y != 0) live = true;
      }
      if (++pos == size) pos = 0;
    }
    return live;
  }
};

}  // namespace ms
