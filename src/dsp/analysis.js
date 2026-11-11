export const ANALYSIS_SIZE = 4096;
export const ANALYSIS_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768];

export function validateAnalysisSize(size) {
  if (!ANALYSIS_SIZES.includes(size)) throw new Error(`Invalid spectrum analyser size: ${size}`);
  return size;
}

// Full-rate stereo spectrum window, only allocated while the Analyse panel is visible.
export class AudioAnalysis {
  constructor(h, size = ANALYSIS_SIZE) {
    this.h = h;
    this.size = validateAnalysisSize(size);
    this.left = new Float32Array(size);
    this.right = new Float32Array(size);
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
      this.at = (this.at + 1) % this.size;
    }
    this.count += 128;
    this.filled = Math.min(this.size, this.filled + 128);
  }

  report() {
    if (!this.count || this.filled < this.size) return null;
    const samples = new Float32Array(this.size * 2);
    for (let i = 0; i < this.size; i++) {
      const at = (this.at + i) % this.size;
      samples[i] = this.left[at];
      samples[this.size + i] = this.right[at];
    }
    const result = {
      h: this.h, samples, sampleRate,
    };
    this.count = 0;
    return result;
  }
}
