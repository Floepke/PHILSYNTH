// Twin of spectra.dsp.js. JavaScript supplies the pre-rendered loop; OSC supplies curved ADSR voices.
#pragma once
#include "osc.h"
#include "samplepoly.h"

namespace ms {

struct Spectra : Osc {
  enum { POLY, SP_ATTACK, SP_DECAY, SP_SUSTAIN, SP_RELEASE,
    SP_ATK_CURVE, SP_DEC_CURVE, SP_REL_CURVE, SP_GAIN, PARAMS };
  SampleBank* sample = nullptr;
  SampleBank* oldSample = nullptr;
  SampleBank* nextSample = nullptr;
  SampleBank* pendingSample = nullptr;
  double nextRate = 0, pendingRate = 0, pendingSeconds = 0.02;
  int cycle = 0, nextFrame = 0;
  double rate = 0, blend = 1, blendStep = 1;
  double pos[MAX_VOICES] = {}, velStart[MAX_VOICES] = {}, velStep[MAX_VOICES] = {}, stepStep[MAX_VOICES] = {};

  explicit Spectra(double sr) : Osc(sr, 1) {
    p[ATTACK] = p[DECAY] = 0.003;
    p[SUSTAIN] = 1;
    p[RELEASE] = 0.02;
    p[ATK_CURVE] = p[DEC_CURVE] = p[REL_CURVE] = 100;
    p[GAIN] = 0.45;
  }
  ~Spectra() override {
    if (sample) sample->release();
    if (oldSample) oldSample->release();
    if (nextSample) nextSample->release();
    if (pendingSample) pendingSample->release();
  }

  double cycleFade() const {
    const Voice* leader = nullptr;
    for (int vi = 0; vi < poly; vi++) {
      const auto& v = voices[vi];
      if (v.stage && (!leader || v.age < leader->age)) leader = &v;
    }
    return sample && leader ? mind(4, sample->size / (leader->inc * sr) / 4) : 0.02;
  }

  void setSample(SampleBank* bank, double sampleRate, bool phaseFrame = false) {
    bank->retain();
    if (nextSample) { nextSample->release(); nextSample = nullptr; }
    const double seconds = phaseFrame ? cycleFade() : 0.02;
    if (oldSample) {
      if (pendingSample) pendingSample->release();
      pendingSample = bank;
      pendingRate = sampleRate;
      pendingSeconds = seconds;
      return;
    }
    applySample(bank, sampleRate, seconds);
  }

  void stageSample(SampleBank* bank, double sampleRate, int frame) {
    bank->retain();
    if (nextSample) nextSample->release();
    nextSample = bank;
    nextRate = sampleRate;
    nextFrame = frame;
  }

  void applySample(SampleBank* bank, double sampleRate, double seconds) {
    oldSample = sample;
    sample = bank;
    rate = sampleRate;
    blend = oldSample ? 0 : 1;
    blendStep = 1 / maxd(1, jsRound(seconds * sr));
  }

  void param(int id, double value) override {
    switch (id) {
      case POLY: Osc::param(Osc::POLYPHONY, value); break;
      case SP_ATTACK: p[ATTACK] = value; break;
      case SP_DECAY: p[DECAY] = value; break;
      case SP_SUSTAIN: p[SUSTAIN] = value; break;
      case SP_RELEASE: p[RELEASE] = value; break;
      case SP_ATK_CURVE: p[ATK_CURVE] = value; break;
      case SP_DEC_CURVE: p[DEC_CURVE] = value; break;
      case SP_REL_CURVE: p[REL_CURVE] = value; break;
      case SP_GAIN: p[GAIN] = value; break;
    }
  }

  double speed(double pitch) const { return (rate / sr) * pow(2, (pitch - 60) / 12); }

  void note(int type, double id, double pitch, double vel, double phase) override {
    Osc::note(type, id, pitch, vel, phase);
    if (type != NOTE_ON) return;
    Voice* v = voiceOf(id);
    if (!v) return;
    if (!sample) { v->stage = 0; return; }
    pos[v - voices] = v->phase * sample->size;
    v->inc = speed(v->pitch);
  }

  int process(const float*, const float*, float* L, float* R, int n) override {
    memset(L, 0, n * sizeof(float));
    if (R != L) memset(R, 0, n * sizeof(float));
    if (!sample) return 0;
    const Stage A = stage(p[ATTACK], p[ATK_CURVE], ATTACK_KMAX);
    const Stage D = stage(p[DECAY], p[DEC_CURVE], FALL_KMAX);
    const Stage Rel = stage(p[RELEASE], p[REL_CURVE], FALL_KMAX);
    const double k = 1 - exp(-n / (SMOOTH_S * sr));
    int active = 0;
    int leader = -1;
    for (int vi = 0; vi < poly; vi++) {
      auto& v = voices[vi];
      if (!v.stage) continue;
      active++;
      if (leader < 0 || v.age < voices[leader].age) leader = vi;
      const Stage* st = v.stage == 1 ? &A : v.stage == 2 ? &D : v.stage == 4 ? &Rel : nullptr;
      if (st) v.e = st->k ? exp(-st->k * v.u) : 1;
      const double targetStep = speed(v.pitch);
      velStart[vi] = v.vel;
      if (v.pitch != v.pitchT) v.pitch = fabs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
      if (v.vel != v.velT) v.vel = fabs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
      velStep[vi] = (v.vel - velStart[vi]) / n;
      stepStep[vi] = (targetStep - v.inc) / n;
    }
    const double loopLength = jsRound(15 * rate);
    for (int i = 0; i < n; i++) {
      if (oldSample) {
        blend = mind(1, blend + blendStep);
        if (blend == 1) {
          oldSample->release();
          oldSample = nullptr;
          if (pendingSample) {
            auto* bank = pendingSample;
            pendingSample = nullptr;
            applySample(bank, pendingRate, pendingSeconds);
          }
        }
      }
      bool wrapped = false;
      for (int vi = 0; vi < poly; vi++) {
        auto& v = voices[vi];
        if (!v.stage) continue;
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
            v.u += Rel.inc;
            if (v.u >= 1) { v.level = 0; v.stage = 0; }
            else { v.e *= Rel.m; v.level = v.l0 * (1 - (Rel.k ? (1 - v.e) * Rel.norm : v.u)); }
            break;
        }
        if (!v.stage) continue;
        const double current = sampleRead(sample->samples, sample->size, pos[vi], 1, true);
        const double previous = oldSample ? sampleRead(oldSample->samples, oldSample->size, pos[vi], 1, true) : current;
        const double value = previous + (current - previous) * blend;
        const double velocity = velStart[vi] + velStep[vi] * (i + 1);
        const double output = value * v.level * velocity * p[GAIN];
        L[i] = (float)(L[i] + output);
        if (R != L) R[i] = (float)(R[i] + output);
        v.inc += stepStep[vi];
        pos[vi] += v.inc;
        if (pos[vi] >= sample->size) {
          pos[vi] = fmod(pos[vi] - sample->size, loopLength);
          if (vi == leader) wrapped = true;
        }
      }
      if (wrapped && nextSample && !oldSample && !pendingSample) {
        auto* bank = nextSample;
        nextSample = nullptr;
        const double duration = sample->size / (voices[leader].inc * sr);
        applySample(bank, nextRate, mind(4, duration / 4));
        cycle = nextFrame;
      }
    }
    return active > 0;
  }
};

} // namespace ms
