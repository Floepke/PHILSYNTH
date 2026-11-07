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
import { imageCache } from './imagecache.js';
import { BLOCK_SIZES, DEFAULT_FRAME, builtinTable } from '../modules/wavetable.dsp.js';

export const WASM_VERSION = 20;

// kind = Kind in cpp/engine.cpp; params in the order of the kernel's enum
export const SPECS = {
  osc: { kind: 1, params: ['polyphony', 'wave', 'attack', 'decay', 'sustain', 'release', 'gain', 'duty', 'atkCurve', 'decCurve', 'relCurve'] },
  filter: {
    kind: 2,
    params: ['type', 'slope', 'cutoff', 'resonance', 'gain', 'vowel', 'drive', 'lfoShape', 'lfoRate', 'lfoDepth', 'mix', 'level'],
  },
  reverb: {
    kind: 3,
    params: ['mix', 'size', 'decay', 'damp', 'seed', 'predelay', 'early', 'diffusion', 'mod', 'lowCut', 'highCut', 'width', 'freeze', 'level'],
  },
  waveshaper: { kind: 4, params: ['drive', 'range', 'oversample', 'mix', 'level'] },
  distortion: { kind: 15, params: ['type', 'power', 'bits', 'frequency'] },
  vibrato: { kind: 16, params: ['wave', 'unit', 'freq', 'phase', 'amp'] },
  sampler: { kind: 17, params: ['polyphony', 'selStart', 'selLength', 'playMode', 'transpose', 'finetune', 'interpolation', 'attack', 'decay', 'sustain', 'release', 'gain'] },
  wavetable: { kind: 18, params: ['polyphony', 'block', 'position', 'interpolation', 'attack', 'decay', 'sustain', 'release', 'gain'] },
  bus: { kind: 5, params: [], passive: true },
  amp: { kind: 6, params: ['amp', 'inverse', 'pan', 'fine'], passive: true },
  feedback: { kind: 19, params: ['feedback'], passive: true },
  out: { kind: 7, params: ['volume', 'bpm'], passive: true },
  dcblock: { kind: 8, params: [] },
  eq: { kind: 9, params: [...Array.from({ length: 16 }, (_, i) => `b${i}`), 'q', 'level'] },
  delay: { kind: 10, params: ['left', 'right', 'unit'] },
  echo: { kind: 11, params: ['dry', 'wet', 'feedback', 'delay', 'unit', 'mode', 'filter', 'cutoff'] },
  modulator: { kind: 12, params: ['type', 'carrier', 'interpolation'], carrierInput: true },
  operator: { kind: 13, params: ['modulation', 'feedback', 'attack', 'decay', 'sustain', 'release', 'atkCurve', 'decCurve', 'relCurve', 'velocity', 'gain'] },
  imagesampler: { kind: 14, params: [
    'polyphony', 'scanType', 'x', 'y', 'length', 'rotation', 'speed', 'ovalWidth', 'ovalHeight', 'ovalRotation', 'resolution',
    'redLeft', 'greenLeft', 'blueLeft', 'redRight', 'greenRight', 'blueRight',
    'attack', 'decay', 'sustain', 'release', 'atkCurve', 'decCurve', 'relCurve', 'gain',
    'triX1', 'triY1', 'triX2', 'triY2', 'triX3', 'triY3',
  ] },
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

    get dormant() { return name === 'operator' && !!x.ms_dormant(this.ptr); }

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
  sampleKernels(kernels, x, heap);
  const images = imageCache((width, height, rgb) => {
    const bytes = heap.alloc(rgb.length);
    try {
      new Uint8Array(heap.memory.buffer, bytes, rgb.length).set(rgb);
      const ptr = x.ms_image_create(width, height, bytes);
      if (!ptr) throw new Error('DSP: cannot prepare image (maximum size 256 x 256, or memory exhausted)');
      return ptr;
    } finally {
      heap.free(bytes);
    }
  }, (ptr) => x.ms_image_free(ptr));
  kernels.imagesampler = class extends kernels.imagesampler {
    constructor(opts) { super(opts); this.imageEntry = null; }
    message(m) {
      if (m.type !== 'image') return super.message(m);
      const entry = images.acquire(m.width, m.height, m.rgb);
      x.ms_image_set(this.ptr, entry?.value ?? 0);
      images.release(this.imageEntry);
      this.imageEntry = entry;
    }
    destroy() {
      super.destroy();
      images.release(this.imageEntry);
      this.imageEntry = null;
    }
  };
  return { heap, kernels };
}

