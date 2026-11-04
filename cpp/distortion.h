#pragma once
#include "kernel.h"

namespace ms {

// Twin of src/modules/distortion.dsp.js.
struct Distortion : Kernel {
  enum { TYPE, POWER, BITS, FREQUENCY, PARAMS };
  int type = 1, bits = 16;
  double rate = 1, targetPower = 1, power = 1, smooth;
  double held[2] = {0, 0}, phase = 1;
  bool started = false;

  explicit Distortion(double sampleRate) : Kernel(sampleRate) {
    smooth = 1 - exp(-1 / (0.01 * sr));
  }

  void param(int id, double v) override {
    if (id == TYPE) type = (int)clampd(floor(v + 0.5), 0, 11);
    else if (id == POWER) targetPower = clampd(v, 0, 100);
    else if (id == BITS) bits = (int)clampd(floor(v + 0.5), 1, 16);
    else if (id == FREQUENCY) {
      const double next = v <= 0 ? 1 : mind(clampd(v, 1, 48000) / sr, 1);
      if (next == 1 && rate < 1) phase = 1;
      rate = next;
    }
  }

  void panic() override {
    held[0] = held[1] = 0;
    phase = 1;
    started = false;
  }

  static double wrap(double x, double period) {
    return fmod(fmod(x, period) + period, period);
  }
  static double fold(double x) { return 1 - fabs(wrap(x + 1, 4) - 2); }
  double shape(double x) const {
    const double a = fabs(x), sign = x > 0 ? 1 : x < 0 ? -1 : 0;
    switch (type) {
      case 1: return clampd(x, -1, 1);
      case 2: return fold(x);
      case 3: return a <= 1 ? x : sign * fold(2 * a - 1);
      case 4: return sign * (1 - fabs(fmod(a, 2) - 1));
      case 5: return a <= 1 ? x : sign * fmod(a, 1);
      case 6: return a <= 1 ? x : wrap(x + 1, 2) - 1;
      case 7: return clampd(1.5 * x - 0.5 * x * x * x, -1, 1);
      case 8: return sin(x);
      case 9: {
        const double z = 1 - mind(a, 1);
        return sign * (1 - z * z);
      }
      case 10: return x / hypot(1, x);
      case 11: return x / (1 + a);
      default: return x;
    }
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    const bool silent = !inL;
    if (!started) {
      if (silent) return 0;
      power = targetPower;
      started = true;
    }
    const double q = (double)(1 << (bits - 1));
    const float* src[2] = {inL, inR ? inR : inL};
    bool live = false;
    for (int i = 0; i < n; i++) {
      power += (targetPower - power) * smooth;
      if (phase >= 1) {
        phase -= floor(phase);
        for (int c = 0; c < 2; c++) {
          const double x = silent ? 0 : src[c][i];
          const double y = shape(x * power);
          held[c] = bits == 16 ? y : clampd(floor(y * q + 0.5), -q, q - 1) / q;
        }
      }
      phase += rate;
      outL[i] = (float)held[0];
      if (outR != outL) outR[i] = (float)held[1];
      live = live || held[0] != 0 || held[1] != 0;
    }
    return live ? 1 : 0;
  }
};

}  // namespace ms
