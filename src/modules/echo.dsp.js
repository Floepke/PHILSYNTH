// Filtered feedback delay. Stereo preserves L/R; pingpong injects the mono sum on the left
// and crosses feedback on every repeat. The first repeat is filtered too; dry stays untouched.
import { Kernel } from '../dsp/kernel.js';
import { DelayLine } from '../dsp/delayline.js';
import { newSvf, tickSvf } from '../dsp/svf.js';
import { delaySeconds } from './delaytime.js';

export default class EchoKernel extends Kernel {
  constructor() {
    super();
    this.p = { dry: 1, wet: 0.5, feedback: 0.5, delay: 250, unit: 0, mode: 0, filter: 0, cutoff: 4000 };
    this.bpm = 120;
    this.line = new DelayLine();
    this.svf = Array.from({ length: 2 }, () => Array.from({ length: 4 }, newSvf));
    this.smooth = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.logF = Math.log2(4000);
    this.cachedLogF = NaN;
    this.a1 = this.a2 = this.a3 = 0;
    this.started = false;
    this.updateDelay();
  }

  updateDelay() {
    // Feedback needs at least one sample of history, even at 0 ms.
    this.target = Math.max(1, delaySeconds(this.p.delay, this.p.unit, this.bpm) * sampleRate);
    if (!this.started) this.delay = this.target;
  }

  param(id, value) {
    if (!(id in this.p)) return;
    if (id === 'filter') {
      value = Math.max(0, Math.min(8, value | 0));
      if (value !== this.p.filter) for (const ch of this.svf) for (const st of ch) st.ic1 = st.ic2 = 0;
    } else if (id === 'unit') value = Math.max(0, Math.min(3, value | 0));
    else if (id === 'feedback') value = Math.max(0, Math.min(0.99, value));
    this.p[id] = value;
    if (id === 'delay' || id === 'unit') this.updateDelay();
    if (!this.started && id === 'cutoff') this.logF = this.cutoffLog();
  }

  cutoffLog() {
    return Math.log2(Math.max(20, Math.min(20000, sampleRate * 0.45, this.p.cutoff)));
  }

  message(m) {
    if (m.type === 'bpm') { this.bpm = m.value; this.updateDelay(); }
    else super.message(m);
  }

  filtered(ch, x, stages, high) {
    for (let s = 0; s < stages; s++) {
      const st = this.svf[ch][s];
      tickSvf(st, x, this.a1, this.a2, this.a3);
      x = high ? x - Math.SQRT2 * st.band - st.low : st.low;
      if (Math.abs(st.ic1) < 1e-20) st.ic1 = 0;
      if (Math.abs(st.ic2) < 1e-20) st.ic2 = 0;
    }
    return Math.abs(x) < 1e-20 ? 0 : x;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const p = this.p;
    const line = this.line;
    const stages = p.filter ? (p.filter - 1) % 4 + 1 : 0;
    const high = p.filter > 4;
    const targetLogF = this.cutoffLog();
    this.started = true;
    let live = false;
    for (let i = 0; i < out[0].length; i++) {
      this.delay += (this.target - this.delay) * this.smooth;
      this.logF += (targetLogF - this.logF) * this.smooth;
      if (stages && this.logF !== this.cachedLogF) {
        this.cachedLogF = this.logF;
        const g = Math.tan(Math.PI * Math.exp(this.logF * Math.LN2) / sampleRate);
        this.a1 = 1 / (1 + g * (g + Math.SQRT2));
        this.a2 = g * this.a1;
        this.a3 = g * this.a2;
      }
      const l = input?.[0]?.[i] ?? 0;
      const r = input?.[1]?.[i] ?? l;
      const dl = this.filtered(0, line.read(0, this.delay), stages, high);
      const dr = this.filtered(1, line.read(1, this.delay), stages, high);
      line.buffers[0][line.pos] = (p.mode ? (l + r) * 0.5 : l) + p.feedback * (p.mode ? dr : dl);
      line.buffers[1][line.pos] = (p.mode ? 0 : r) + p.feedback * (p.mode ? dl : dr);
      out[0][i] = p.dry * l + p.wet * dl;
      if (out[1]) out[1][i] = p.dry * r + p.wet * dr;
      if (out[0][i] !== 0 || (out[1] && out[1][i] !== 0)) live = true;
      line.advance();
    }
    return live;
  }
}
