// VELOCITY2CTL kernel: the velocity (0..1) of the newest note is its modulator value (see
// velocity2ctl.js). Its velocity curve (noteMod) follows while it is the newest note; the value
// is held after the note ends. null until the first note (no modulation yet).
import { Kernel } from '../dsp/kernel.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

export default class Velocity2CtlKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.lastId = null;
    this.value = null;
  }

  message(m) {
    switch (m.type) {
      case 'noteOn': this.lastId = m.id; this.value = clamp01(m.velocity); break;
      case 'noteMod':
        for (const [id, , vel] of m.notes) if (id === this.lastId) this.value = clamp01(vel);
        break;
      case 'noteOff': if (m.id === this.lastId) this.lastId = null; break;
      case 'allOff': this.lastId = null; break; // keep holding the value: no jump on stop
    }
  }
}
