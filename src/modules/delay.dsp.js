// Pure stereo delay (no dry mix or feedback). MODMIDI scheduling lives in delay.js.
// Note unit: both channels delay one period of the newest note (notePeriodSamples); a new note
// jumps there at once (a pluck must not start with a pitch glide), its pitch bends glide.
import { Kernel } from '../dsp/kernel.js';
import { DelayLine } from '../dsp/delayline.js';
import { NOTE_UNIT, delaySeconds, notePeriodSamples } from './delaytime.js';

export default class DelayKernel extends Kernel {
  constructor() {
    super();
    this.p = { left: 250, right: 250, unit: 0 };
    this.bpm = 120;
    this.line = new DelayLine();
    this.delay = [0, 0];
    this.target = [0, 0];
    this.smooth = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.started = false;
    this.pitch = 60; // newest note (Note unit)
    this.noteId = null;
    this.updateDelay();
  }

  updateDelay(jump = false) {
    if (this.p.unit === NOTE_UNIT) this.target[0] = this.target[1] = notePeriodSamples(this.pitch, sampleRate);
    else {
      this.target[0] = delaySeconds(this.p.left, this.p.unit, this.bpm) * sampleRate;
      this.target[1] = delaySeconds(this.p.right, this.p.unit, this.bpm) * sampleRate;
    }
    const most = this.line.ensure(Math.max(this.target[0], this.target[1]));
    for (let ch = 0; ch < 2; ch++) this.target[ch] = Math.min(most, this.target[ch]);
    if (!this.started || jump) this.delay = [...this.target];
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

  panic() { this.line.clear(); }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const line = this.line;
    this.started = true;
    let live = false;
    for (let i = 0; i < out[0].length; i++) {
      for (let ch = 0; ch < 2; ch++) {
        this.delay[ch] += (this.target[ch] - this.delay[ch]) * this.smooth;
        line.buffers[ch][line.pos] = input?.[ch]?.[i] ?? input?.[0]?.[i] ?? 0;
        const y = line.read(ch, this.delay[ch]);
        if (out[ch]) out[ch][i] = y;
        if (y !== 0) live = true;
      }
      line.advance();
    }
    return live;
  }
}
