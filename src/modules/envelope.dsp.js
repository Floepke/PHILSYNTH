// ENVELOPE kernel (see src/dsp/kernel.js), control rate: steps once per render quantum on the
// audio clock. Every note (noteOn) plays the drawn curve (module state, { type: 'curve', curve })
// once from its start, stretched over Envelope Length; afterwards it holds the curve's end value.
// Its value (0..1) is mapped by the engine graph onto the controllers its cables point to. Until
// the first note (and after a panic) the value is null: the controller is left alone.
// `meter` reports the playhead (0..1 through the curve, -1 when not playing) for the panel's dot.
import { Kernel } from '../dsp/kernel.js';
import { curveSamples, defaultEnvelope } from '../curve.js';

export default class EnvelopeKernel extends Kernel {
  static modulator = true;
  static meter = true;

  constructor() {
    super();
    this.table = curveSamples(defaultEnvelope());
    this.length = 1; // s
    this.pos = 0; // 0..1 through the curve
    this.running = false;
    this.value = null;
    this.meter = -1;
  }

  param(id, v) {
    if (id === 'length') this.length = Math.max(0, v) / 1000;
  }

  message(m) {
    switch (m.type) {
      case 'param': this.param(m.id, m.value); break;
      case 'curve': this.table = curveSamples(m.curve); break;
      case 'noteOn': case 'gate': this.pos = 0; this.running = true; break;
      case 'reset': this.panic(); break;
    }
  }

  panic() {
    this.running = false;
    this.value = null;
    this.meter = -1;
  }

  // the curve at position u (0..1)
  at(u) {
    const t = this.table;
    const f = Math.min(1, Math.max(0, u)) * (t.length - 1);
    const i = Math.min(f | 0, t.length - 2);
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  }

  process(_inputs, outputs) {
    if (!this.running) return false;
    const n = outputs[0]?.[0]?.length ?? 128;
    if (this.length <= 0) this.pos = 1;
    this.value = this.at(this.pos);
    if (this.pos >= 1) this.running = false; // holds the end value
    else this.pos = Math.min(1, this.pos + n / (sampleRate * this.length));
    this.meter = this.running ? this.pos : -1;
    return false;
  }
}
