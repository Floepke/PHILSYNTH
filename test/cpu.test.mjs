// Run: node test/cpu.test.mjs   (simulates audio callbacks against a 1 ms clock)
import assert from 'node:assert/strict';
import { LoadEstimator } from '../src/cpu.worklet.js';

const BUDGET = (128 / 48000) * 1000; // 2.667 ms per quantum

// Simulate `seconds` of audio: every callback renders `q` quanta back to back, each taking
// load × budget ms of real time; the probe only sees Date.now() (floored ms).
function simulate(load, q, seconds = 10, jitter = 0.3) {
  const est = new LoadEstimator(BUDGET);
  const reports = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const period = q * BUDGET;
  for (let t0 = 0.37; t0 < seconds * 1000; t0 += period) {
    let t = t0 + rnd() * jitter; // wake-up jitter
    for (let i = 0; i < q; i++) {
      const r = est.tick(Math.floor(t)); // probe runs first in the quantum
      if (r) reports.push(r);
      t += load * BUDGET;
    }
  }
  return reports.slice(1); // first period includes start-up
}

const mean = (rs) => rs.reduce((s, r) => s + r.load, 0) / rs.length;

for (const q of [8, 16]) {
  for (const load of [0.02, 0.1, 0.3, 0.5, 0.8, 0.9]) {
    const rs = simulate(load, q);
    assert.ok(rs.length >= 8, 'one report per second');
    const m = mean(rs);
    assert.ok(Math.abs(m - load) < 0.04, `q=${q} load=${load}: measured ${m.toFixed(3)}`);
    const mq = rs.reduce((s, r) => s + r.q, 0) / rs.length;
    assert.ok(Math.abs(mq - q) < 0.5, `q estimate ${mq}`);
  }
}

// Idle patch reads close to zero.
assert.ok(mean(simulate(0, 16)) < 0.01);

// One quantum per callback: no in-burst samples, so the load is unknown rather than 0.
assert.equal(simulate(0.3, 1)[0].load, null);

// Never reports above 100 %.
assert.ok(simulate(0.99, 16).every((r) => r.load <= 1));

console.log('cpu tests passed');
