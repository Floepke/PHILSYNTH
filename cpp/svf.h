#pragma once
#include "kernel.h"

namespace ms {

// Cytomic / A. Simper ZDF tick, shared by FILTER and ECHO (src/dsp/svf.js).
struct Svf {
  double ic1 = 0, ic2 = 0, band = 0, low = 0;

  void tick(double input, double a1, double a2, double a3) {
    const double v3 = input - ic2;
    const double v1 = a1 * ic1 + a2 * v3;
    const double v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    band = v1;
    low = v2;
  }
};

}  // namespace ms
