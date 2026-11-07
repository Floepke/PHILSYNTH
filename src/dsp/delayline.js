// Ring buffer of the DELAY / ECHO kernels. It starts with room for INITIAL_SECONDS and grows on
// demand (ensure(), called when the delay time changes, never while rendering) up to
// MAX_DELAY_SECONDS, keeping its content: a long line per module would otherwise cost ~74 MB each
// (16 Patch instances of a plucked string with a DELAY would need more than 1 GB). The C++ twin
// (cpp/delay.h DelayLine) grows by the same rule, so both read the same samples.
import { MAX_DELAY_SECONDS } from '../modules/delaytime.js';

export const INITIAL_SECONDS = 1;

export class DelayLine {
  constructor() {
    this.max = Math.ceil(sampleRate * MAX_DELAY_SECONDS) + 2;
    this.length = Math.min(this.max, Math.ceil(sampleRate * INITIAL_SECONDS) + 2);
    this.buffers = [new Float32Array(this.length), new Float32Array(this.length)];
    this.pos = 0;
  }

  // Room for a delay of `samples`; returns the longest delay the line can read.
  ensure(samples) {
    const need = Math.min(this.max, Math.ceil(Number.isFinite(samples) ? samples : 0) + 2);
    if (need > this.length) {
      const len = Math.min(this.max, Math.max(need, this.length * 2));
      // oldest sample first, the next write right after the newest one
      this.buffers = this.buffers.map((b) => {
        const nb = new Float32Array(len);
        nb.set(b.subarray(this.pos));
        nb.set(b.subarray(0, this.pos), this.length - this.pos);
        return nb;
      });
      this.pos = this.length;
      this.length = len;
    }
    return this.length - 2;
  }

  read(channel, delay) {
    let at = this.pos - delay;
    if (at < 0) at += this.length;
    const i = Math.floor(at);
    const f = at - i;
    const b = this.buffers[channel];
    return b[i] + (b[(i + 1) % this.length] - b[i]) * f;
  }

  // the sample written `k` (a whole number, 0 = the newest) samples ago
  tap(channel, k) {
    let at = this.pos - k;
    if (at < 0) at += this.length;
    return this.buffers[channel][at];
  }

  clear() {
    for (const b of this.buffers) b.fill(0);
    this.pos = 0;
  }

  advance() {
    if (++this.pos === this.length) this.pos = 0;
  }
}
