// Half-band filters for 2x oversampling: polyphase IIR (two chains of first-order allpasses), the
// design of Laurent de Soras' hiir. up() makes 2 samples from 1 (the images above the old Nyquist
// removed), down() makes 1 from 2 (everything above the new Nyquist removed first). Twin of
// cpp/halfband.h: same coefficients, same operation order.

// 8 coefficients, transition band 0.04: flat to ~0.46 x the lower rate, >73 dB rejection
export const HALFBAND_STEEP = [0.04063346092419326, 0.1505051290226746, 0.3007570559918741, 0.4607745049614506,
  0.6095243148961883, 0.7385038411188573, 0.8492238103920661, 0.9497427837050002];
// 4 coefficients, transition 0.255: the second stage of 4x, whose input has nothing above a quarter
export const HALFBAND_LIGHT = [0.04189399199765617, 0.168903482439952, 0.3905607729211659, 0.7438957482684782];

const FLUSH = 1e-20;

export class Halfband {
  constructor(coefs) {
    this.c = coefs;
    this.x = new Float64Array(coefs.length);
    this.y = new Float64Array(coefs.length);
    this.a = 0; // results of the last run, paths 0 and 1
    this.b = 0;
  }

  // coefficient i filters path i % 2
  run(a, b) {
    const { c, x, y } = this;
    for (let i = 0; i < c.length; i += 2) {
      const ta = (a - y[i]) * c[i] + x[i];
      x[i] = a; y[i] = ta; a = ta;
      if (i + 1 < c.length) {
        const tb = (b - y[i + 1]) * c[i + 1] + x[i + 1];
        x[i + 1] = b; y[i + 1] = tb; b = tb;
      }
    }
    this.a = a;
    this.b = b;
  }

  // 1 sample in, this.a then this.b out
  up(v) { this.run(v, v); }

  down(first, second) {
    this.run(second, first);
    return 0.5 * (this.a + this.b);
  }

  clear() { this.x.fill(0); this.y.fill(0); }

  // A ringing tail that has decayed this far is silence: drop it, so silence is exactly 0.
  flush() {
    for (let i = 0; i < this.c.length; i++) if (Math.abs(this.x[i]) > FLUSH || Math.abs(this.y[i]) > FLUSH) return;
    this.clear();
  }
}
