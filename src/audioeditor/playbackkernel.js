import { Kernel } from '../dsp/kernel.js';

export class AudioClipKernel extends Kernel {
  static external = true;

  constructor() {
    super();
    this.left = new Float32Array(128);
    this.right = new Float32Array(128);
    this.live = false;
  }

  process(_inputs, outputs) {
    if (!this.live) return false;
    outputs[0][0].set(this.left);
    outputs[0][1].set(this.right);
    return true;
  }
}
