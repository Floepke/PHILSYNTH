// C API of the C++ DSP kernels, compiled to src/dsp/modsynth.wasm by build-wasm.mjs and used by
// src/dsp/wasm.js (adapters that plug these kernels into the engine graph, src/dsp/graph.js).
// Pointers are byte offsets into the module's memory; audio buffers are float[n].
#include "basic.h"
#include "delay.h"
#include "eq.h"
#include "filter.h"
#include "kernel.h"
#include "modulator.h"
#include "osc.h"
#include "operator.h"
#include "imagesampler.h"
#include "reverb.h"
#include "waveshaper.h"
#include "distortion.h"
#include "vibrato.h"
#include "sampler.h"
#include "wavetable.h"

// no libc++: plain malloc-backed new/delete
void* operator new(__SIZE_TYPE__ n) { return malloc(n); }
void operator delete(void* p) noexcept { free(p); }
void operator delete(void* p, __SIZE_TYPE__) noexcept { free(p); }

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

using namespace ms;

enum Kind { KIND_OSC = 1, KIND_FILTER = 2, KIND_REVERB = 3, KIND_WAVESHAPER = 4, KIND_BUS = 5, KIND_AMP = 6, KIND_OUT = 7, KIND_DCBLOCK = 8, KIND_EQ = 9, KIND_DELAY = 10, KIND_ECHO = 11, KIND_MODULATOR = 12, KIND_OPERATOR = 13, KIND_IMAGESAMPLER = 14, KIND_DISTORTION = 15, KIND_VIBRATO = 16, KIND_SAMPLER = 17, KIND_WAVETABLE = 18, KIND_FEEDBACK = 19 };

// Bumped when the API changes; src/dsp/wasm.js refuses other versions.
EXPORT(ms_version) int ms_version() { return 20; }

EXPORT(ms_param_count) int ms_param_count(int kind) {
  switch (kind) {
    case KIND_OSC: return Osc::PARAMS;
    case KIND_OPERATOR: return Operator::PARAMS;
    case KIND_IMAGESAMPLER: return ImageSampler::PARAMS;
    case KIND_FILTER: return Filter::PARAMS;
    case KIND_REVERB: return Reverb::PARAMS;
    case KIND_WAVESHAPER: return Waveshaper::PARAMS;
    case KIND_DISTORTION: return Distortion::PARAMS;
    case KIND_VIBRATO: return Vibrato::PARAMS;
    case KIND_SAMPLER: return Sampler::PARAMS;
    case KIND_WAVETABLE: return Wavetable::PARAMS;
    case KIND_BUS: return Bus::PARAMS;
    case KIND_AMP: return Amp::PARAMS;
    case KIND_FEEDBACK: return Feedback::PARAMS;
    case KIND_OUT: return Out::PARAMS;
    case KIND_DCBLOCK: return DcBlock::PARAMS;
    case KIND_EQ: return Eq::PARAMS;
    case KIND_DELAY: return Delay::PARAMS;
    case KIND_ECHO: return Echo::PARAMS;
    case KIND_MODULATOR: return Modulator::PARAMS;
  }
  return 0;
}

EXPORT(ms_alloc) void* ms_alloc(int bytes) { return calloc(bytes, 1); }
EXPORT(ms_free) void ms_free(void* p) { free(p); }

// salt: REVERB per-instance seed offset; seed: random seed (FILTER's random LFO, OSC noise)
EXPORT(ms_create) Kernel* ms_create(int kind, double sampleRate, int salt, uint32_t seed) {
  switch (kind) {
    case KIND_OSC: return new Osc(sampleRate, seed);
    case KIND_OPERATOR: return new Operator(sampleRate);
    case KIND_IMAGESAMPLER: return new ImageSampler(sampleRate);
    case KIND_FILTER: return new Filter(sampleRate, seed);
    case KIND_REVERB: return new Reverb(sampleRate, salt);
    case KIND_WAVESHAPER: return new Waveshaper(sampleRate);
    case KIND_DISTORTION: return new Distortion(sampleRate);
    case KIND_VIBRATO: return new Vibrato(sampleRate);
    case KIND_SAMPLER: return new Sampler(sampleRate);
    case KIND_WAVETABLE: return new Wavetable(sampleRate);
    case KIND_BUS: return new Bus(sampleRate);
    case KIND_AMP: return new Amp(sampleRate);
    case KIND_FEEDBACK: return new Feedback(sampleRate);
    case KIND_OUT: return new Out(sampleRate);
    case KIND_DCBLOCK: return new DcBlock(sampleRate);
    case KIND_EQ: return new Eq(sampleRate);
    case KIND_DELAY: return new Delay(sampleRate);
    case KIND_ECHO: return new Echo(sampleRate);
    case KIND_MODULATOR: return new Modulator(sampleRate);
  }
  return nullptr;
}

