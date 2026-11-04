// Shared linear ADSR and voice handling: twin of PolyKernel in poly.dsp.js.
#pragma once
#include "kernel.h"

namespace ms {

inline double sampleCubic(double a, double b, double c, double d, double f) {
  return ((0.5 * (-a + 3 * b - 3 * c + d) * f + a - 2.5 * b + 2 * c - 0.5 * d) * f
    + 0.5 * (c - a)) * f + b;
}

inline double sampleAt(const float* data, int size, int i) {
  return i >= 0 && i < size ? data[i] : 0;
}

inline double sampleRead(const float* data, int size, double x, int mode, bool wrap) {
  if (mode == 0) {
    const int i = (int)jsRound(x);
    return wrap ? data[i >= size ? i - size : i] : sampleAt(data, size, i);
  }
  const int i = (int)floor(x);
  const double f = x - i;
  const int i1 = i + 1 >= size ? i + 1 - size : i + 1;
  const double b = wrap ? data[i] : sampleAt(data, size, i);
  const double c = wrap ? data[i1] : sampleAt(data, size, i + 1);
  if (mode == 1) return b + (c - b) * f;
  const double a = wrap ? data[i ? i - 1 : size - 1] : sampleAt(data, size, i - 1);
  const double d = wrap ? data[i1 + 1 >= size ? i1 + 1 - size : i1 + 1] : sampleAt(data, size, i + 2);
  return sampleCubic(a, b, c, d, f);
}

struct SampleBank {
  int size;
  bool stereo;
  float* samples;
  SampleBank(int n, bool two) : size(n), stereo(two) {
    samples = (float*)calloc((size_t)n * (two ? 2 : 1), sizeof(float));
  }
  ~SampleBank() { free(samples); }
  const float* right() const { return stereo ? samples + size : samples; }
};

struct SamplePoly : Kernel {
  struct Voice {
    int stage = 0, dir = 0;
    double id = 0, level = 0, relStep = 0, age = 0;
    double pitch = 0, vel = 0, pitchT = 0, velT = 0, pos = 0, step = 0;
  };
  struct Env { double atk, dec, sus, k; };
  Voice voices[32];
  int poly = 8;
  double clock = 0, attack = 0.005, decay = 0.2, sustain = 1, release = 0.3, gain = 0.5;
  explicit SamplePoly(double sr) : Kernel(sr) {}
  void polyphony(double value) {
    poly = (int)clampd(toInt32(value), 1, 32);
    for (int i = poly; i < 32; i++) voices[i].stage = 0;
  }
  virtual void start(Voice&, double) = 0;
  void note(int type, double id, double pitch, double vel, double phase) override {
    if (type == ALL_OFF) { for (auto& v : voices) v.stage = 0; return; }
    Voice* v = nullptr;
    for (int i = 0; i < poly; i++) if (voices[i].stage && voices[i].id == id) { v = &voices[i]; break; }
    if (type == NOTE_MOD) { if (v) { v->pitchT = pitch; v->velT = vel; } return; }
    if (type == NOTE_OFF) {
      if (v && v->stage != 4) { v->stage = 4; v->relStep = v->level / (maxd(release, 0.001) * sr); }
      return;
    }
    if (type != NOTE_ON) return;
    if (!v) for (int i = 0; i < poly; i++) if (!voices[i].stage) { v = &voices[i]; break; }
    if (!v) {
      v = &voices[0];
      for (int i = 1; i < poly; i++) if (voices[i].age < v->age) v = &voices[i];
    }
    v->id = id; v->pitch = v->pitchT = pitch; v->vel = v->velT = vel;
    v->level = 0; v->stage = 1; v->age = ++clock;
    start(*v, phase);
  }
  void panic() override { for (auto& v : voices) { v.stage = 0; v.level = 0; } }
  Env envelope(int n) const {
    return {1 / (maxd(attack, 0.001) * sr), (1 - sustain) / (maxd(decay, 0.001) * sr),
      sustain, 1 - exp(-n / (0.006 * sr))};
  }
  static double glide(Voice& v, double k, int n) {
    if (v.pitch != v.pitchT) v.pitch = fabs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
    const double vel = v.vel;
    if (v.vel != v.velT) v.vel = fabs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
    return (v.vel - vel) / n;
  }
  static double tick(Voice& v, const Env& e) {
    switch (v.stage) {
      case 1: v.level += e.atk; if (v.level >= 1) { v.level = 1; v.stage = 2; } break;
      case 2: v.level -= e.dec; if (v.level <= e.sus) { v.level = e.sus; v.stage = 3; } break;
      case 3: v.level = e.sus; break;
      case 4: v.level -= v.relStep; if (v.level <= 0) { v.level = 0; v.stage = 0; } break;
    }
    return v.level;
  }
};

} // namespace ms
