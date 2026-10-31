// Run: node test/cpu.test.mjs   (simulates timed renders against a 1 ms clock)
import assert from 'node:assert/strict';
import { LoadMeter } from '../src/dsp/loadmeter.js';

const BUDGET = (128 / 44100) * 1000; // 2.902 ms per quantum

// `seconds` of audio, every quantum rendering for load × budget ms. Callbacks either come
// evenly paced, one quantum each (Safari), or in bursts of `q` back-to-back quanta (Chrome).
function simulate(load, q, seconds = 10, jitter = 0.4) {
  const meter = new LoadMeter(BUDGET);
  const reports = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t0 = 0.37; t0 < seconds * 1000; t0 += q * BUDGET) {
    let t = t0 + rnd() * jitter;
    for (let i = 0; i < q; i++) {
      const d = load * BUDGET * (0.8 + 0.4 * rnd());
      const r = meter.add(Math.floor(t), Math.floor(t + d));
      if (r) reports.push(r.load);
      t += d;
    }
  }
  return reports;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

for (const q of [1, 8, 16]) {
  for (const load of [0, 0.02, 0.1, 0.3, 0.5, 0.8, 0.95]) {
    const rs = simulate(load, q);
    assert.ok(rs.length >= 9, 'one report per second');
    const m = mean(rs);
    assert.ok(Math.abs(m - load) < 0.03, `q=${q} load=${load}: measured ${m.toFixed(3)}`);
  }
}

// Safari case: evenly paced callbacks with a light patch must not read as ~90 %.
assert.ok(mean(simulate(0.03, 1)) < 0.08);

// Never above 100 %.
assert.ok(simulate(1.2, 1).every((l) => l <= 1));

console.log('cpu tests passed');
