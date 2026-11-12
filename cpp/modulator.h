#pragma once
#include "kernel.h"
#include "halfband.h"

namespace ms {

struct Modulator : Kernel {
  enum { TYPE, CARRIER, INTERPOLATION, OVERSAMPLE, PARAMS };
  int type = 0, carrierIndex = 0, interpolation = 1, os = 1, pos = 0, size = 0;
  double maxDelay = 0;
  int zeroRun = 0;
  float* buffers[2] = { nullptr, nullptr };
  // per channel: carrier, modulator, output; [0] steep (base rate), [1] light (2x)
  Halfband fc[2][2], fm[2][2], fy[2][2];
  double cu[8] = {}, mu[8] = {}, yu[8] = {};

  explicit Modulator(double sr) : Kernel(sr) {
    for (int ch = 0; ch < 2; ch++) for (int s = 0; s < 2; s++) {
      Halfband* all[3] = { &fc[ch][s], &fm[ch][s], &fy[ch][s] };
      for (Halfband* h : all) h->init(s ? HALFBAND_LIGHT : HALFBAND_STEEP, s ? 4 : 8);
    }
    resize();
  }
  ~Modulator() override { for (int ch = 0; ch < 2; ch++) free(buffers[ch]); }
  void resize() {
    maxDelay = sr * os * 0.04;
    size = (int)ceil(maxDelay) + 4;
    for (int ch = 0; ch < 2; ch++) {
      free(buffers[ch]);
      buffers[ch] = (float*)calloc(size, sizeof(float));
    }
    pos = 0;
    zeroRun = size;
  }
  void clearFilters() {
    for (int ch = 0; ch < 2; ch++) for (int s = 0; s < 2; s++) { fc[ch][s].clear(); fm[ch][s].clear(); fy[ch][s].clear(); }
  }
  void panic() override {
    for (int ch = 0; ch < 2; ch++) memset(buffers[ch], 0, size * sizeof(float));
    zeroRun = size;
    clearFilters();
  }

  int carrier() const override { return carrierIndex; }
  void param(int id, double value) override {
    if (id == TYPE) type = (int)clampd(toInt32(value), 0, 10);
    else if (id == INTERPOLATION) interpolation = (int)clampd(toInt32(value), 0, 2);
    else if (id == OVERSAMPLE) {
      static const int factors[3] = { 1, 2, 4 };
      const int next = factors[(int)clampd(toInt32(value), 0, 2)];
      if (next != os) {
        os = next;
        resize();
        clearFilters();
      }
    }
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

  double combine(int ch, double c, double m) const {
    switch (type) {
      case 0: return c * m;
      case 1: return read(ch, (clampd(m, -1, 1) + 1) * 0.5 * maxDelay);
      case 2: return read(ch, mind(1, fabs(m)) * maxDelay);
      case 3: return c + m;
      case 4: return c - m;
      case 5: return mind(c, m);
      case 6: return maxd(c, m);
      case 7: return (pcm(c) & pcm(m)) / 32768.0;
      case 8: return (pcm(c) ^ pcm(m)) / 32768.0;
      case 9: return fabs(c) <= fabs(m) ? c : m;
      default: return fabs(c) >= fabs(m) ? c : m;
    }
  }

  void upsample(Halfband* stages, double v, double* to) {
    stages[0].up(v);
    if (os == 2) { to[0] = stages[0].a; to[1] = stages[0].b; return; }
    const double b = stages[0].b;
    stages[1].up(stages[0].a); to[0] = stages[1].a; to[1] = stages[1].b;
    stages[1].up(b); to[2] = stages[1].a; to[3] = stages[1].b;
  }
  double downsample(Halfband* stages, const double* from) {
    if (os == 2) return stages[0].down(from[0], from[1]);
    const double first = stages[1].down(from[0], from[1]);
    return stages[0].down(first, stages[1].down(from[2], from[3]));
  }

  int processOversampled(const float* const* inputs, const float* const* mods, float* outL, float* outR, int n) {
    bool live = false;
    for (int i = 0; i < n; i++) {
      for (int ch = 0; ch < 2; ch++) {
        upsample(fc[ch], inputs[ch] ? inputs[ch][i] : 0, cu + ch * 4);
        upsample(fm[ch], mods[ch] ? mods[ch][i] : 0, mu + ch * 4);
      }
      for (int j = 0; j < os; j++) {
        bool zero = true;
        for (int ch = 0; ch < 2; ch++) {
          const double c = cu[ch * 4 + j];
          if (c != 0) zero = false;
          buffers[ch][pos] = (float)c;
          yu[ch * 4 + j] = combine(ch, c, mu[ch * 4 + j]);
        }
        zeroRun = zero ? (zeroRun < size ? zeroRun + 1 : size) : 0;
        if (++pos == size) pos = 0;
      }
      for (int ch = 0; ch < 2; ch++) {
        const double y = downsample(fy[ch], yu + ch * 4);
        if (ch == 0) outL[i] = (float)y;
        else if (outR != outL) outR[i] = (float)y;
        if (y != 0) live = true;
      }
    }
    for (int ch = 0; ch < 2; ch++) for (int s = 0; s < 2; s++) { fc[ch][s].flush(); fm[ch][s].flush(); fy[ch][s].flush(); }
    return live;
  }

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
      pos = (pos + n * os) % size;
      if (os > 1) clearFilters();
      return 0;
    }
    if (os > 1) return processOversampled(inputs, mods, outL, outR, n);
    bool live = false;
    for (int i = 0; i < n; i++) {
      bool zero = true;
      for (int ch = 0; ch < 2; ch++) {
        double c = inputs[ch] ? inputs[ch][i] : 0, m = mods[ch] ? mods[ch][i] : 0;
        if (c != 0) zero = false;
        buffers[ch][pos] = (float)c;
        const double y = combine(ch, c, m);
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
