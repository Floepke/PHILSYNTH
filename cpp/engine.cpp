// C API of the C++ DSP kernels, compiled to src/dsp/modsynth.wasm by build-wasm.mjs and used by
// src/dsp/wasm.js (adapters that plug these kernels into the engine graph, src/dsp/graph.js).
// Pointers are byte offsets into the module's memory; audio buffers are float[n].
#include "basic.h"
#include "filter.h"
#include "kernel.h"
#include "osc.h"
#include "reverb.h"
#include "waveshaper.h"

// no libc++: plain malloc-backed new/delete
void* operator new(__SIZE_TYPE__ n) { return malloc(n); }
void operator delete(void* p) noexcept { free(p); }
void operator delete(void* p, __SIZE_TYPE__) noexcept { free(p); }

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

using namespace ms;

enum Kind { KIND_OSC = 1, KIND_FILTER = 2, KIND_REVERB = 3, KIND_WAVESHAPER = 4, KIND_BUS = 5, KIND_AMP = 6, KIND_OUT = 7 };

// Bumped when the API changes; src/dsp/wasm.js refuses other versions.
EXPORT(ms_version) int ms_version() { return 2; }

EXPORT(ms_param_count) int ms_param_count(int kind) {
  switch (kind) {
    case KIND_OSC: return Osc::PARAMS;
    case KIND_FILTER: return Filter::PARAMS;
    case KIND_REVERB: return Reverb::PARAMS;
    case KIND_WAVESHAPER: return Waveshaper::PARAMS;
    case KIND_BUS: return Bus::PARAMS;
    case KIND_AMP: return Amp::PARAMS;
    case KIND_OUT: return Out::PARAMS;
  }
  return 0;
}

EXPORT(ms_alloc) void* ms_alloc(int bytes) { return calloc(bytes, 1); }
EXPORT(ms_free) void ms_free(void* p) { free(p); }

// salt: REVERB per-instance seed offset; seed: random seed (FILTER's random LFO, OSC noise)
EXPORT(ms_create) Kernel* ms_create(int kind, double sampleRate, int salt, uint32_t seed) {
  switch (kind) {
    case KIND_OSC: return new Osc(sampleRate, seed);
    case KIND_FILTER: return new Filter(sampleRate, seed);
    case KIND_REVERB: return new Reverb(sampleRate, salt);
    case KIND_WAVESHAPER: return new Waveshaper(sampleRate);
    case KIND_BUS: return new Bus(sampleRate);
    case KIND_AMP: return new Amp(sampleRate);
    case KIND_OUT: return new Out(sampleRate);
  }
  return nullptr;
}

EXPORT(ms_destroy) void ms_destroy(Kernel* k) { delete k; }
EXPORT(ms_param) void ms_param(Kernel* k, int id, double v) { k->param(id, v); }
EXPORT(ms_note) void ms_note(Kernel* k, int type, double id, double pitch, double vel) { k->note(type, id, pitch, vel); }
EXPORT(ms_data) float* ms_data(Kernel* k, int slot, int size) { return k->data(slot, size); }
EXPORT(ms_process) int ms_process(Kernel* k, const float* inL, const float* inR, float* outL, float* outR, int n) {
  return k->process(inL, inR, outL, outR, n);
}

// ---- graph runner: one call renders a whole graph whose audio nodes are all C++ kernels ----
// src/dsp/graph.js keeps the topology (and runs the modulators); after every change it uploads
// the render order as a program: [count, then per node: GNode*, source count, source GNode*...],
// sources first, the master bus last. Same rules as Graph.render(): one live source is read in
// place, several are summed into the node's sum buffer, a passive node without live sources is
// skipped and stays silent.
struct GNode {
  Kernel* k;
  float* out;  // [L | R], n samples each
  float* sum;  // [L | R] or nullptr (only nodes with 2+ sources have one)
  int32_t passive;
  int32_t silent;
};

EXPORT(ms_node) GNode* ms_node(Kernel* k, float* out, int passive) {
  GNode* g = (GNode*)calloc(1, sizeof(GNode));
  if (!g) return nullptr;
  g->k = k;
  g->out = out;
  g->passive = passive;
  g->silent = 1;
  return g;
}
EXPORT(ms_node_free) void ms_node_free(GNode* g) { free(g); }
EXPORT(ms_node_sum) void ms_node_sum(GNode* g, float* sum) { g->sum = sum; }
EXPORT(ms_node_silent) int ms_node_silent(GNode* g) { return g->silent; }
EXPORT(ms_node_set_silent) void ms_node_set_silent(GNode* g, int s) { g->silent = s; }

// Returns 1 when the last node (the master bus) has sound.
EXPORT(ms_run) int ms_run(const int32_t* prog, int n) {
  const int count = prog[0];
  const int32_t* p = prog + 1;
  GNode* last = nullptr;
  for (int c = 0; c < count; c++) {
    GNode* g = (GNode*)(uintptr_t)p[0];
    const int nsrc = p[1];
    const int32_t* srcs = p + 2;
    p += 2 + nsrc;
    last = g;
    int live = 0;
    GNode* one = nullptr;
    for (int s = 0; s < nsrc; s++) {
      GNode* src = (GNode*)(uintptr_t)srcs[s];
      if (!src->silent) { live++; one = src; }
    }
    if (!live && g->passive) { g->silent = 1; continue; }
    const float* in = nullptr;
    if (live == 1) in = one->out;
    else if (live > 1) {
      float* sum = g->sum;
      memset(sum, 0, 2 * n * sizeof(float));
      for (int s = 0; s < nsrc; s++) {
        GNode* src = (GNode*)(uintptr_t)srcs[s];
        if (src->silent) continue;
        const float* o = src->out;
        for (int i = 0; i < 2 * n; i++) sum[i] += o[i];
      }
      in = sum;
    }
    g->silent = g->k->process(in, in ? in + n : nullptr, g->out, g->out + n, n) == 0;
  }
  return last && !last->silent;
}
