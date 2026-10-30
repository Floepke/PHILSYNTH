// MULTICTL kernel: its modulator value is simply the Value controller (0..100 % -> 0..1). The
// engine graph maps it through Out Min / Out Max onto every routed controller (see multictl.js).
import { Kernel } from '../dsp/kernel.js';

export default class MultiCtlKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.value = 0.5;
  }

  param(id, v) {
    if (id === 'value') this.value = Math.max(0, Math.min(1, (Number(v) || 0) / 100));
  }
}
