// Half-band filters for 2x oversampling. Twin of src/dsp/halfband.js (see there).
#pragma once
#include "kernel.h"

namespace ms {

static const double HALFBAND_STEEP[8] = { 0.04063346092419326, 0.1505051290226746, 0.3007570559918741, 0.4607745049614506,
  0.6095243148961883, 0.7385038411188573, 0.8492238103920661, 0.9497427837050002 };
static const double HALFBAND_LIGHT[4] = { 0.04189399199765617, 0.168903482439952, 0.3905607729211659, 0.7438957482684782 };

struct Halfband {
  const double* c = HALFBAND_STEEP;
  int n = 8;
  double x[8] = {}, y[8] = {};
  double a = 0, b = 0;

  void init(const double* coefs, int count) { c = coefs; n = count; clear(); }
  void run(double pa, double pb) {
    for (int i = 0; i < n; i += 2) {
      const double ta = (pa - y[i]) * c[i] + x[i];
      x[i] = pa; y[i] = ta; pa = ta;
      if (i + 1 < n) {
        const double tb = (pb - y[i + 1]) * c[i + 1] + x[i + 1];
        x[i + 1] = pb; y[i + 1] = tb; pb = tb;
      }
    }
    a = pa;
    b = pb;
  }
  void up(double v) { run(v, v); }
  double down(double first, double second) {
    run(second, first);
    return 0.5 * (a + b);
  }
  void clear() { memset(x, 0, sizeof x); memset(y, 0, sizeof y); }
  void flush() {
    for (int i = 0; i < n; i++) if (fabs(x[i]) > 1e-20 || fabs(y[i]) > 1e-20) return;
    clear();
  }
};

}  // namespace ms
