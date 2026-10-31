// Base of the C++ DSP kernels: the same contract as the JS kernels (src/dsp/kernel.js), driven
// through the C API in engine.cpp by the adapters in src/dsp/wasm.js.
// When a graph has only C++ audio nodes, engine.cpp's ms_run renders it in one call.
//
// Every kernel mirrors its JS twin (src/modules/*.dsp.js) operation for operation: state kept in
// double where JS keeps a number, float where JS keeps a Float32Array, so both render the same
// samples (test/wasm.test.mjs compares them). Change both together.
//
// Rules: no allocation after construction (process() and messages run between graph renders that
// hold views into the wasm memory; growing it there would detach them) and no libc++ (the module
// is built with -nostdlib++ so it has no imports at all).
#pragma once
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace ms {

constexpr double PI = 3.14159265358979323846;
constexpr double LN2 = 0.6931471805599453;  // Math.LN2
constexpr double SQRT2 = 1.4142135623730951;  // Math.SQRT2

enum Note { NOTE_ON = 0, NOTE_MOD = 1, NOTE_OFF = 2, ALL_OFF = 3 };

struct Kernel {
  double sr;
  explicit Kernel(double sampleRate) : sr(sampleRate) {}
  virtual ~Kernel() {}
  virtual void param(int, double) {}
  virtual void tempo(double) {}
  // type, note id, pitch, velocity, phase (NOTE_ON: start phase of the waveform cycle, 0..1)
  virtual void note(int, double, double, double, double) {}
  // Shared memory the JS side fills (e.g. the WAVESHAPER curve table); nullptr if unknown.
  virtual float* data(int, int) { return nullptr; }
  // MIDI/audio panic: drop all sounding state at once, keep the controller values.
  virtual void panic() {}
  // inL == nullptr: nothing connected. outR may equal outL (mono). Returns 0 for a silent output.
  virtual int process(const float* inL, const float* inR, float* outL, float* outR, int n) = 0;
  // Carrier-aware kernels get the selected input and the sum of all other inputs separately.
  virtual int carrier() const { return 0; }
  virtual int processModulated(const float* inL, const float* inR, const float*, const float*,
                               float* outL, float* outR, int n) {
    return process(inL, inR, outL, outR, n);
  }
};

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
inline double maxd(double a, double b) { return a > b ? a : b; }
inline double mind(double a, double b) { return a < b ? a : b; }

// JS ToUint32 / ToInt32 (`v >>> 0`, `v | 0`)
inline uint32_t toUint32(double v) {
  if (!(v == v) || isinf(v)) return 0;
  double t = fmod(trunc(v), 4294967296.0);
  if (t < 0) t += 4294967296.0;
  return (uint32_t)t;
}
inline int32_t toInt32(double v) { return (int32_t)toUint32(v); }

// Two doubles per SIMD register (wasm simd128). Element-wise ops round exactly like the scalar ones
// (wasm has no fused multiply-add here), so vectorised loops stay bit-identical to the JS twins as
// long as each lane keeps the scalar order of operations; sums across lanes stay scalar.
typedef double d2 __attribute__((vector_size(16), aligned(8)));
inline d2 load2(const double* p) { d2 v; memcpy(&v, p, sizeof v); return v; }
inline void store2(double* p, d2 v) { memcpy(p, &v, sizeof v); }
inline d2 splat(double x) { return d2{x, x}; }
inline d2 floor2(d2 v) { return __builtin_elementwise_floor(v); }

// JS Math.round
inline double jsRound(double v) { return floor(v + 0.5); }

// Math.random() stand-in (xorshift32): 0..1
struct Rng {
  uint32_t s;
  explicit Rng(uint32_t seed) : s(seed ? seed : 0x9e3779b9u) {}
  double next() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s / 4294967296.0;
  }
};

}  // namespace ms
