export const ANALYSIS_SIZE = 4096;

// Full-rate stereo spectrum window, only allocated while the Analyse panel is visible.
export class AudioAnalysis {
  constructor(h) {
    this.h = h;
    this.left = new Float32Array(ANALYSIS_SIZE);
    this.right = new Float32Array(ANALYSIS_SIZE);
    this.at = 0;
    this.count = 0;
    this.filled = 0;
  }

  push(left, right) {
    for (let i = 0; i < 128; i++) {
      const l = left ? left[i] : 0;
      const r = right ? right[i] : 0;
      this.left[this.at] = l;
      this.right[this.at] = r;
      this.at = (this.at + 1) % ANALYSIS_SIZE;
    }
    this.count += 128;
    this.filled = Math.min(ANALYSIS_SIZE, this.filled + 128);
  }

  report() {
    if (!this.count || this.filled < ANALYSIS_SIZE) return null;
    const samples = new Float32Array(ANALYSIS_SIZE * 2);
    for (let i = 0; i < ANALYSIS_SIZE; i++) {
      const at = (this.at + i) % ANALYSIS_SIZE;
      samples[i] = this.left[at];
      samples[ANALYSIS_SIZE + i] = this.right[at];
    }
    const result = {
      h: this.h, samples, sampleRate,
    };
    this.count = 0;
    return result;
  }
}