EXPORT(ms_destroy) void ms_destroy(Kernel* k) { delete k; }
EXPORT(ms_sample_create) SampleBank* ms_sample_create(int size, int stereo) {
  if (size < 1 || (size_t)size > SIZE_MAX / (2 * sizeof(float))) return nullptr;
  auto* bank = new SampleBank(size, stereo != 0);
  if (!bank->samples) { delete bank; return nullptr; }
  return bank;
}
EXPORT(ms_sample_data) float* ms_sample_data(SampleBank* bank) { return bank->samples; }
EXPORT(ms_sample_free) void ms_sample_free(SampleBank* bank) { delete bank; }
EXPORT(ms_sample_set) void ms_sample_set(Sampler* k, SampleBank* bank, double rate) { k->setSample(bank, rate); }
EXPORT(ms_table_create) SampleTable* ms_table_create(SampleBank* bank, int frame) {
  if (!bank || frame < 1) return nullptr;
  auto* table = new SampleTable(bank, frame);
  if (!table->valid()) { delete table; return nullptr; }
  return table;
}
EXPORT(ms_table_free) void ms_table_free(SampleTable* table) { delete table; }
EXPORT(ms_table_set) void ms_table_set(Wavetable* k, SampleTable* table) { k->table = table; }
EXPORT(ms_image_create) ImagePyramid* ms_image_create(int w, int h, const uint8_t* rgb) {
  if (w < 1 || h < 1 || w > 256 || h > 256 || !rgb) return nullptr;
  auto* image = new ImagePyramid(w, h, rgb);
  if (!image->pixels) { delete image; return nullptr; }
  return image;
}
EXPORT(ms_image_free) void ms_image_free(ImagePyramid* image) { delete image; }
EXPORT(ms_image_set) void ms_image_set(ImageSampler* k, ImagePyramid* image) { k->setImage(image); }
EXPORT(ms_param) void ms_param(Kernel* k, int id, double v) { k->param(id, v); }
EXPORT(ms_bpm) void ms_bpm(Kernel* k, double value) { k->tempo(value); }
EXPORT(ms_note) void ms_note(Kernel* k, int type, double id, double pitch, double vel, double phase) { k->note(type, id, pitch, vel, phase); }
EXPORT(ms_data) float* ms_data(Kernel* k, int slot, int size) { return k->data(slot, size); }
EXPORT(ms_process) int ms_process(Kernel* k, const float* inL, const float* inR, float* outL, float* outR, int n) {
  return k->process(inL, inR, outL, outR, n);
}
EXPORT(ms_carrier) int ms_carrier(Kernel* k) { return k->carrier(); }
EXPORT(ms_panic) void ms_panic(Kernel* k) { k->panic(); }
EXPORT(ms_dormant) int ms_dormant(Kernel* k) { return k->dormant(); }
EXPORT(ms_process_modulated) int ms_process_modulated(Kernel* k, const float* inL, const float* inR,
    const float* modL, const float* modR, float* outL, float* outR, int n) {
  return k->processModulated(inL, inR, modL, modR, outL, outR, n);
}

// ---- graph runner: one call renders a whole graph whose audio nodes are all C++ kernels ----
// src/dsp/graph.js keeps the topology (and runs the modulators); after every change it uploads
// the render order as a program: [count, then per node: GNode*, source count, source GNode*...],
// sources first, the master bus last. Same rules as Graph.render(): one live source is read in
// place, several are summed into the node's sum buffer, a passive node without live sources is
// skipped and stays silent.
// Carrier-aware nodes select one source by index and only sum the other sources.
// A sound loop is one entry [0, member count, then per member: GNode*, source count, and per
// source GNode* and 0 outside the loop / 1 inside / 2 inside, previous sample]; its members
// render sample by sample (see renderLoop and the header of src/dsp/graph.js).
constexpr int MAX_BLOCK = 128;
struct GNode {
  Kernel* k;
  float* out;  // [L | R], n samples each
  float* sum;  // [L | R] or nullptr (only nodes with 2+ sources have one)
  int32_t passive;
  int32_t silent;
  int32_t carrierInput;
  uint8_t liveAt[MAX_BLOCK];  // in a loop: which samples of out were live
};

EXPORT(ms_node) GNode* ms_node(Kernel* k, float* out, int flags) {
  GNode* g = (GNode*)calloc(1, sizeof(GNode));
  if (!g) return nullptr;
  g->k = k;
  g->out = out;
  g->passive = flags & 1;
  g->carrierInput = flags & 2;
  g->silent = 1;
  return g;
}
EXPORT(ms_node_free) void ms_node_free(GNode* g) { free(g); }
EXPORT(ms_node_sum) void ms_node_sum(GNode* g, float* sum) { g->sum = sum; }
EXPORT(ms_node_silent) int ms_node_silent(GNode* g) { return g->silent; }
// like Graph.rebuild(): only the last sample of the previous block counts as live in a loop
EXPORT(ms_node_set_silent) void ms_node_set_silent(GNode* g, int s) {
  g->silent = s;
  memset(g->liveAt, 0, sizeof g->liveAt);
  g->liveAt[MAX_BLOCK - 1] = s ? 0 : 1;
}

