// Offline song render (EXPORT WAV): a private copy of the project (its own modules and DSP graph,
// see src/dsp/graph.js) plays the song once through the same Transport as live playback, on a
// virtual clock, faster than real time. The live engine is not touched.
// The song runs from its start to its end (the loop region when one is set), then the tail
// (releases, echoes, reverb) renders until it is silent or TAIL_MAX_S has passed.
import { Graph } from './dsp/graph.js';
import { DspHost } from './dsp/host.js';
import { instantiateDsp, wasmKernels } from './dsp/wasm.js';
import { PatchRuntime } from './patch.js';
import { Transport } from './transport.js';
import { normalizeSong } from './song.js';

const BLOCK = 128;
export const TAIL_MAX_S = 10;
const SILENCE = 1e-4; // -80 dBFS
const SILENT_TAIL_S = 0.25; // the tail ends after this much silence
const YIELD_MS = 30; // give the UI a turn this often

// A new task without setTimeout: timers are throttled hard in background windows, messages are not.
function nextTask() {
  if (typeof MessageChannel !== 'function') return new Promise((res) => setTimeout(res, 0));
  return new Promise((res) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => { port1.close(); res(); };
    port2.postMessage(0);
  });
}

// project: Engine.saveProject() data. Returns { left, right, length, sampleRate, peak, seconds }.
// onProgress(fraction 0..1); signal: AbortSignal; wasm: modsynth.wasm bytes (null = JS kernels).
export async function renderSong(project, { sampleRate = 48000, wasm = null, onProgress = null, signal = null } = {}) {
  const hadRate = 'sampleRate' in globalThis;
  const prevRate = globalThis.sampleRate;
  globalThis.sampleRate = sampleRate; // DSP kernels read the AudioWorkletGlobalScope global
  let root = null;
  try {
    let graph = null;
    if (wasm) {
      try { graph = new Graph(wasmKernels(instantiateDsp(wasm), sampleRate)); } catch (err) { console.warn('WAV export: C++ DSP unavailable, using the JavaScript kernels:', err); }
    }
    graph ??= new Graph();
    let time = 0;
    const dsp = new DspHost({ onmessage: null, postMessage: (batch) => graph.handle(batch) }, { sync: true });
    const engine = {
      ctx: { get currentTime() { return time; }, sampleRate },
      dsp,
      createPatch(sink) { return PatchRuntime.create(this, sink); },
    };
    root = await PatchRuntime.create(engine, dsp.destination);
    await root.load(project.patch);
    const song = normalizeSong(structuredClone(project.song));
    const transport = new Transport({
      getSong: () => song,
      getBpm: () => root.bpm,
      getTarget: (id) => {
        const e = id === null || id === undefined ? null : root.modules.get(id);
        return e?.def.acceptsMidi ? e.inst : null;
      },
      setAuto: (id, clip, value) => root.automate(id, clip?.target ?? null, clip?.controller ?? 0, value),
      now: () => time * 1000,
      ticker: () => ({ start() {}, stop() {} }),
    });
    const [start, end] = transport.songBounds(song);
    if (!(end > start)) throw new Error('The song is empty: add clips with notes to the TimeLine first.');

    const dt = BLOCK / sampleRate;
    let cap = Math.ceil((((end - start) * 60) / root.bpm + TAIL_MAX_S) * sampleRate) + BLOCK;
    let left = new Float32Array(cap);
    let right = new Float32Array(cap);
    const L = new Float32Array(BLOCK);
    const R = new Float32Array(BLOCK);
    let length = 0;
    let peak = 0;
    let playing = transport.start(start);
    let tail = 0;
    let quiet = 0;
    let lastYield = performance.now();
    for (;;) {
      if (playing) {
        if (transport.pos + (dt * root.bpm) / 60 >= end) {
          transport.advance(transport.from, end); // note-offs and note-ons up to the exact end
          transport.stop();
          playing = false;
        } else transport.tick(time * 1000);
      }
      graph.render(L, R);
      time += dt;
      const r = graph.report(time);
      if (r) dsp.receive(r);
      if (length + BLOCK > cap) { // tempo automation can make the song longer than estimated
        cap *= 2;
        const l2 = new Float32Array(cap); l2.set(left.subarray(0, length)); left = l2;
        const r2 = new Float32Array(cap); r2.set(right.subarray(0, length)); right = r2;
      }
      left.set(L, length);
      right.set(R, length);
      length += BLOCK;
      let blockPeak = 0;
      for (let i = 0; i < BLOCK; i++) blockPeak = Math.max(blockPeak, Math.abs(L[i]), Math.abs(R[i]));
      if (!Number.isFinite(blockPeak)) throw new Error('The DSP produced invalid samples (NaN / Infinity).');
      peak = Math.max(peak, blockPeak);
      if (!playing) {
        tail += BLOCK;
        quiet = blockPeak < SILENCE ? quiet + BLOCK : 0;
        if (quiet >= SILENT_TAIL_S * sampleRate || tail >= TAIL_MAX_S * sampleRate) break;
      }
      if (performance.now() - lastYield > YIELD_MS) {
        onProgress?.(playing ? Math.min(0.99, (transport.pos - start) / (end - start)) : 0.99);
        await nextTask();
        lastYield = performance.now();
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      }
    }
    // drop the trailing silence (keep a short fade-out margin of SILENT_TAIL_S)
    length = Math.max(BLOCK, length - Math.max(0, quiet - Math.round(SILENT_TAIL_S * sampleRate * 0.2)));
    onProgress?.(1);
    return { left: left.subarray(0, length), right: right.subarray(0, length), length, sampleRate, peak, seconds: length / sampleRate };
  } finally {
    try { root?.destroy(); } catch { /* the render result is what matters */ }
    if (hadRate) globalThis.sampleRate = prevRate;
    else delete globalThis.sampleRate;
  }
}

// 24-bit PCM stereo WAV file (samples clipped to -1..1).
export function encodeWav(left, right, sampleRate) {
  const n = left.length;
  const bytes = 3;
  const channels = 2;
  const data = n * channels * bytes;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytes, true);
  v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bytes * 8, true);
  text(36, 'data');
  v.setUint32(40, data, true);
  const out = new Uint8Array(buf);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of [left, right]) {
      const s = Math.max(-1, Math.min(1, ch[i] || 0));
      const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff) & 0xffffff;
      out[p++] = x & 0xff;
      out[p++] = (x >> 8) & 0xff;
      out[p++] = (x >> 16) & 0xff;
    }
  }
  return buf;
}
