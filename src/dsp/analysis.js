export const ANALYSIS_SIZE = 4096;

// Only constructed while the Analyse panel is visible. Levels include every raw sample,
// independently of the circular spectrum window and of the cable display's decimation.
export class AudioAnalysis {
  constructor(h) {
    this.h = h;
    this.left = new Float32Array(ANALYSIS_SIZE);
    this.right = new Float32Array(ANALYSIS_SIZE);
    this.at = 0;
    this.count = 0;
    this.peak = [0, 0];
    this.squares = [0, 0];
  }

  push(left, right) {
    for (let i = 0; i < 128; i++) {
      const l = left ? left[i] : 0;
      const r = right ? right[i] : 0;
      this.left[this.at] = l;
      this.right[this.at] = r;
      this.at = (this.at + 1) % ANALYSIS_SIZE;
      this.peak[0] = Math.max(this.peak[0], Math.abs(l));
      this.peak[1] = Math.max(this.peak[1], Math.abs(r));
      this.squares[0] += l * l;
      this.squares[1] += r * r;
    }
    this.count += 128;
  }

  report() {
    if (!this.count) return null;
    const samples = new Float32Array(ANALYSIS_SIZE * 2);
    for (let i = 0; i < ANALYSIS_SIZE; i++) {
      const at = (this.at + i) % ANALYSIS_SIZE;
      samples[i] = this.left[at];
      samples[ANALYSIS_SIZE + i] = this.right[at];
    }
    const result = {
      h: this.h, samples, sampleRate,
      peak: this.peak.slice(),
      rms: this.squares.map(value => Math.sqrt(value / this.count)),
    };
    this.count = 0;
    this.peak.fill(0);
    this.squares.fill(0);
    return result;
  }
}
