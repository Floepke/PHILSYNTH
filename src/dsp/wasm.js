// C++ DSP kernels (cpp/, compiled to modsynth.wasm by build-wasm.mjs) as engine-graph kernels.
//
//   const x = instantiateDsp(bytes);              // sync; throws when the module doesn't fit
//   const { heap, kernels } = wasmKernels(x, sr);  // -> new Graph({ heap, kernels })
//
// When every audio node of a graph is one of these, the graph renders a block with a single call
// (ms_run in cpp/engine.cpp, see Graph.rebuild()); otherwise each kernel is called from JS.
// Each adapter class has the JS kernel contract (src/dsp/kernel.js) and forwards to its C++ twin
// (string controller ids -> the index order of the C++ enum, listed in SPECS). With a heap the
// graph keeps every audio buffer in wasm memory, so a C++ kernel reads its input and writes its
// output in place; buffers outside the heap (tests) are copied through a scratch area.
import { Kernel } from './kernel.js';
import { curveTable, defaultCurve } from '../curve.js';

export const WASM_VERSION = 6;

// kind = Kind in cpp/engine.cpp; params in the order of the kernel's enum
export const SPECS = {
  osc: { kind: 1, params: ['polyphony', 'wave', 'attack', 'decay', 'sustain', 'release', 'gain', 'duty'] },
  filter: {
    kind: 2,
    params: ['type', 'slope', 'cutoff', 'resonance', 'gain', 'vowel', 'drive', 'lfoShape', 'lfoRate', 'lfoDepth', 'mix', 'level'],
  },
  reverb: {
    kind: 3,
    params: ['mix', 'size', 'decay', 'damp', 'seed', 'predelay', 'early', 'diffusion', 'mod', 'lowCut', 'highCut', 'width', 'freeze', 'level'],
  },
  waveshaper: { kind: 4, params: ['drive', 'range', 'oversample', 'mix', 'level'], passive: true },
  bus: { kind: 5, params: [], passive: true },
  amp: { kind: 6, params: ['amp', 'inverse', 'pan'], passive: true },
  out: { kind: 7, params: ['volume', 'bpm'], passive: true },
  dcblock: { kind: 8, params: [], passive: true },
  eq: { kind: 9, params: [...Array.from({ length: 16 }, (_, i) => `b${i}`), 'q', 'level'] },
  delay: { kind: 10, params: ['left', 'right', 'unit'] },
  echo: { kind: 11, params: ['dry', 'wet', 'feedback', 'delay', 'unit', 'mode', 'filter', 'cutoff'] },
  modulator: { kind: 12, params: ['type', 'carrier', 'interpolation'], carrierInput: true },
};

const NOTE = { noteOn: 0, noteMod: 1, noteOff: 2, allOff: 3 };
const TABLE = 4096; // Waveshaper::TABLE
const SCRATCH = 4096; // samples per scratch slot (inL, inR, outL, outR, modL, modR)

export function instantiateDsp(bytes) {
  const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
  x._initialize?.();
  const v = x.ms_version();
  if (v !== WASM_VERSION) throw new Error(`modsynth.wasm has API version ${v}, expected ${WASM_VERSION} (run npm run build:wasm)`);
  for (const [name, s] of Object.entries(SPECS)) {
    const n = x.ms_param_count(s.kind);
    if (n !== s.params.length) throw new Error(`modsynth.wasm: ${name} has ${n} controllers, expected ${s.params.length}`);
  }
  return x;
}

// Memory of the wasm module, for the graph's audio buffers.
export class WasmHeap {
  constructor(x) {
    this.x = x;
    this.memory = x.memory;
    this.buffer = this.memory.buffer;
    this.scratchPtr = this.alloc(6 * SCRATCH * 4);
  }

  alloc(bytes) {
    const p = this.x.ms_alloc(bytes);
    if (!p) throw new Error('DSP memory exhausted');
    return p;
  }

  free(p) {
    if (p) this.x.ms_free(p);
  }

  f32(ptr, len) {
    return new Float32Array(this.memory.buffer, ptr, len);
  }

  has(a) {
    return a.buffer === this.memory.buffer;
  }

  // True once after the memory grew: every view made before is detached and must be remade.
  grown() {
    if (this.memory.buffer === this.buffer) return false;
    this.buffer = this.memory.buffer;
    return true;
  }

  scratch(slot) {
    return this.scratchPtr + slot * SCRATCH * 4;
  }

