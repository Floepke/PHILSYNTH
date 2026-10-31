// VELOCITY2CTL kernel: the velocity (0..1) of the newest note is its modulator value (see
// velocity2ctl.js). Its velocity curve (noteMod) follows while it is the newest note; the value
// is held after the note ends, or goes to 0 / 1 (Out Min / Out Max) with Noteoff Action
// Control Down / Control Up. null until the first note (no modulation yet).
import { Kernel } from '../dsp/kernel.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

export default class Velocity2CtlKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.lastId = null;
    this.value = null;
    this.noteOffAction = 0; // 0 hold, 1 down (0), 2 up (1)
  }

  param(id, v) {
    if (id === 'noteOffAction') this.noteOffAction = Math.max(0, Math.min(2, Math.round(Number(v) || 0)));
  }

  release() {
    this.lastId = null;
    if (this.noteOffAction === 1) this.value = 0;
    else if (this.noteOffAction === 2) this.value = 1;
  }

  panic() { if (this.lastId !== null) this.release(); }

  message(m) {
    switch (m.type) {
      case 'noteOn': this.lastId = m.id; this.value = clamp01(m.velocity); break;
      case 'noteMod':
        for (const [id, , vel] of m.notes) if (id === this.lastId) this.value = clamp01(vel);
        break;
      case 'noteOff': if (m.id === this.lastId) this.release(); break;
      case 'allOff': if (this.lastId !== null) this.release(); break; // Do Nothing: no jump on stop
      default: super.message(m);
    }
  }
}
