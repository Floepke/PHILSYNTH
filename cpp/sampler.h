#pragma once
#include "samplepoly.h"

namespace ms {

struct Sampler : SamplePoly {
  enum { POLYPHONY, SEL_START, SEL_LENGTH, PLAY_MODE, TRANSPOSE, FINETUNE, INTERPOLATION,
    ATTACK, DECAY, SUSTAIN, RELEASE, GAIN, PARAMS };
  SampleBank* bank = nullptr; // Reference owned by the adapter cache.
  double rate = 0, selStart = 0, selLength = 100, transpose = 0, finetune = 0;
  int playMode = 0, interpolation = 2;
  explicit Sampler(double sr) : SamplePoly(sr) {}
  void setSample(SampleBank* data, double sampleRate) {
    bank = data; rate = sampleRate;
    for (auto& v : voices) v.stage = 0;
  }
  void param(int id, double v) override {
    switch (id) {
      case POLYPHONY: polyphony(v); break;
      case SEL_START: selStart = v; break;
      case SEL_LENGTH: selLength = v; break;
      case PLAY_MODE: playMode = toInt32(v); break;
      case TRANSPOSE: transpose = v; break;
      case FINETUNE: finetune = v; break;
      case INTERPOLATION: interpolation = (int)clampd(toInt32(v), 0, 2); break;
      case ATTACK: attack = v; break;
      case DECAY: decay = v; break;
      case SUSTAIN: sustain = v; break;
      case RELEASE: release = v; break;
      case GAIN: gain = v; break;
    }
  }
  void region(double& a, double& b) const {
    const double s = clampd(selStart / 100, 0, 1);
    a = mind(bank->size - 1, s * bank->size);
    b = maxd(a + 1, mind(bank->size, (s + maxd(0, selLength) / 100) * bank->size));
  }
  double speed(double pitch) const { return rate / sr * pow(2, (pitch - 60 + transpose + finetune / 100) / 12); }
  void start(Voice& v, double phase) override {
    if (!bank) { v.stage = 0; return; }
    double a, b; region(a, b);
    v.dir = playMode == 1 || playMode == 4 || playMode == 5 ? -1 : 1;
    const double offset = (phase == phase && !isinf(phase) ? phase - floor(phase) : 0) * (b - 1 - a);
    v.pos = v.dir < 0 ? b - 1 - offset : a + offset;
    v.step = speed(v.pitch);
  }
  int process(const float*, const float*, float* L, float* R, int n) override {
    if (!bank) return 0;
    memset(L, 0, n * sizeof(float));
    if (R != L) memset(R, 0, n * sizeof(float));
    const Env e = envelope(n);
    double a, b; region(a, b);
    const double span = b - a, top = b - 1;
    const bool ping = playMode == 2 || playMode == 5, loop = playMode == 3 || playMode == 4;
    int active = 0;
    for (int vi = 0; vi < poly; vi++) {
      auto& v = voices[vi];
      if (!v.stage) continue;
      active++;
      double vel = v.vel;
      const double dv = glide(v, e.k, n), ds = (speed(v.pitch) - v.step) / n;
      if (loop) v.dir = playMode == 4 ? -1 : 1;
      if (ping) {
        if (!v.dir) v.dir = 1;
        if (v.pos < a || v.pos > top) v.pos = clampd(v.pos, a, top);
      } else if (v.dir < 0) { if (v.pos > top) v.pos = top; }
      else if (v.pos < a) v.pos = a;
      for (int i = 0; i < n; i++) {
        const double level = tick(v, e);
        if (!v.stage) break;
        if (ping) {
          if (top - a < 1) v.pos = a;
          else if (v.pos > top || v.pos < a) {
            const double w = top - a;
            const bool over = v.pos > top;
            const double d = fmod(over ? v.pos - top : a - v.pos, 2 * w);
            const bool back = d <= w;
            v.dir = over == back ? -1 : 1;
            v.pos = over ? (back ? top - d : a + (d - w)) : (back ? a + d : top - (d - w));
          }
        } else if (loop) {
          if (v.pos >= b || v.pos < a) v.pos = a + fmod(fmod(v.pos - a, span) + span, span);
        } else if (v.dir < 0 ? v.pos < a : v.pos >= b) { v.stage = 0; break; }
        vel += dv;
        const double g = level * vel;
        const double l = sampleRead(bank->samples, bank->size, v.pos, interpolation, false);
        L[i] = (float)(L[i] + l * g);
        if (R != L) R[i] = (float)(R[i] + sampleRead(bank->right(), bank->size, v.pos, interpolation, false) * g);
        v.step += ds;
        v.pos += v.step * v.dir;
      }
    }
    for (int i = 0; i < n; i++) {
      L[i] = (float)(L[i] * gain);
      if (R != L) R[i] = (float)(R[i] * gain);
    }
    return active > 0;
  }
};

} // namespace ms
