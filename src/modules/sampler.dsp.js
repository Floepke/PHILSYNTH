// SAMPLER DSP kernel (audio thread): one sample spread over the whole MIDI range. A note plays the
// sample once from its start (one-shot) at a speed relative to the root key C4 (MIDI 60):
//   speed = sample rate / engine rate * 2^((pitch - 60 + transpose + finetune / 100) / 12)
// shaped by the ADSR; the voice ends at the end of the release or of the sample. Stereo samples
// play in stereo. The sample arrives from the main thread: { type: 'sample', rate, channels }.
import { PolyKernel, envTick } from './poly.dsp.js';
import { readClamped } from './interp.js';

export const ROOT_KEY = 60;

export default class SamplerKernel extends PolyKernel {
  constructor() {
    super({ transpose: 0, finetune: 0, interpolation: 2 });
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
    v.pos = 0;
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
    let active = 0;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      let vel = v.vel;
      const velStep = this.glide(v, e.k, n);
      const stepStep = (this.speedOf(v.pitch) - v.step) / n; // follows pitch glides and transpose changes
      for (let i = 0; i < n; i++) {
        const lvl = envTick(v, e);
        if (!v.stage || v.pos >= len) { v.stage = 0; break; }
        vel += velStep;
        const g = lvl * vel;
        const l = readClamped(cL, len, v.pos, mode);
        L[i] += l * g;
        if (R) R[i] += (cR ? readClamped(cR, len, v.pos, mode) : l) * g;
        v.step += stepStep;
        v.pos += v.step;
      }
    }
    const g = this.p.gain;
    for (let i = 0; i < n; i++) L[i] *= g;
    if (R) for (let i = 0; i < n; i++) R[i] *= g;
    for (let c = R ? 2 : 1; c < out.length; c++) out[c].set(L);
    return active > 0;
  }
}
