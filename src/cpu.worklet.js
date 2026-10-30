// DSP load probe. AudioWorkletGlobalScope has no high-resolution clock (no `performance`,
// only Date.now() with 1 ms steps), so the load is estimated statistically:
// the browser renders several 128-sample quanta back to back in one "burst", then the
// audio thread sleeps until the device wants more. The probe timestamps every quantum;
// short deltas (up to one quantum's real-time budget, +1 ms clock rounding) are time spent
// rendering inside a burst, long deltas are the gap between bursts. With q quanta per burst we only see q-1 of the
// in-burst intervals, so busy = Σ short × q/(q-1). Load = busy / wall time.
// The 1 ms rounding averages out because the burst phase drifts against the ms clock.

export class LoadEstimator {
  constructor(budgetMs) {
    this.budget = budgetMs;
    // An in-burst delta is at most one budget long, but the 1 ms clock can stretch it by up to 1 ms.
    this.gapMs = budgetMs + 1;
    this.reset(0);
    this.prev = null;
  }

  reset(now) {
    this.start = now;
    this.busy = 0;
    this.quanta = 0;
    this.bursts = 0;
  }

  // Feed one timestamp per render quantum; returns a report once `periodMs` has passed.
  tick(now, periodMs = 1000) {
    if (this.prev === null) {
      this.prev = now;
      this.reset(now);
      return null;
    }
    const d = now - this.prev;
    this.prev = now;
    this.quanta++;
    if (d >= this.gapMs) this.bursts++;
    else this.busy += d;
    const wall = now - this.start;
    if (wall < periodMs) return null;
    const q = this.quanta / Math.max(1, this.bursts);
    // Without a visible burst/gap pattern (≈1 quantum per callback) the load cannot be seen.
    const visible = this.bursts >= (2 * wall) / 1000 && q >= 1.5;
    const load = visible ? Math.min(1, (this.busy * q) / (q - 1) / wall) : null;
    const report = { load, q, quanta: this.quanta };
    this.reset(now);
    return report;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('cpu-probe', class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.est = new LoadEstimator((128 / sampleRate) * 1000);
    }
    process() {
      const report = this.est.tick(Date.now());
      if (report) this.port.postMessage(report);
      return true;
    }
  });
}
