// VELOCITY2CTL kernel: the velocity (0..1) of the newest note is its modulator value (see
// velocity2ctl.js). Its velocity curve (noteMod) follows while it is the newest note; the value
// is held after the note ends, or goes to 0 / 1 (Out Min / Out Max) with Noteoff Action
// Control Down / Control Up. null until the first note (no modulation yet).
// Smooth (ms): every new target (note, velocity curve, Noteoff Action) is reached along a straight
// line from the current value in that time, stepped once per render quantum (128 samples); 0 jumps.
// The very first value jumps (there is nothing to glide from).
import { Kernel } from '../dsp/kernel.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const BLOCK = 128;
export const SMOOTH_MAX_MS = 5000;

export default class Velocity2CtlKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.lastId = null;
    this.value = null;
    this.noteOffAction = 0; // 0 hold, 1 down (0), 2 up (1)
    this.smooth = 0; // ms
    this.target = null;
    this.step = 0; // glide per block towards target
    this.left = 0; // blocks until the glide arrives (0 = there)
  }

  // a new value to move to: jump, or glide over Smooth
  set(v) {
    this.target = v;
    const blocks = (this.smooth / 1000) * sampleRate / BLOCK;
    if (this.value === null || blocks <= 1) { this.value = v; this.left = 0; }
    else { this.step = (v - this.value) / blocks; this.left = Math.ceil(blocks); }
  }

  process() {
    if (this.left > 0) this.value = --this.left === 0 ? this.target : this.value + this.step;
    return false;
  }

  param(id, v) {
    if (id === 'noteOffAction') this.noteOffAction = Math.max(0, Math.min(2, Math.round(Number(v) || 0)));
    else if (id === 'smooth') this.smooth = Math.max(0, Math.min(SMOOTH_MAX_MS, Number(v) || 0));
  }

  release() {
    this.lastId = null;
    if (this.noteOffAction === 1) this.set(0);
    else if (this.noteOffAction === 2) this.set(1);
  }

  panic() { if (this.lastId !== null) this.release(); }

  message(m) {
    switch (m.type) {
      case 'noteOn': this.lastId = m.id; this.set(clamp01(m.velocity)); break;
      case 'noteMod':
        for (const [id, , vel] of m.notes) if (id === this.lastId) this.set(clamp01(vel));
        break;
      case 'noteOff': if (m.id === this.lastId) this.release(); break;
      case 'allOff': if (this.lastId !== null) this.release(); break; // Do Nothing: no jump on stop
      default: super.message(m);
    }
  }
}
