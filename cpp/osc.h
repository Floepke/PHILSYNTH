// OSC: polyphonic oscillator. Twin of src/modules/osc.dsp.js (+ waveform maths of oscshape.js).
#pragma once
#include "kernel.h"

namespace ms {

enum Wave { SINE = 0, TRIANGLE = 1, SAW = 2, SQUARE = 3, HALF_SINE = 4, WHITE = 5, PINK = 6, BROWN = 7, BLUE = 8, VIOLET = 9, SAMPLER_NOISE = 10 };

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

// Noise colours: twin of noiseSample() in src/modules/oscshape.js (same operation order).
struct NoiseState {
  double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0, pw = 0, pp = 0;
};

struct SamplerNoiseState {
  Rng rng{1};
  bool ready = false;
  double position = 0, a = 0, b = 0;
};

inline double samplerNoiseRate(double pitch, double sr) {
  return (48000 / sr) * pow(2, (pitch - 60) / 12);
}

inline double samplerNoiseSample(double rate, SamplerNoiseState& z, uint32_t seed) {
  if (!z.ready) {
    z.rng.s = seed;
    z.a = z.rng.next() * 2 - 1;
    z.b = z.rng.next() * 2 - 1;
    z.ready = true;
  }
  while (z.position >= 1) {
    z.position -= 1;
    z.a = z.b;
    z.b = z.rng.next() * 2 - 1;
  }
  const double value = z.a + (z.b - z.a) * z.position;
  z.position += rate;
  return value;
}

inline double noiseSample(int wave, double w, NoiseState& z) {
  if (wave == WHITE) return w;
  if (wave == VIOLET) { const double y = (w - z.pw) * 0.7; z.pw = w; return y; }
  if (wave == BROWN) { z.br = (z.br + 0.02 * w) / 1.02; return z.br * 6; }
  z.b0 = 0.99886 * z.b0 + w * 0.0555179;
  z.b1 = 0.99332 * z.b1 + w * 0.0750759;
  z.b2 = 0.969 * z.b2 + w * 0.153852;
  z.b3 = 0.8665 * z.b3 + w * 0.3104856;
  z.b4 = 0.55 * z.b4 + w * 0.5329522;
  z.b5 = -0.7616 * z.b5 - w * 0.016898;
  const double pink = z.b0 + z.b1 + z.b2 + z.b3 + z.b4 + z.b5 + z.b6 + w * 0.5362;
  z.b6 = w * 0.115926;
  if (wave == PINK) return pink * 0.2;
  const double y = (pink - z.pp) * 0.5;
  z.pp = pink;
  return y;
}

struct Osc : Kernel {
  enum { POLYPHONY, WAVE, ATTACK, DECAY, SUSTAIN, RELEASE, GAIN, DUTY, ATK_CURVE, DEC_CURVE, REL_CURVE, PARAMS };
  static constexpr int MAX_VOICES = 32;
  static constexpr double ATTACK_KMAX = 1.0986122886681098;  // ln 3
  static constexpr double FALL_KMAX = 6.907755278982137;     // ln 1000
  static constexpr double SMOOTH_S = 0.006;

  // One envelope stage for this block, see stage() in osc.dsp.js and src/modules/adsrcurve.js
  struct Stage { double inc, k, m, norm; };
  Stage stage(double seconds, double amount, double kmax) const {
    const double inc = 1 / (maxd(seconds, 0.001) * sr);
    const double k = (amount == amount ? clampd(amount, -100, 100) : 0) / 100 * kmax;
    if (fabs(k) < 1e-9) return {inc, 0, 1, 1};
    return {inc, k, exp(-k * inc), 1 / (1 - exp(-k))};
  }

  struct Voice {
    int stage = 0;  // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
    double id = 0, phase = 0, inc = 0, level = 0, age = 0;
    double u = 0, e = 1, l0 = 0;  // stage progress, e^(-k u), level where the release started
    double pitch = 0, vel = 0, pitchT = 0, velT = 0;
    NoiseState noise;
    SamplerNoiseState samplerNoise;
  };

  int poly = 8;
  double p[PARAMS] = {8, SAW, 0.01, 0.2, 0.7, 0.4, 0.5, 50, 0, 0, 0};
  double duty = 0.5;
  double clock = 0;
  Voice voices[MAX_VOICES];
  Rng rng;  // noise, shared by the voices (same sequence as the JS kernel with the same seed)

  Osc(double sampleRate, uint32_t seed) : Kernel(sampleRate), rng(seed) {}

