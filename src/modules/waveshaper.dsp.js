// WAVESHAPER kernel: input × drive -> curve table (optionally oversampled) -> DC blocker -> wet,
// mixed with the dry input, × output level. The curve (module state) arrives as
// { type: 'curve', curve } and is turned into a table for the current Range here.
import { Kernel } from '../dsp/kernel.js';
import { curveTable, defaultCurve } from '../curve.js';

const SMOOTH_S = 0.01;
const DC_HZ = 8;

export default class WaveshaperKernel extends Kernel {
  static passive = true;

  constructor() {
    super();
    this.curve = defaultCurve();
    this.symmetric = true;
    this.table = curveTable(this.curve, true);
    this.os = 1; // oversampling factor 1, 2 or 4
    this.t = { drive: 1, wet: 1, dry: 0, level: 1 }; // targets
    this.s = { ...this.t }; // smoothed
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * sampleRate));
    this.dcR = Math.exp((-2 * Math.PI * DC_HZ) / sampleRate);
    this.ch = [0, 1].map(() => ({ prev: 0, x1: 0, y1: 0 })); // per channel: last input, DC blocker state
  }

  param(id, v) {
    if (id === 'drive') this.t.drive = Math.pow(10, v / 20);
    else if (id === 'range') {
      const sym = v < 0.5;
      if (sym !== this.symmetric) { this.symmetric = sym; this.table = curveTable(this.curve, sym); }
    } else if (id === 'oversample') this.os = [1, 2, 4][v | 0] ?? 1;
    else if (id === 'mix') { this.t.wet = v / 100; this.t.dry = 1 - v / 100; }
    else if (id === 'level') this.t.level = v;
  }

  message(m) {
    if (m.type === 'param') this.param(m.id, m.value);
    else if (m.type === 'curve') { this.curve = m.curve; this.table = curveTable(m.curve, this.symmetric); }
  }

  // the curve at x (-1..1 maps onto the table, beyond is clamped like a WaveShaperNode)
  shape(x) {
    const t = this.table;
    const last = t.length - 1;
    const f = (x + 1) * 0.5 * last;
    if (f <= 0) return t[0];
    if (f >= last) return t[last];
    const i = f | 0;
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const o = outputs[0];
    if (!inp || !inp.length) return false;
    const n = o[0].length;
    const { t, s, k, os, dcR } = this;
    const s0 = { ...s };
    // smoothed values ramp linearly through the block (one-pole per block of n samples)
    const kb = 1 - Math.pow(1 - k, n);
    for (const key in t) s[key] = Math.abs(t[key] - s[key]) < 1e-6 ? t[key] : s[key] + (t[key] - s[key]) * kb;
    for (let c = 0; c < 2; c++) {
      const src = inp[c] ?? inp[0];
      const dst = o[c];
      const st = this.ch[c];
      let { prev, x1, y1 } = st;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const drive = s0.drive + (s.drive - s0.drive) * u;
        const x = src[i];
        let w;
        if (os === 1) w = this.shape(x * drive);
        else {
          // linear-interpolated upsampling, averaged back down
          w = 0;
          for (let j = 1; j <= os; j++) w += this.shape((prev + (x - prev) * (j / os)) * drive);
          w /= os;
        }
        prev = x;
        const y = w - x1 + dcR * y1; // DC blocker (one-pole high-pass)
        x1 = w;
        y1 = y;
        const wet = s0.wet + (s.wet - s0.wet) * u;
        const dry = s0.dry + (s.dry - s0.dry) * u;
        const level = s0.level + (s.level - s0.level) * u;
        dst[i] = (y * wet + x * dry) * level;
      }
      st.prev = prev; st.x1 = x1; st.y1 = Math.abs(y1) < 1e-20 ? 0 : y1;
    }
    return true;
  }
}
