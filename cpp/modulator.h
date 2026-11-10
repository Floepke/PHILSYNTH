#pragma once
#include "kernel.h"

namespace ms {

struct Modulator : Kernel {
  enum { TYPE, CARRIER, INTERPOLATION, PARAMS };
  int type = 0, carrierIndex = 0, interpolation = 1, pos = 0, size;
  double maxDelay;
  int zeroRun;
  float* buffers[2];

  explicit Modulator(double sr) : Kernel(sr) {
    maxDelay = sr * 0.04;
    size = (int)ceil(maxDelay) + 4;
    zeroRun = size;
    for (int ch = 0; ch < 2; ch++) buffers[ch] = (float*)calloc(size, sizeof(float));
  }
  ~Modulator() override { for (int ch = 0; ch < 2; ch++) free(buffers[ch]); }
  void panic() override {
    for (int ch = 0; ch < 2; ch++) memset(buffers[ch], 0, size * sizeof(float));
    zeroRun = size;
  }

  int carrier() const override { return carrierIndex; }
  void param(int id, double value) override {
    if (id == TYPE) type = (int)clampd(toInt32(value), 0, 10);
    else if (id == INTERPOLATION) interpolation = (int)clampd(toInt32(value), 0, 2);
    else if (id == CARRIER) {
      int index = (int)maxd(0, toInt32(value));
      if (index != carrierIndex) {
        carrierIndex = index;
        panic();
      }
    }
  }

  double sample(int ch, int age) const {
    const int index = pos - age;
    return buffers[ch][index < 0 ? index + size : index];
  }
  double read(int ch, double delay) const {
    if (interpolation == 0) return sample(ch, (int)jsRound(delay));
    int age = (int)floor(delay);
    int index = pos - age;
    if (index < 0) index += size;
    const float* buffer = buffers[ch];
    double f = delay - age, a = buffer[index], b = buffer[index == 0 ? size - 1 : index - 1];
    if (interpolation == 1) return a + (b - a) * f;
    double before = age > 0 ? buffer[index + 1 == size ? 0 : index + 1] : 2 * a - b;
    double after = buffer[index < 2 ? index + size - 2 : index - 2];
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
    const bool phase = type == 1 || type == 2;
    // Preserve all buffered carrier samples until a full history of zeros replaced them.
    if (!inL && !inR && zeroRun >= size && (phase || (!modL && !modR))) {
      pos = (pos + n) % size;
      return 0;
    }
    bool live = false;
    for (int i = 0; i < n; i++) {
      bool zero = true;
      for (int ch = 0; ch < 2; ch++) {
        double c = inputs[ch] ? inputs[ch][i] : 0, m = mods[ch] ? mods[ch][i] : 0;
        if (c != 0) zero = false;
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
      zeroRun = zero ? (zeroRun < size ? zeroRun + 1 : size) : 0;
      if (++pos == size) pos = 0;
    }
    return live;
  }
};

}  // namespace ms
