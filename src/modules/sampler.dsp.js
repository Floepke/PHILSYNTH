// SAMPLER DSP kernel (audio thread): one sample spread over the whole MIDI range. A note plays the
// playback region (Selection Start / Selection Length, % of the sample) at a speed relative to the
// root key C4 (MIDI 60):
//   speed = sample rate / engine rate * 2^((pitch - 60 + transpose + finetune / 100) / 12)
// shaped by the ADSR. Playhead Mode: Forward plays the region once from its start, Reverse once
// from its end backwards, Ping Pong bounces between both ends for as long as the note sounds,
// Forward Loop / Reverse Loop repeat the region forwards / backwards while the note sounds.
// The region is read every block, so modulating it moves the window under playing voices.
// Stereo samples play in stereo. The sample arrives from the main thread: { type: 'sample', rate, channels }.
import { PolyKernel, envTick } from './poly.dsp.js';
import { readClamped } from './interp.js';

export const ROOT_KEY = 60;
// (append new modes at the end: saved projects store the index)
export const PLAY_MODES = ['Forward', 'Reverse', 'Ping Pong', 'Forward Loop', 'Reverse Loop'];
const PING_PONG = 2;
const FORWARD_LOOP = 3;
const REVERSE_LOOP = 4;
const reverse = (mode) => mode === 1 || mode === REVERSE_LOOP;

// Playback window [a, b) in samples of a sample `len` long (at least one sample wide)
export function region(len, startPct, lengthPct) {
  const s = Math.max(0, Math.min(1, startPct / 100));
  const a = Math.min(len - 1, s * len);
  const b = Math.max(a + 1, Math.min(len, (s + Math.max(0, lengthPct) / 100) * len));
  return { a, b };
}

export default class SamplerKernel extends PolyKernel {
  constructor() {
    super({ transpose: 0, finetune: 0, interpolation: 2, selStart: 0, selLength: 100, playMode: 0 });
    this.data = null; // { rate, channels: [Float32Array, Float32Array?], length }
  }

  message(m) {
    if (m.type !== 'sample') return super.message(m);
    const ch = m.channels?.filter((c) => c?.length);
    this.data = ch?.length && m.rate > 0 ? { rate: m.rate, channels: ch, length: ch[0].length } : null;
    for (const v of this.voices) v.stage = 0; // the old sample's voices would read the new one
  }

  speedOf(pitch) {
    const d = this.data;
    const p = this.p;
    return (d.rate / sampleRate) * Math.pow(2, (pitch - ROOT_KEY + p.transpose + p.finetune / 100) / 12);
  }

  start(v) {
    if (!this.data) { v.stage = 0; return; }
    const { a, b } = region(this.data.length, this.p.selStart, this.p.selLength);
    v.dir = reverse(this.p.playMode | 0) ? -1 : 1;
    v.pos = v.dir < 0 ? b - 1 : a;
    v.step = this.speedOf(v.pitch);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const d = this.data;
    if (!d) return false;
    const n = out[0].length;
    const L = out[0];
    const R = out[1] && out[1] !== L ? out[1] : null;
    L.fill(0);
    R?.fill(0);
    const e = this.blockEnv(n);
    const mode = Math.max(0, Math.min(2, this.p.interpolation | 0));
    const cL = d.channels[0];
    const cR = d.channels[1] ?? null;
    const len = d.length;
    const { a, b } = region(len, this.p.selStart, this.p.selLength);
    const playMode = this.p.playMode | 0;
    const pingPong = playMode === PING_PONG;
    const loop = playMode === FORWARD_LOOP || playMode === REVERSE_LOOP;
    const span = b - a; // loop length
    const top = b - 1; // last sample of the window (Ping Pong turns around there)
    let active = 0;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      let vel = v.vel;
      const velStep = this.glide(v, e.k, n);
      const stepStep = (this.speedOf(v.pitch) - v.step) / n; // follows pitch glides and transpose changes
      if (loop) v.dir = playMode === REVERSE_LOOP ? -1 : 1; // also when the mode changes mid-note
      if (pingPong) {
        if (!v.dir) v.dir = 1;
        if (v.pos < a || v.pos > top) v.pos = Math.max(a, Math.min(top, v.pos)); // the window moved away
      } else if (v.dir < 0) { if (v.pos > top) v.pos = top; } else if (v.pos < a) v.pos = a;
      for (let i = 0; i < n; i++) {
        const lvl = envTick(v, e);
        if (!v.stage) break;
        if (pingPong) {
          if (top - a < 1) v.pos = a;
          else if (v.pos > top || v.pos < a) {
            // bounce the overshoot back into the window (folded, so huge steps cannot escape)
            const w = top - a;
            const over = v.pos > top;
            const d = (over ? v.pos - top : a - v.pos) % (2 * w);
            const back = d <= w; // one bounce: heads away from the edge it crossed
            v.dir = over === back ? -1 : 1;
            v.pos = over ? (back ? top - d : a + (d - w)) : (back ? a + d : top - (d - w));
          }
        } else if (loop) {
          // wrap around seamlessly (modulo, so huge steps and a moved window stay inside)
          if (v.pos >= b || v.pos < a) v.pos = a + ((((v.pos - a) % span) + span) % span);
        } else if (v.dir < 0 ? v.pos < a : v.pos >= b) { v.stage = 0; break; }
        vel += velStep;
        const g = lvl * vel;
        const l = readClamped(cL, len, v.pos, mode);
        L[i] += l * g;
        if (R) R[i] += (cR ? readClamped(cR, len, v.pos, mode) : l) * g;
        v.step += stepStep;
        v.pos += v.step * v.dir;
      }
    }
    const g = this.p.gain;
    for (let i = 0; i < n; i++) L[i] *= g;
    if (R) for (let i = 0; i < n; i++) R[i] *= g;
    for (let c = R ? 2 : 1; c < out.length; c++) out[c].set(L);
    return active > 0;
  }
}
