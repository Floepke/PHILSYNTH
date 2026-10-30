// OSC: polyphonic oscillator. Twin of src/modules/osc.dsp.js (+ waveform maths of oscshape.js).
#pragma once
#include "kernel.h"

namespace ms {

enum Wave { SINE = 0, TRIANGLE = 1, SAW = 2, SQUARE = 3, HALF_SINE = 4 };

inline double polyBlep(double t, double dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

constexpr double SAW_ROUND_DC = 0.5 - 4 / (PI * PI);

inline double sawBend(double t, double d) {
  const double s1 = 1 / d;
  const double s2 = 1 / (1 - d);
  const double r = mind(d, 1 - d);
  const double dc = 0.5 * (1 - 2 * d) + (s2 - s1) * r * r * SAW_ROUND_DC;
  double y;
  if (t <= d - r) y = -1 + t * s1;
  else if (t >= d + r) y = (t - d) * s2;
  else {
    const double w = 2 * r;
    const double u = t - (d - r);
    y = -1 + (d - r) * s1 + s1 * u + (s2 - s1) * (u / 2 - (w / (2 * PI)) * sin((PI * u) / w));
  }
  return y - dc;
}

inline double shape(int wave, double t, double d, double inc) {
  if (wave == HALF_SINE) return d > 0 && t < d ? sin((PI * t) / d) : 0;
  const double e = mind(0.49, 2 * inc);
  if (wave == SQUARE) {
    d = mind(1 - e, maxd(e, d));
    const double s = t < d ? 1 : -1;
    return s + polyBlep(t, inc) - polyBlep(fmod(t - d + 1, 1.0), inc) - (2 * d - 1);
  }
  if (wave == TRIANGLE) {
    d = mind(1 - e, maxd(e, d));
    return t < d ? -1 + (2 * t) / d : 1 - (2 * (t - d)) / (1 - d);
  }
  d = mind(0.99, maxd(0.01, d));
  if (wave == SINE) {
    const double ph = t < d ? (0.5 * t) / d : 0.5 + (0.5 * (t - d)) / (1 - d);
    return sin(2 * PI * ph) - (2 / PI) * (2 * d - 1);
  }
  return sawBend(t, d) - polyBlep(t, inc);
}

struct Osc : Kernel {
  enum { POLYPHONY, WAVE, ATTACK, DECAY, SUSTAIN, RELEASE, GAIN, DUTY, PARAMS };
  static constexpr int MAX_VOICES = 32;
  static constexpr double SMOOTH_S = 0.006;

  struct Voice {
    int stage = 0;  // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
    double id = 0, phase = 0, inc = 0, level = 0, relStep = 0, age = 0;
    double pitch = 0, vel = 0, pitchT = 0, velT = 0;
  };

  int poly = 8;
  double p[PARAMS] = {8, SAW, 0.01, 0.2, 0.7, 0.4, 0.5, 50};
  double duty = 0.5;
  double clock = 0;
  Voice voices[MAX_VOICES];

  explicit Osc(double sampleRate) : Kernel(sampleRate) {}

  void param(int id, double value) override {
    if (id == POLYPHONY) {
      int v = toInt32(value);
      poly = v < 1 ? 1 : v > MAX_VOICES ? MAX_VOICES : v;
      for (int i = poly; i < MAX_VOICES; i++) voices[i].stage = 0;
    } else if (id >= 0 && id < PARAMS) p[id] = value;
  }

  void note(int type, double id, double pitch, double vel) override {
    if (type == NOTE_ON) noteOn(id, pitch, vel);
    else if (type == NOTE_MOD) {
      Voice* v = voiceOf(id);
      if (v) { v->pitchT = pitch; v->velT = vel; }
    } else if (type == NOTE_OFF) {
      Voice* v = voiceOf(id);
      if (v && v->stage != 4) {
        v->stage = 4;
        v->relStep = v->level / (maxd(p[RELEASE], 0.001) * sr);
      }
    } else if (type == ALL_OFF) for (auto& v : voices) v.stage = 0;
  }

  Voice* voiceOf(double id) {
    for (int i = 0; i < poly; i++) if (voices[i].stage && voices[i].id == id) return &voices[i];
    return nullptr;
  }

  double incOf(double pitch) const { return mind(0.45, (440 * pow(2, (pitch - 69) / 12)) / sr); }

  void noteOn(double id, double pitch, double velocity) {
    Voice* v = voiceOf(id);
    if (!v) for (int i = 0; i < poly; i++) if (!voices[i].stage) { v = &voices[i]; break; }
    if (!v) {
      v = &voices[0];
      for (int i = 1; i < poly; i++) if (voices[i].age < v->age) v = &voices[i];
    }
    v->id = id;
    v->pitch = v->pitchT = pitch;
    v->vel = v->velT = velocity;
    v->inc = incOf(pitch);
    v->phase = 0;
    v->level = 0;
    v->stage = 1;
    v->age = ++clock;
  }

  int process(const float*, const float*, float* outL, float* outR, int n) override {
    float* buf = outL;
    memset(buf, 0, n * sizeof(float));
    const double sustain = p[SUSTAIN];
    const double atkStep = 1 / (maxd(p[ATTACK], 0.001) * sr);
    const double decStep = (1 - sustain) / (maxd(p[DECAY], 0.001) * sr);
    const int wave = toInt32(p[WAVE]);
    const double k = 1 - exp(-n / (SMOOTH_S * sr));
    const double dutyT = mind(1, maxd(0, p[DUTY] / 100));
    const double duty0 = duty;
    duty = fabs(dutyT - duty0) < 1e-5 ? dutyT : duty0 + (dutyT - duty0) * k;
    const double dutyStep = (duty - duty0) / n;

    int active = 0;
    for (int vi = 0; vi < poly; vi++) {
      Voice& v = voices[vi];
      if (!v.stage) continue;
      active++;
      double incStep = 0;
      double vel = v.vel;
      double velStep = 0;
      if (v.pitch != v.pitchT) {
        v.pitch = fabs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
        incStep = (incOf(v.pitch) - v.inc) / n;
      }
      if (v.vel != v.velT) {
        v.vel = fabs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
        velStep = (v.vel - vel) / n;
      }
      for (int i = 0; i < n; i++) {
        switch (v.stage) {
          case 1: v.level += atkStep; if (v.level >= 1) { v.level = 1; v.stage = 2; } break;
          case 2: v.level -= decStep; if (v.level <= sustain) { v.level = sustain; v.stage = 3; } break;
          case 3: v.level = sustain; break;
          case 4: v.level -= v.relStep; if (v.level <= 0) { v.level = 0; v.stage = 0; } break;
        }
        if (!v.stage) break;
        v.inc += incStep;
        vel += velStep;
        buf[i] = (float)(buf[i] + shape(wave, v.phase, duty0 + dutyStep * i, v.inc) * v.level * vel);
        v.phase += v.inc;
        if (v.phase >= 1) v.phase -= 1;
      }
    }

    const double g = p[GAIN] * 0.5;
    for (int i = 0; i < n; i++) buf[i] = (float)(buf[i] * g);
    if (outR != outL) memcpy(outR, buf, n * sizeof(float));
    return active > 0;
  }
};

}  // namespace ms
