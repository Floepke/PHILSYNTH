// Twins of delay.dsp.js / echo.dsp.js, including their timing and shared delay line.
#pragma once
#include "kernel.h"
#include "svf.h"

namespace ms {

inline double delayPeriod(double value) {
  static const double periods[] = {64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1.5, 1, 0.75, 2.0/3, 0.5, 1.0/3, 0.25};
  const double want = log(1 / (4 / pow(256, clampd(value, 0, 10000) / 10000)));
  double best = periods[0];
  for (double p : periods) if (fabs(log(p) - want) < fabs(log(best) - want)) best = p;
  return best;
}

inline double delaySeconds(double value, int unit, double bpm) {
  static const double beats[] = {0, 1, 0.5, 0.25};
  value = clampd(value, 0, 10000);
  return unit ? delayPeriod(value) * beats[unit] * 60 / clampd(bpm, 20, 1000) : value / 1000;
}

struct DelayLine {
  int length, pos = 0;
  float* buffers[2];
  explicit DelayLine(double sr) : length((int)ceil(sr * 192) + 2) {
    for (auto& b : buffers) b = (float*)calloc(length, sizeof(float));
  }
  ~DelayLine() { for (auto b : buffers) free(b); }

  double read(int channel, double delay) const {
    double at = pos - delay;
    if (at < 0) at += length;
    const int i = (int)floor(at);
    const double f = at - i;
    const float* b = buffers[channel];
    return (double)b[i] + ((double)b[(i + 1) % length] - b[i]) * f;
  }
  void advance() { if (++pos == length) pos = 0; }
};

struct Delay : Kernel {
  enum { LEFT, RIGHT, UNIT, PARAMS };
  double p[PARAMS] = {250, 250, 0};
  double bpm = 120, delay[2] = {}, target[2] = {}, smooth;
  bool started = false;
  DelayLine line;

  explicit Delay(double sr) : Kernel(sr), smooth(1 - exp(-1 / (0.004 * sr))), line(sr) { updateDelay(); }
  void updateDelay() {
    for (int ch = 0; ch < 2; ch++) {
      target[ch] = delaySeconds(p[ch], (int)p[UNIT], bpm) * sr;
      if (!started) delay[ch] = target[ch];
    }
  }
  void tempo(double value) override { bpm = value; updateDelay(); }
  void param(int id, double value) override {
    if (id < 0 || id >= PARAMS) return;
    p[id] = id == UNIT ? clampd(toInt32(value), 0, 3) : value;
    updateDelay();
  }
  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    const float* in[2] = {inL, inR ? inR : inL};
    float* out[2] = {outL, outR};
    started = true;
    bool live = false;
    for (int i = 0; i < n; i++) {
      for (int ch = 0; ch < 2; ch++) {
        delay[ch] += (target[ch] - delay[ch]) * smooth;
        line.buffers[ch][line.pos] = in[ch] ? in[ch][i] : 0;
        const double y = line.read(ch, delay[ch]);
        if (ch == 0 || outR != outL) out[ch][i] = y;
        if (y != 0) live = true;
      }
      line.advance();
    }
    return live;
  }
};

struct Echo : Kernel {
  enum { DRY, WET, FEEDBACK, DELAY, UNIT, MODE, FILTER, CUTOFF, PARAMS };
  double p[PARAMS] = {1, 0.5, 0.5, 250, 0, 0, 0, 4000};
  double bpm = 120, delay, target, smooth, logF, cachedLogF = NAN, a1 = 0, a2 = 0, a3 = 0;
  bool started = false;
  DelayLine line;
  Svf svf[2][4];

  explicit Echo(double sr) : Kernel(sr), smooth(1 - exp(-1 / (0.004 * sr))), logF(log2(4000)), line(sr) { updateDelay(); }
  void updateDelay() {
    target = maxd(1, delaySeconds(p[DELAY], (int)p[UNIT], bpm) * sr);
    if (!started) delay = target;
  }
  double cutoffLog() const { return log2(maxd(20, mind(mind(20000, sr * 0.45), p[CUTOFF]))); }
  void tempo(double value) override { bpm = value; updateDelay(); }
  void param(int id, double value) override {
    if (id < 0 || id >= PARAMS) return;
    if (id == FILTER) {
      value = clampd(toInt32(value), 0, 8);
      if (value != p[FILTER]) for (auto& ch : svf) for (auto& st : ch) st.ic1 = st.ic2 = 0;
    } else if (id == UNIT) value = clampd(toInt32(value), 0, 3);
    else if (id == FEEDBACK) value = clampd(value, 0, 0.99);
    p[id] = value;
    if (id == DELAY || id == UNIT) updateDelay();
    if (!started && id == CUTOFF) logF = cutoffLog();
  }
  double filtered(int ch, double x, int stages, bool high) {
    for (int s = 0; s < stages; s++) {
      Svf& st = svf[ch][s];
      st.tick(x, a1, a2, a3);
      x = high ? x - SQRT2 * st.band - st.low : st.low;
      if (fabs(st.ic1) < 1e-20) st.ic1 = 0;
      if (fabs(st.ic2) < 1e-20) st.ic2 = 0;
    }
    return fabs(x) < 1e-20 ? 0 : x;
  }
  int process(const float* inL, const float* inR, float* outL, float* outR, int n) override {
    const int stages = p[FILTER] ? ((int)p[FILTER] - 1) % 4 + 1 : 0;
    const bool high = p[FILTER] > 4;
    const double targetLogF = cutoffLog();
    started = true;
    bool live = false;
    for (int i = 0; i < n; i++) {
      delay += (target - delay) * smooth;
      logF += (targetLogF - logF) * smooth;
      if (stages && logF != cachedLogF) {
        cachedLogF = logF;
        const double g = tan(PI * exp(logF * LN2) / sr);
        a1 = 1 / (1 + g * (g + SQRT2));
        a2 = g * a1;
        a3 = g * a2;
      }
      const double l = inL ? inL[i] : 0;
      const double r = inR ? inR[i] : l;
      const double dl = filtered(0, line.read(0, delay), stages, high);
      const double dr = filtered(1, line.read(1, delay), stages, high);
      line.buffers[0][line.pos] = (p[MODE] ? (l + r) * 0.5 : l) + p[FEEDBACK] * (p[MODE] ? dr : dl);
      line.buffers[1][line.pos] = (p[MODE] ? 0 : r) + p[FEEDBACK] * (p[MODE] ? dl : dr);
      outL[i] = p[DRY] * l + p[WET] * dl;
      if (outR != outL) outR[i] = p[DRY] * r + p[WET] * dr;
      if (outL[i] != 0 || outR[i] != 0) live = true;
      line.advance();
    }
    return live;
  }
};

}  // namespace ms
