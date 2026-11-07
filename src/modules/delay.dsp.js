// Pure stereo delay (no dry mix or feedback). MODMIDI scheduling lives in delay.js.
// Note unit: both channels delay one period of the newest note (notePeriodSamples); a new note
// jumps there at once (a pluck must not start with a pitch glide), its pitch bends glide.
// The Note unit reads the fraction of a sample with a first-order all-pass (Thiran) instead of
// linear interpolation: linear interpolation is a low-pass whose strength depends on the
// fraction (none at a whole number of samples, strong at a half), so in a FEEDBACK loop notes
// whose period happens to be a whole number of samples rang far brighter than their neighbours.
// The all-pass passes every frequency at the same level, tuned alike (C++ twin: cpp/delay.h).
// Controller `loop` (sent by the graph, not shown): what the rest of a sound loop delays the tone,
// subtracted from the period (see notePeriodSamples). It is updated in the block a note starts,
// so the note still jumps straight to its corrected length.
import { Kernel } from '../dsp/kernel.js';
import { DelayLine } from '../dsp/delayline.js';
import { NOTE_UNIT, delaySeconds, notePeriodSamples } from './delaytime.js';

export default class DelayKernel extends Kernel {
  constructor() {
    super();
    this.p = { left: 250, right: 250, unit: 0, loop: 1 };
    this.bpm = 120;
    this.line = new DelayLine();
    this.delay = [0, 0];
    this.target = [0, 0];
    this.smooth = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.started = false;
    this.fresh = false; // a note started since the last block: delay changes jump
    this.pitch = 60; // newest note (Note unit)
    this.noteId = null;
    this.ap = [0, 0]; // Note unit: last all-pass output per channel
    this.updateDelay();
  }

  updateDelay(jump = false) {
    if (this.p.unit === NOTE_UNIT) this.target[0] = this.target[1] = notePeriodSamples(this.pitch, sampleRate, this.p.loop);
    else {
      this.target[0] = delaySeconds(this.p.left, this.p.unit, this.bpm) * sampleRate;
      this.target[1] = delaySeconds(this.p.right, this.p.unit, this.bpm) * sampleRate;
    }
    const most = this.line.ensure(Math.max(this.target[0], this.target[1]));
    for (let ch = 0; ch < 2; ch++) this.target[ch] = Math.min(most, this.target[ch]);
    if (!this.started || jump || this.fresh) this.delay = [...this.target];
  }

  param(id, value) {
    if (!(id in this.p)) return;
    this.p[id] = id === 'unit' ? Math.max(0, Math.min(NOTE_UNIT, value | 0)) : value;
    this.updateDelay();
  }

  message(m) {
    switch (m.type) {
      case 'bpm': this.bpm = m.value; this.updateDelay(); break;
      case 'noteOn':
        this.noteId = m.id;
        this.pitch = +m.pitch || 0;
        this.fresh = true;
        if (this.p.unit === NOTE_UNIT) this.updateDelay(true);
        break;
      case 'noteMod':
        for (const [id, pitch] of m.notes) {
          if (id !== this.noteId) continue;
          this.pitch = +pitch || 0;
          if (this.p.unit === NOTE_UNIT) this.updateDelay();
        }
        break;
      default: super.message(m);
    }
  }

  panic() {
    this.line.clear();
    this.ap = [0, 0];
  }

  // y = c·x[k] + x[k+1] − c·y[-1] with k whole and frac = d − k in [0.5, 1.5): delay d samples
  // (exactly at low frequencies), level 1 at every frequency
  allpass(ch, d) {
    const line = this.line;
    const k = Math.max(0, Math.floor(d - 0.5));
    const frac = d - k;
    const c = (1 - frac) / (1 + frac);
    const y = c * line.tap(ch, k) + line.tap(ch, k + 1) - c * this.ap[ch];
    this.ap[ch] = Math.abs(y) < 1e-30 ? 0 : y;
    return this.ap[ch];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const line = this.line;
    const note = this.p.unit === NOTE_UNIT;
    this.started = true;
    this.fresh = false;
    let live = false;
    for (let i = 0; i < out[0].length; i++) {
      for (let ch = 0; ch < 2; ch++) {
        this.delay[ch] += (this.target[ch] - this.delay[ch]) * this.smooth;
        line.buffers[ch][line.pos] = input?.[ch]?.[i] ?? input?.[0]?.[i] ?? 0;
        const y = note ? this.allpass(ch, this.delay[ch]) : line.read(ch, this.delay[ch]);
        if (out[ch]) out[ch][i] = y;
        if (y !== 0) live = true;
      }
      line.advance();
    }
    return live;
  }
}