// Messages clone PCM arrays between Patch instances. Share equal uploads by content, with
// the native allocation as the comparison source (no additional retained JS copy).
function sampleKernels(kernels, x, heap) {
  const banks = new Map();
  const tables = new Map();
  const acquire = (channels) => {
    const size = channels[0].length;
    if (!channels.every(c => c instanceof Float32Array && c.length === size)) throw new Error('DSP: invalid sample channels');
    let hash = 2166136261;
    for (const c of channels) {
      const bits = new Uint32Array(c.buffer, c.byteOffset, c.length);
      for (let i = 0; i < bits.length; i++) hash = Math.imul(hash ^ bits[i], 16777619);
    }
    const key = `${size}:${channels.length}:${hash}`;
    const bucket = banks.get(key) ?? [];
    let entry = bucket.find(e => {
      const bits = new Uint32Array(heap.memory.buffer, x.ms_sample_data(e.ptr), size * channels.length);
      return channels.every((c, ch) => {
        const src = new Uint32Array(c.buffer, c.byteOffset, c.length);
        for (let i = 0; i < size; i++) if (src[i] !== bits[ch * size + i]) return false;
        return true;
      });
    });
    if (!entry) {
      const ptr = x.ms_sample_create(size, channels.length > 1 ? 1 : 0);
      if (!ptr) throw new Error('DSP: cannot allocate sample');
      const data = x.ms_sample_data(ptr);
      channels.forEach((c, i) => heap.f32(data + i * size * 4, size).set(c));
      entry = { ptr, size, key, refs: 0 };
      bucket.push(entry);
      banks.set(key, bucket);
    }
    entry.refs++;
    return entry;
  };
  const release = (entry) => {
    if (!entry || --entry.refs) return;
    const bucket = banks.get(entry.key);
    bucket.splice(bucket.indexOf(entry), 1);
    if (!bucket.length) banks.delete(entry.key);
    x.ms_sample_free(entry.ptr);
  };
  const acquireTable = (bank, frame) => {
    const size = Math.max(1, Math.min(frame, bank.size));
    const key = `${bank.ptr}:${size}`;
    let entry = tables.get(key);
    if (!entry) {
      const ptr = x.ms_table_create(bank.ptr, size);
      if (!ptr) throw new Error('DSP: cannot allocate wavetable mipmaps');
      entry = { key, ptr, refs: 0 };
      tables.set(key, entry);
    }
    entry.refs++;
    return entry;
  };
  const releaseTable = (entry) => {
    if (!entry || --entry.refs) return;
    tables.delete(entry.key);
    x.ms_table_free(entry.ptr);
  };
  kernels.sampler = class extends kernels.sampler {
    constructor(opts) { super(opts); this.sampleEntry = null; }
    message(m) {
      if (m.type !== 'sample') return super.message(m);
      const channels = m.channels?.filter(c => c?.length).slice(0, 2);
      const next = channels?.length && m.rate > 0 ? acquire(channels) : null;
      x.ms_sample_set(this.ptr, next?.ptr ?? 0, m.rate);
      release(this.sampleEntry);
      this.sampleEntry = next;
    }
    destroy() {
      super.destroy();
      release(this.sampleEntry);
      this.sampleEntry = null;
    }
  };
  kernels.wavetable = class extends kernels.wavetable {
    constructor(opts) {
      super(opts);
      this.sampleEntry = null;
      this.tableEntry = null;
      this.block = 0;
      this.frame = DEFAULT_FRAME;
      try { this.message({ type: 'table', data: null }); }
      catch (error) { this.destroy(); throw error; }
    }
    param(id, value) {
      if (id !== 'block') return super.param(id, value);
      const block = Math.max(0, Math.min(BLOCK_SIZES.length - 1, value | 0));
      const table = acquireTable(this.sampleEntry, BLOCK_SIZES[block] || this.frame);
      x.ms_table_set(this.ptr, table.ptr);
      releaseTable(this.tableEntry);
      this.tableEntry = table;
      this.block = block;
    }
    message(m) {
      if (m.type !== 'table') return super.message(m);
      const data = m.data?.length ? m.data : builtinTable().data;
      const frame = m.data?.length && m.frame > 0 ? m.frame | 0 : DEFAULT_FRAME;
      const bank = acquire([data]);
      let table;
      try { table = acquireTable(bank, BLOCK_SIZES[this.block] || frame); }
      catch (error) { release(bank); throw error; }
      x.ms_table_set(this.ptr, table.ptr);
      releaseTable(this.tableEntry);
      release(this.sampleEntry);
      this.sampleEntry = bank;
      this.tableEntry = table;
      this.frame = frame;
    }
    destroy() {
      super.destroy();
      releaseTable(this.tableEntry);
      release(this.sampleEntry);
      this.tableEntry = this.sampleEntry = null;
    }
  };
}
