#pragma once
#include "kernel.h"

namespace ms {

// Twin of src/modules/vibrato.dsp.js.
struct Vibrato : Kernel {
  enum { WAVE, UNIT, FREQ, PHASE, AMP, PARAMS };
  static constexpr double MAX_DELAY = 2;
  static constexpr double BASE = 2;
  int wave = 0, unit = 0, size, pos = 0;
  double freq = 5, amp = 25, bpm = 120, startPhase = 0, phase = 0;
  double rate = 5, target = 0, depth = 0, corr = 0, smooth, idle;
  bool ran = false;
  float* buf[2];

  explicit Vibrato(double sampleRate) : Kernel(sampleRate) {
    size = (int)ceil(MAX_DELAY * sr) + (int)BASE + 8;
    for (auto& b : buf) b = (float*)calloc(size, sizeof(float));
    smooth = 1 - exp(-1 / (0.05 * sr));
    idle = size;
    update();
    depth = target;
  }
  ~Vibrato() override { for (auto b : buf) free(b); }

  static double maxOffset(int w) { return w == 1 ? 0.25 : 1 / PI; }
  static double offset(double p, int w) {
    if (w == 1) {
      const double g = p < 0.25 ? 2 * p * p : p < 0.75 ? 2 * p - 2 * p * p - 0.25 : 2 * (1 - p) * (1 - p);
      return 0.25 - g;
    }
    return (1 + cos(2 * PI * p)) / (2 * PI);
  }
  // lfoRateHz() of lfo.dsp.js without MIDI Pitch
  double rateHz() const {
    if (!unit) return freq;
    static const double periods[] = {64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1.5, 1, 3.0 / 4, 2.0 / 3, 1.0 / 2, 1.0 / 3, 1.0 / 4};
    static const double beats[] = {0, 1, 0.5, 0.25};
    const double want = log(1 / freq);
    double best = periods[0];
    for (double p : periods) if (fabs(log(p) - want) < fabs(log(best) - want)) best = p;
    return bpm / (60 * beats[unit] * best);
  }
  void update() {
    rate = rateHz();
    const double r = pow(2, amp / 1200) - 1;
    const double k = rate > 0 ? r / rate : 0;
    target = mind(k, MAX_DELAY / maxOffset(wave)) * sr;
    if (!ran) depth = target;
  }
  static double num(double v, double fallback) { return v == v && v != 0 ? v : fallback; }

  void param(int id, double v) override {
    if (id == WAVE) {
      const int w = (int)clampd(num(jsRound(v), 0), 0, 1);
      if (w == wave) return;
      if (ran) corr += depth * (offset(phase, wave) - offset(phase, w));
      wave = w;
    } else if (id == UNIT) unit = (int)clampd(num(jsRound(v), 0), 0, 3);
    else if (id == FREQ) freq = clampd(num(v, 0.01), 0.01, 50);
    else if (id == AMP) amp = clampd(num(v, 0), 0, 200);
    else if (id == PHASE) {
      const double p = num(v, 0);
      startPhase = p - floor(p);
      if (!ran) phase = startPhase;
      return;
    } else return;
    update();
  }
  void tempo(double value) override { bpm = num(value, 120); update(); }

  void panic() override {
    for (auto b : buf) memset(b, 0, size * sizeof(float));
    pos = 0;
    phase = startPhase;
    depth = target;
    corr = 0;
    idle = size;
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    const bool has = inL != nullptr;
    ran = true;
    const double inc = rate / sr;
    if (!has) idle += n; else idle = 0;
    if (idle >= size) {
      idle = size;
      depth = target;
      corr = 0;
      phase += n * inc;
      phase -= floor(phase);
      return 0;
    }
    const float* src[2] = {inL, inR ? inR : inL};
    float* out[2] = {outL, outR};
    bool live = false;
    for (int i = 0; i < n; i++) {
      depth += (target - depth) * smooth;
      corr -= corr * smooth;
      const double d = BASE + depth * offset(phase, wave) + corr;
      double at = pos - d;
      if (at < 0) at += size;
      const int j = (int)floor(at);
      const double f = at - j;
      const int jm = j == 0 ? size - 1 : j - 1;
      const int j1 = j + 1 == size ? 0 : j + 1;
      const int j2 = j1 + 1 == size ? 0 : j1 + 1;
      for (int c = 0; c < 2; c++) {
        float* b = buf[c];
        b[pos] = has ? src[c][i] : 0;
        const double xm = b[jm], x0 = b[j], x1 = b[j1], x2 = b[j2];
        const double c1 = 0.5 * (x1 - xm);
        const double c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const double c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
        const double y = ((c3 * f + c2) * f + c1) * f + x0;
        if (c == 0 || outR != outL) out[c][i] = (float)y;
        if (y != 0) live = true;
      }
      phase += inc;
      if (phase >= 1) phase -= 1;
      pos = pos + 1 == size ? 0 : pos + 1;
    }
    return live ? 1 : 0;
  }
};

}  // namespace ms
