// DSP load of the engine worklet. AudioWorkletGlobalScope has no high-resolution clock (no
// `performance`, only Date.now() with 1 ms steps), so every render quantum is timed with
// Date.now() before and after: a render of d ms crosses a millisecond boundary with chance d,
// and because the start of the quanta drifts against the clock, the summed differences average
// to the real render time. Load = render time / real-time budget of the rendered quanta.
// Unlike guessing from callback timing, this works whether the browser renders quanta in bursts
// (Chrome) or one per evenly paced device callback (Safari).

export class LoadMeter {
  constructor(budgetMs, periodMs = 1000) {
    this.budget = budgetMs;
    this.period = periodMs;
    this.busy = 0;
    this.quanta = 0;
  }

  // Feed the Date.now() before and after one render quantum; returns { load } once per period of audio.
  add(t0, t1) {
    this.busy += Math.max(0, t1 - t0);
    if (++this.quanta * this.budget < this.period) return null;
    const load = Math.min(1, this.busy / (this.quanta * this.budget));
    this.busy = 0;
    this.quanta = 0;
    return { load };
  }
}