  void param(int id, double value) override {
    if (id == POLYPHONY) {
      int v = toInt32(value);
      poly = v < 1 ? 1 : v > MAX_VOICES ? MAX_VOICES : v;
      for (int i = poly; i < MAX_VOICES; i++) voices[i].stage = 0;
    } else if (id >= 0 && id < PARAMS) p[id] = value;
  }

  void note(int type, double id, double pitch, double vel, double phase) override {
    if (type == NOTE_ON) noteOn(id, pitch, vel, phase);
    else if (type == NOTE_MOD) {
      Voice* v = voiceOf(id);
      if (v) { v->pitchT = pitch; v->velT = vel; }
    } else if (type == NOTE_OFF) {
      Voice* v = voiceOf(id);
      if (v && v->stage != 4) {
        v->stage = v->level > 0 ? 4 : 0;
        v->l0 = v->level;
        v->u = 0;
        v->e = 1;
      }
    } else if (type == ALL_OFF) for (auto& v : voices) v.stage = 0;
  }

  void panic() override { for (auto& v : voices) { v.stage = 0; v.level = 0; } }

  Voice* voiceOf(double id) {
    for (int i = 0; i < poly; i++) if (voices[i].stage && voices[i].id == id) return &voices[i];
    return nullptr;
  }

  double incOf(double pitch) const { return mind(0.45, (440 * pow(2, (pitch - 69) / 12)) / sr); }

  // phase: where in the waveform cycle the note starts (0..1, wrapped), see startPhase() in osc.dsp.js
  void noteOn(double id, double pitch, double velocity, double phase) {
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
    v->phase = phase == phase && !isinf(phase) ? phase - floor(phase) : 0;
    v->level = 0;
    v->u = 0;
    v->e = 1;
    v->noise = NoiseState();
    v->samplerNoise = SamplerNoiseState();
    v->stage = 1;
    v->age = ++clock;
  }

  int process(const float*, const float*, float* outL, float* outR, int n) override {
    float* buf = outL;
    memset(buf, 0, n * sizeof(float));
    const double sustain = p[SUSTAIN];
    const Stage A = stage(p[ATTACK], p[ATK_CURVE], ATTACK_KMAX);
    const Stage D = stage(p[DECAY], p[DEC_CURVE], FALL_KMAX);
    const Stage R = stage(p[RELEASE], p[REL_CURVE], FALL_KMAX);
    const int wave = toInt32(p[WAVE]);
    const bool noise = wave >= WHITE;
    const bool sampler = wave == SAMPLER_NOISE;
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
      double rate = sampler ? samplerNoiseRate(v.pitch, sr) : 0;
      double rateStep = 0;
      double vel = v.vel;
      double velStep = 0;
      if (v.pitch != v.pitchT) {
        v.pitch = fabs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
        incStep = (incOf(v.pitch) - v.inc) / n;
        if (sampler) rateStep = (samplerNoiseRate(v.pitch, sr) - rate) / n;
      }
      if (v.vel != v.velT) {
        v.vel = fabs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
        velStep = (v.vel - vel) / n;
      }
      const Stage* st = v.stage == 1 ? &A : v.stage == 2 ? &D : v.stage == 4 ? &R : nullptr;
      if (st) v.e = st->k ? exp(-st->k * v.u) : 1;
      for (int i = 0; i < n; i++) {
        switch (v.stage) {
          case 1:
            v.u += A.inc;
            if (v.u >= 1) { v.level = 1; v.stage = 2; v.u = 0; v.e = 1; }
            else { v.e *= A.m; v.level = A.k ? (1 - v.e) * A.norm : v.u; }
            break;
          case 2:
            v.u += D.inc;
            if (v.u >= 1) { v.level = sustain; v.stage = 3; }
            else { v.e *= D.m; v.level = 1 + (sustain - 1) * (D.k ? (1 - v.e) * D.norm : v.u); }
            break;
          case 3: v.level = sustain; break;
          case 4:
            v.u += R.inc;
            if (v.u >= 1) { v.level = 0; v.stage = 0; }
            else { v.e *= R.m; v.level = v.l0 * (1 - (R.k ? (1 - v.e) * R.norm : v.u)); }
            break;
        }
        if (!v.stage) break;
        v.inc += incStep;
        vel += velStep;
        double y;
        if (sampler) {
          if (!v.samplerNoise.ready) rng.next();
          rate += rateStep;
          y = samplerNoiseSample(rate, v.samplerNoise, rng.s);
        } else y = noise ? noiseSample(wave, rng.next() * 2 - 1, v.noise)
                        : shape(wave, v.phase, duty0 + dutyStep * i, v.inc);
        buf[i] = (float)(buf[i] + y * v.level * vel);
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