// One sound loop (the program entry after its 0), sample by sample; returns the entry's end.
static const int32_t* renderLoop(const int32_t* p, int n, GNode** last) {
  const int members = p[0];
  const int32_t* start = p + 1;
  p = start;
  for (int m = 0; m < members; m++) {
    GNode* g = (GNode*)(uintptr_t)p[0];
    g->silent = 1;
    p += 2 + 2 * p[1];
  }
  const int32_t* end = p;
  for (int i = 0; i < n; i++) {
    const int prev = i ? i - 1 : n - 1;
    for (p = start; p < end;) {
      GNode* g = (GNode*)(uintptr_t)p[0];
      const int nsrc = p[1];
      const int32_t* srcs = p + 2;
      p += 2 + 2 * nsrc;
      *last = g;
      GNode* carrier = nullptr;
      if (g->carrierInput) {
        int index = g->k->carrier();
        if (index >= 0 && index < nsrc) carrier = (GNode*)(uintptr_t)srcs[2 * index];
      }
      float in[2] = {0, 0};
      float car[2] = {0, 0};
      float out[2] = {0, 0};
      int live = 0;
      bool carried = false;
      for (int s = 0; s < nsrc; s++) {
        GNode* src = (GNode*)(uintptr_t)srcs[2 * s];
        const int where = srcs[2 * s + 1];
        const int j = where == 2 ? prev : i;
        if (!src || (where ? !src->liveAt[j] : src->silent)) continue;
        if (src == carrier) {
          car[0] = src->out[j];
          car[1] = src->out[n + j];
          carried = true;
        } else {
          in[0] += src->out[j];
          in[1] += src->out[n + j];
          live++;
        }
      }
      bool on;
      if (!live && g->passive) on = false;
      else if (!live && !carried && g->k->dormant()) on = false;
      else if (g->carrierInput)
        on = g->k->processModulated(carried ? car : nullptr, carried ? car + 1 : nullptr, live ? in : nullptr, live ? in + 1 : nullptr, out, out + 1, 1) != 0;
      else on = g->k->process(live ? in : nullptr, live ? in + 1 : nullptr, out, out + 1, 1) != 0;
      g->out[i] = on ? out[0] : 0;
      g->out[n + i] = on ? out[1] : 0;
      g->liveAt[i] = on;
      if (on) g->silent = 0;
    }
  }
  return end;
}

// Returns 1 when the last node (the master bus) has sound.
EXPORT(ms_run) int ms_run(const int32_t* prog, int n) {
  const int count = prog[0];
  const int32_t* p = prog + 1;
  GNode* last = nullptr;
  for (int c = 0; c < count; c++) {
    if (!p[0]) {
      p = renderLoop(p + 1, n, &last);
      continue;
    }
    GNode* g = (GNode*)(uintptr_t)p[0];
    const int nsrc = p[1];
    const int32_t* srcs = p + 2;
    p += 2 + nsrc;
    last = g;
    GNode* carrier = nullptr;
    if (g->carrierInput) {
      int index = g->k->carrier();
      if (index >= 0 && index < nsrc) carrier = (GNode*)(uintptr_t)srcs[index];
    }
    int live = 0;
    GNode* one = nullptr;
    for (int s = 0; s < nsrc; s++) {
      GNode* src = (GNode*)(uintptr_t)srcs[s];
      if (src && src != carrier && !src->silent) { live++; one = src; }
    }
    if (!live && g->passive) { g->silent = 1; continue; }
    if (!live && (!carrier || carrier->silent) && g->k->dormant()) { g->silent = 1; continue; }
    const float* in = nullptr;
    if (live == 1) in = one->out;
    else if (live > 1) {
      float* sum = g->sum;
      memset(sum, 0, 2 * n * sizeof(float));
      for (int s = 0; s < nsrc; s++) {
        GNode* src = (GNode*)(uintptr_t)srcs[s];
        if (!src || src == carrier || src->silent) continue;
        const float* o = src->out;
        for (int i = 0; i < 2 * n; i++) sum[i] += o[i];
      }
      in = sum;
    }
    if (g->carrierInput) {
      const float* c = carrier && !carrier->silent ? carrier->out : nullptr;
      g->silent = g->k->processModulated(c, c ? c + n : nullptr, in, in ? in + n : nullptr, g->out, g->out + n, n) == 0;
    } else g->silent = g->k->process(in, in ? in + n : nullptr, g->out, g->out + n, n) == 0;
  }
  return last && !last->silent;
}
