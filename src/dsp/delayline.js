import { MAX_DELAY_SECONDS } from '../modules/delaytime.js';

export class DelayLine {
  constructor() {
    this.length = Math.ceil(sampleRate * MAX_DELAY_SECONDS) + 2;
    this.buffers = [new Float32Array(this.length), new Float32Array(this.length)];
    this.pos = 0;
  }

  read(channel, delay) {
    let at = this.pos - delay;
    if (at < 0) at += this.length;
    const i = Math.floor(at);
    const f = at - i;
    const b = this.buffers[channel];
    return b[i] + (b[(i + 1) % this.length] - b[i]) * f;
  }

  clear() {
    for (const b of this.buffers) b.fill(0);
    this.pos = 0;
  }

  advance() {
    if (++this.pos === this.length) this.pos = 0;
  }
}
