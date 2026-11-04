// Native twin of operator.dsp.js. OSC supplies note ownership, phase, pitch and release handling.
#pragma once
#include "osc.h"

namespace ms {

struct Operator : Osc {
  enum { MODULATION, FEEDBACK, OP_ATTACK, OP_DECAY, OP_SUSTAIN, OP_RELEASE,
         OP_ATK_CURVE, OP_DEC_CURVE, OP_REL_CURVE, VELOCITY, LEVEL, PARAMS };
  static constexpr int OS = 4, TAPS = 65;
  double amount = 100, feedback = 0, velocity = 100;
  double smooth[4] = {1, 0, 1, 0.5};
  double filter[TAPS], history[TAPS] = {};
  int pos = 0, tail = 0;
  double prevInput = 0, feedbackSample = 0;

  explicit Operator(double sr) : Osc(sr, 1) {
    poly = 1;
    p[ATTACK] = p[DECAY] = p[RELEASE] = 0.001;
    p[SUSTAIN] = 1;
    p[ATK_CURVE] = p[DEC_CURVE] = p[REL_CURVE] = 100;
    const double fc = 0.45 / OS;
    double sum = 0;
    for (int i = 0; i < TAPS; i++) {
      const double x = i - (TAPS - 1) / 2;
      filter[i] = (x ? sin(2 * PI * fc * x) / (PI * x) : 2 * fc)
        * (0.54 - 0.46 * cos(2 * PI * i / (TAPS - 1)));
      sum += filter[i];
    }
    for (double& h : filter) h /= sum;
  }

  void param(int id, double value) override {
    switch (id) {
      case MODULATION: amount = value; break;
      case FEEDBACK: feedback = value; break;
      case OP_ATTACK: p[ATTACK] = value; break;
      case OP_DECAY: p[DECAY] = value; break;
      case OP_SUSTAIN: p[SUSTAIN] = value; break;
      case OP_RELEASE: p[RELEASE] = value; break;
      case OP_ATK_CURVE: p[ATK_CURVE] = value; break;
      case OP_DEC_CURVE: p[DEC_CURVE] = value; break;
      case OP_REL_CURVE: p[REL_CURVE] = value; break;
      case VELOCITY: velocity = value; break;
      case LEVEL: p[GAIN] = value; break;
    }
  }

  void note(int type, double id, double pitch, double vel, double phase) override {
    if (type == ALL_OFF) panic();
    else {
      Osc::note(type, id, pitch, vel, phase);
      if (type == NOTE_ON) feedbackSample = 0;
    }
  }

  void panic() override {
    Osc::panic();
    memset(history, 0, sizeof(history));
    pos = tail = 0;
    prevInput = feedbackSample = 0;
  }

  Stage opStage(double seconds, double amount, double kmax) const {
    Stage st = stage(seconds, amount, kmax);
    st.inc /= OS;
    st.m = exp(-st.k * st.inc);
    return st;
  }

  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    Voice& v = voices[0];
    if (!inR) inR = inL;
    const double k = 1 - exp(-n / (SMOOTH_S * sr));
    double s0[4], targets[4] = {amount / 100, feedback / 100, velocity / 100, p[GAIN]};
    const bool idle = !v.stage && !tail;
    for (int i = 0; i < 4; i++) {
      s0[i] = smooth[i];
      smooth[i] = idle || fabs(targets[i] - s0[i]) < 1e-6 ? targets[i] : s0[i] + (targets[i] - s0[i]) * k;
      if (idle) s0[i] = smooth[i];
    }
    if (idle) {
      memset(outL, 0, n * sizeof(float));
      if (outR != outL) memset(outR, 0, n * sizeof(float));
      prevInput = inL ? ((double)inL[n - 1] + inR[n - 1]) * 0.5 : 0;
      return 0;
    }
    const Stage A = opStage(p[ATTACK], p[ATK_CURVE], ATTACK_KMAX);
    const Stage D = opStage(p[DECAY], p[DEC_CURVE], FALL_KMAX);
    const Stage R = opStage(p[RELEASE], p[REL_CURVE], FALL_KMAX);
    const Stage* st = v.stage == 1 ? &A : v.stage == 2 ? &D : v.stage == 4 ? &R : nullptr;
    if (st) v.e = st->k ? exp(-st->k * v.u) : 1;
    double inc = v.inc, vel = v.vel;
    if (v.pitch != v.pitchT) v.pitch = fabs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
    if (v.vel != v.velT) v.vel = fabs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
    const double incStep = (incOf(v.pitch) - inc) / (n * OS);
    const double velStep = (v.vel - vel) / (n * OS);
    for (int i = 0; i < n; i++) {
      const double input = inL ? ((double)inL[i] + inR[i]) * 0.5 : 0;
      for (int j = 0; j < OS; j++) {
        const double u = (i * OS + j + 1.0) / (n * OS);
        const double depth = s0[0] + (smooth[0] - s0[0]) * u;
        const double fb = s0[1] + (smooth[1] - s0[1]) * u;
        const double sensitivity = s0[2] + (smooth[2] - s0[2]) * u;
        const double gain = s0[3] + (smooth[3] - s0[3]) * u;
        const double mod = prevInput + (input - prevInput) * ((j + 1.0) / OS);
        double y = 0;
        if (v.stage) {
          switch (v.stage) {
            case 1:
              v.u += A.inc;
              if (v.u >= 1) { v.level = 1; v.stage = 2; v.u = 0; v.e = 1; }
              else { v.e *= A.m; v.level = A.k ? (1 - v.e) * A.norm : v.u; }
              break;
            case 2:
              v.u += D.inc;
              if (v.u >= 1) { v.level = p[SUSTAIN]; v.stage = 3; }
              else { v.e *= D.m; v.level = 1 + (p[SUSTAIN] - 1) * (D.k ? (1 - v.e) * D.norm : v.u); }
              break;
            case 3: v.level = p[SUSTAIN]; break;
            case 4:
              v.u += R.inc;
              if (v.u >= 1) { v.level = 0; v.stage = 0; }
              else { v.e *= R.m; v.level = v.l0 * (1 - (R.k ? (1 - v.e) * R.norm : v.u)); }
              break;
          }
          inc += incStep;
          vel += velStep;
          const double wave = sin(2 * PI * (v.phase + mod * depth + feedbackSample * fb));
          feedbackSample = wave;
          y = wave * v.level * (1 - sensitivity * (1 - vel)) * gain;
          v.phase += inc / OS;
          if (v.phase >= 1) v.phase -= 1;
          tail = TAPS;
        } else if (tail) tail--;
        history[pos] = y;
        pos = (pos + 1) % TAPS;
      }
      prevInput = input;
      double sum = 0;
      for (int t = 0; t < TAPS; t++) sum += filter[t] * history[(pos - 1 - t + TAPS) % TAPS];
      outL[i] = (float)sum;
    }
    v.inc = inc;
    if (outR != outL) memcpy(outR, outL, n * sizeof(float));
    return 1;
  }
};

} // namespace ms