  // pointer to the first n samples of `a`: in place when it lives here, else copied to a scratch slot
  input(a, slot, n) {
    if (this.has(a)) return a.byteOffset;
    const p = this.scratch(slot);
    this.f32(p, n).set(a.length > n ? a.subarray(0, n) : a);
    return p;
  }
}

function kernelClass(name, spec, x, heap, sr) {
  const ids = new Map(spec.params.map((id, i) => [id, i]));
  return class WasmKernel extends Kernel {
    static passive = !!spec.passive;
    static wasm = true;
    static carrierInput = !!spec.carrierInput;

    constructor(opts = {}) {
      super();
      this.ptr = x.ms_create(spec.kind, sr, opts?.salt | 0, (opts?.seed ?? Math.random() * 2 ** 32) >>> 0);
      if (!this.ptr) throw new Error(`DSP: cannot create ${name}`);
    }

    param(id, value) {
      const i = ids.get(id);
      if (i !== undefined) x.ms_param(this.ptr, i, +value);
    }

    get carrier() { return x.ms_carrier(this.ptr); }

    panic() { x.ms_panic(this.ptr); }

    message(m) {
      switch (m.type) {
        case 'param': this.param(m.id, m.value); break;
        case 'bpm': x.ms_bpm(this.ptr, m.value); break;
        case 'noteOn': x.ms_note(this.ptr, NOTE.noteOn, m.id, m.pitch, m.velocity, +m.phase || 0); break;
        case 'noteMod': for (const [id, pitch, vel] of m.notes) x.ms_note(this.ptr, NOTE.noteMod, id, pitch, vel, 0); break;
        case 'noteOff': x.ms_note(this.ptr, NOTE.noteOff, m.id, 0, 0, 0); break;
        case 'allOff': x.ms_note(this.ptr, NOTE.allOff, 0, 0, 0, 0); break;
      }
    }

    process(inputs, outputs) {
      const i = inputs[0];
      const o = outputs[0];
      const oL = o[0];
      const oR = o[1] ?? oL;
      const n = oL.length;
      if (n > SCRATCH) throw new Error(`DSP: render quantum of ${n} samples is too long`);
      let pl = 0;
      let pr = 0;
      if (i && i.length) {
        pl = heap.input(i[0], 0, n);
        pr = i[1] && i[1] !== i[0] ? heap.input(i[1], 1, n) : pl;
      }
      const inL = heap.has(oL);
      const inR = heap.has(oR);
      const dl = inL ? oL.byteOffset : heap.scratch(2);
      const dr = oR === oL ? dl : inR ? oR.byteOffset : heap.scratch(3);
      let r;
      if (spec.carrierInput) {
        const m = inputs[1];
        const ml = m?.length ? heap.input(m[0], 4, n) : 0;
        const mr = m?.[1] && m[1] !== m[0] ? heap.input(m[1], 5, n) : ml;
        r = x.ms_process_modulated(this.ptr, pl, pr, ml, mr, dl, dr, n);
      } else r = x.ms_process(this.ptr, pl, pr, dl, dr, n);
      if (r === 0) return false; // silent: outputs are undefined, like the JS kernels
      if (!inL) oL.set(heap.f32(dl, n));
      if (oR !== oL && !inR) oR.set(heap.f32(dr, n));
      return true;
    }

    destroy() {
      if (this.ptr) x.ms_destroy(this.ptr);
      this.ptr = 0;
    }
  };
}

// The curve -> table step stays in JS (curve.js, shared with the panel); 'range' picks the table.
function waveshaperClass(Base, x, heap) {
  return class WasmWaveshaper extends Base {
    constructor(opts) {
      super(opts);
      this.curve = defaultCurve();
      this.symmetric = true;
      this.upload();
    }

    param(id, value) {
      if (id !== 'range') return super.param(id, value);
      const sym = value < 0.5;
      if (sym !== this.symmetric) {
        this.symmetric = sym;
        this.upload();
      }
    }

    message(m) {
      if (m.type !== 'curve') return super.message(m);
      this.curve = m.curve;
      this.upload();
    }

    upload() {
      heap.f32(x.ms_data(this.ptr, 0, TABLE), TABLE).set(curveTable(this.curve, this.symmetric, TABLE));
    }
  };
}

// Kernel classes for every kind in SPECS (to override the JS ones) plus the heap they render in.
export function wasmKernels(x, sr = globalThis.sampleRate) {
  const heap = new WasmHeap(x);
  const kernels = {};
  for (const [name, spec] of Object.entries(SPECS)) kernels[name] = kernelClass(name, spec, x, heap, sr);
  kernels.waveshaper = waveshaperClass(kernels.waveshaper, x, heap);
  return { heap, kernels };
}
