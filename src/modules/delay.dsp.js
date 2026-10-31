// Pure stereo delay (no dry mix or feedback). MODMIDI scheduling lives in delay.js.
import { Kernel } from '../dsp/kernel.js';
import { DelayLine } from '../dsp/delayline.js';
import { delaySeconds } from './delaytime.js';

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
    this.updateDelay();
  }

  updateDelay() {
    this.target[0] = delaySeconds(this.p.left, this.p.unit, this.bpm) * sampleRate;
    this.target[1] = delaySeconds(this.p.right, this.p.unit, this.bpm) * sampleRate;
    if (!this.started) this.delay = [...this.target];
  }

  param(id, value) {
    if (!(id in this.p)) return;
    this.p[id] = id === 'unit' ? Math.max(0, Math.min(3, value | 0)) : value;
    this.updateDelay();
  }

  message(m) {
    if (m.type === 'bpm') { this.bpm = m.value; this.updateDelay(); }
    else super.message(m);
  }

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
