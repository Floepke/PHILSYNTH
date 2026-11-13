// Band-limited frames and playback, twin of wavetable.dsp.js. Allocate on upload, FFT lazily
// into preallocated storage: even a first visit to a frame cannot grow memory during rendering.
#pragma once
#include "samplepoly.h"

namespace ms {

inline void sampleFft(double* re, double* im, int n, bool inverse = false) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      double t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const int sign = inverse ? 1 : -1;
  for (int len = 2; len <= n; len <<= 1) {
    const double ang = sign * 2 * PI / len, wr = cos(ang), wi = sin(ang);
    const int half = len >> 1;
    for (int s = 0; s < n; s += len) {
      double cr = 1, ci = 0;
      for (int k = 0; k < half; k++) {
        const int a = s + k, b = a + half;
        const double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const double t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

struct SampleTable {
  SampleBank* bank;
  int size, frames, M = 1, levels = 0, stride = 0;
  int sizes[32] = {}, offsets[32] = {};
  float* samples = nullptr;
  uint8_t* built = nullptr;
  double* work = nullptr;
  SampleTable(SampleBank* b, int frameSize) : bank(b) {
    size = (int)clampd(frameSize, 1, bank->size);
    frames = bank->size / size;
    while (M < size) M <<= 1;
    for (int h = M >> 1; h >= 1; h >>= 1) {
      sizes[levels] = levels ? (int)mind(M, maxd(32, 4 * h)) : M;
      offsets[levels] = stride;
      stride += sizes[levels++];
    }
    // A one-sample frame has no non-DC harmonics.
    if (!levels) { sizes[0] = 1; levels = stride = 1; }
    samples = (float*)calloc((size_t)stride * frames, sizeof(float));
    built = (uint8_t*)calloc(frames, 1);
    work = (double*)calloc((size_t)M * 4, sizeof(double));
  }
  ~SampleTable() { free(samples); free(built); free(work); }
  bool valid() const { return samples && built && work; }
  void build(int frame) {
    if (built[frame]) return;
    double* re = work; double* im = re + M; double* r = im + M; double* i = r + M;
    const float* src = bank->samples + frame * size;
    for (int j = 0; j < M; j++) re[j] = size == M ? src[j] : sampleRead(src, size, (double)j * size / M, 2, true);
    memset(im, 0, M * sizeof(double));
    sampleFft(re, im, M);
    for (int l = 0, h = M >> 1; h >= 1; l++, h >>= 1) {
      const int n = sizes[l], top = (int)mind(h, n / 2 - 1);
      memset(r, 0, n * sizeof(double)); memset(i, 0, n * sizeof(double));
      const double scale = (double)n / M;
      for (int k = 1; k <= top; k++) {
        r[k] = re[k] * scale; i[k] = im[k] * scale;
        r[n - k] = re[k] * scale; i[n - k] = -im[k] * scale;
      }
      sampleFft(r, i, n, true);
      float* out = samples + (size_t)frame * stride + offsets[l];
      for (int j = 0; j < n; j++) out[j] = (float)(r[j] / n);
    }
    built[frame] = 1;
  }
  const float* frame(int f, int l) {
    build(f);
    return samples + (size_t)f * stride + offsets[l];
  }
};

struct Wavetable : SamplePoly {
  enum { POLYPHONY, BLOCK, POSITION, INTERPOLATION, ATTACK, DECAY, SUSTAIN, RELEASE, GAIN, PARAMS };
  SampleTable* table = nullptr; // Reference owned by the adapter cache.
  double position = 0, pos = 0;
  int interpolation = 2;
  explicit Wavetable(double sr) : SamplePoly(sr) {}
  void param(int id, double v) override {
    switch (id) {
      case POLYPHONY: polyphony(v); break;
      case POSITION: position = v; break;
      case INTERPOLATION: interpolation = (int)clampd(toInt32(v), 0, 2); break;
      case ATTACK: attack = v; break;
      case DECAY: decay = v; break;
      case SUSTAIN: sustain = v; break;
      case RELEASE: release = v; break;
      case GAIN: gain = v; break;
    }
  }
  void start(Voice& v, double phase) override { v.pos = isfinite(phase) ? phase - floor(phase) : 0; }
  int process(const float*, const float*, float* L, float* R, int n) override {
    memset(L, 0, n * sizeof(float));
    if (!table) { if (R != L) memset(R, 0, n * sizeof(float)); return 0; }
    const Env e = envelope(n);
    const int last = table->frames - 1;
    const double target = clampd(position / 100, 0, 1), pos0 = pos;
    const double k = 1 - exp(-n / (0.01 * sr));
    pos = fabs(target - pos0) < 1e-6 ? target : pos0 + (target - pos0) * k;
    const double dp = (pos - pos0) / n;
    const double firstFp = pos0 * last;
    const int firstFrame = (int)floor(firstFp);
    const bool stableFrame = (int)floor((pos0 + dp * (n - 1)) * last) == firstFrame;
    int active = 0;
    bool baseBuilt = false;
    for (int vi = 0; vi < poly; vi++) {
      auto& v = voices[vi];
      if (!v.stage) continue;
      active++;
      double vel = v.vel;
      const double dv = glide(v, e.k, n);
      const double inc = mind(0.45, 440 * pow(2, (v.pitch - 69) / 12) / sr);
      // JS prepares frame zero to establish the common mip layout.
      if (!baseBuilt) { table->build(0); baseBuilt = true; }
      const int level = (int)clampd(ceil(log2(table->M * inc)), 0, table->levels - 1);
      const int size = table->sizes[level];
      const float* a0 = stableFrame ? table->frame(firstFrame, level) : nullptr;
      const bool needsNextFrame = stableFrame && firstFrame < last && (firstFp != firstFrame || dp != 0);
      const float* b0 = needsNextFrame ? table->frame(firstFrame + 1, level) : nullptr;
      for (int i = 0; i < n; i++) {
        const double lvl = tick(v, e);
        if (!v.stage) break;
        vel += dv;
        const double fp = (pos0 + dp * i) * last;
        const int f0 = stableFrame ? firstFrame : (int)floor(fp);
        const double t = fp - f0;
        const float* a = stableFrame ? a0 : table->frame(f0, level);
        double y = sampleRead(a, size, v.pos * size, interpolation, true);
        if (t > 0 && f0 < last) {
          const float* b = stableFrame ? b0 : table->frame(f0 + 1, level);
          const double bSample = sampleRead(b, size, v.pos * size, interpolation, true);
          y += (bSample - y) * t;
        }
        L[i] = (float)(L[i] + y * lvl * vel);
        v.pos += inc;
        if (v.pos >= 1) v.pos -= 1;
      }
    }
    const double g = gain * 0.5;
    for (int i = 0; i < n; i++) L[i] = (float)(L[i] * g);
    if (R != L) memcpy(R, L, n * sizeof(float));
    return active > 0;
  }
};

} // namespace ms
