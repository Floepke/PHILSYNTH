// ENVELOPE kernel (see src/dsp/kernel.js), control rate: steps once per render quantum on the
// audio clock. Every note (noteOn) plays the drawn curve (module state, { type: 'curve', curve })
// once from its start, stretched over Envelope Length; afterwards it holds the curve's end value.
// Its value (0..1) is mapped by the engine graph onto the controllers its cables point to. Until
// the first note (and after a panic) it holds its idle value, so output trimming is live: in Note
// ON Trigger mode the curve's end (what a finished note leaves, so the first note after loading
// behaves exactly like every later one), in the loop modes the curve's start.
// A note starts the curve at its MODMIDI phase (0..1, e.g. a MULTIMIDI's Phase): 0 = the start,
// 0.5 = halfway through (forward in ping-pong mode).
// Mode (Graph param 'mode'):
//   0 Note ON Trigger: every note restarts the curve; it plays once and holds the end value.
//   1 Notes ON/OFF Loop: the first note (no other note held) starts the curve, which repeats
//     from its start while any note is held; releasing the last note stops it right there (the
//     value holds). The next note starts over from the beginning.
//   2 Notes ON/OFF Loop Forward/Backwards: like 1, but the playhead runs forward, then back
//     (ping-pong) instead of jumping to the start.
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
    this.dir = 1; // ping-pong direction
    this.mode = 0;
    this.held = new Set(); // ids of the notes held (loop modes)
    this.running = false;
    this.triggered = false;
    this.value = this.idle();
    this.meter = -1;
  }

  // the value before the first note (see the top)
  idle() { return this.at(this.mode === 0 ? 1 : 0); }

  param(id, v) {
    if (id === 'length') this.length = Math.max(0, v) / 1000;
    else if (id === 'mode') {
      this.mode = Math.min(2, Math.max(0, Math.round(v)));
      if (this.mode !== 0 && this.running && !this.held.size) this.running = false;
      if (!this.triggered) this.value = this.idle();
    }
  }

  // phase: the note's MODMIDI phase (0..1) = where on the curve it starts
  start(phase = 0) {
    const p = Number.isFinite(phase) ? phase : 0;
    this.pos = p - Math.floor(p);
    this.dir = 1;
    this.running = true;
    this.triggered = true;
  }

  message(m) {
    switch (m.type) {
      case 'param': this.param(m.id, m.value); break;
      case 'curve':
        this.table = curveSamples(m.curve);
        if (!this.triggered) this.value = this.idle();
        break;
      case 'noteOn': {
        const first = this.held.size === 0;
        this.held.add(m.id);
        if (this.mode === 0 || first) this.start(m.phase);
        break;
      }
      case 'noteOff':
        if (this.held.delete(m.id) && !this.held.size && this.mode !== 0) this.stop();
        break;
      case 'allOff':
        this.held.clear();
        if (this.mode !== 0) this.stop();
        break;
      case 'gate': this.start(); break;
      case 'reset': this.panic(); break;
    }
  }

  // loop modes: the last note was released, the value holds where the playhead is
  stop() {
    this.running = false;
    this.meter = -1;
  }

  panic() {
    this.held.clear();
    this.running = false;
    this.triggered = false;
    this.pos = 0;
    this.dir = 1;
    this.value = this.idle();
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
    if (this.mode === 0) {
      if (this.length <= 0) this.pos = 1;
      this.value = this.at(this.pos);
      if (this.pos >= 1) this.running = false; // holds the end value
      else this.pos = Math.min(1, this.pos + n / (sampleRate * this.length));
    } else {
      // loops while notes are held; Envelope Length 0 holds the curve's end (nothing to loop)
      if (this.length <= 0) { this.pos = 1; this.dir = 1; }
      this.value = this.at(this.pos);
      if (this.length > 0) {
        let p = this.pos + this.dir * n / (sampleRate * this.length);
        if (this.mode === 1) p -= Math.floor(p); // wrap to the start
        else {
          // bounce at both ends (a very short length may bounce more than once per block)
          for (let k = 0; k < 64 && (p > 1 || p < 0); k++) {
            if (p > 1) { p = 2 - p; this.dir = -1; } else { p = -p; this.dir = 1; }
          }
          p = Math.min(1, Math.max(0, p));
        }
        this.pos = p;
      }
    }
    this.meter = this.running ? this.pos : -1;
    return false;
  }
}
