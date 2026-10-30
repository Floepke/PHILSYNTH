import { Kernel } from '../dsp/kernel.js';

export default class Sound2CtlKernel extends Kernel {
  static modulator = true;
  static audioInput = true;

  constructor() {
    super();
    this.value = 0.5;
  }

  process(inputs) {
    const [left, right = left] = inputs[0];
    // Controllers update once per quantum: sample the final instantaneous voltage, not its peak.
    const voltage = left?.length ? 0.5 * (left[left.length - 1] + right[right.length - 1]) : 0;
    this.value = (Math.max(-1, Math.min(1, voltage)) + 1) * 0.5;
    return false; // control output only; never pass sound to the destination
  }
}
