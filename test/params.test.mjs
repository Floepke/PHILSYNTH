// Run: node test/params.test.mjs   (controller value math: wheel nudging)
import assert from 'node:assert/strict';
import { nudge, wheelNotches, toNorm } from '../src/params.js';

const lin = { min: 0, max: 1, step: 0.01 };
const amp = { min: 0, max: 4, step: 0.01 };
const opts = { min: 0, max: 3, step: 1, options: ['a', 'b', 'c', 'd'] };
const seed = { min: 1, max: 999, step: 1 };
const log = { min: 20, max: 20000, scale: 'log' };
const pan = { min: -1, max: 1, step: 0.01 };
const free = { min: 0, max: 10 };

// one notch = 1 % of the slider, Shift = 0.1 %
assert.equal(nudge(lin, 0.5, 1), 0.51);
assert.equal(nudge(lin, 0.5, -1), 0.49);
assert.equal(nudge(amp, 1, 1), 1.04);
assert.ok(Math.abs(nudge(free, 5, 1, true) - 5.01) < 1e-9);
assert.ok(Math.abs(nudge(free, 5, 0.5) - 5.05) < 1e-9, 'trackpad: fractional notches');

// stepped controllers always move at least one step (fine steps would round to nothing)
assert.equal(nudge(amp, 1, 1, true), 1.01);
assert.equal(nudge(opts, 1, 1), 2);
assert.equal(nudge(opts, 1, -1), 0);
assert.equal(nudge(opts, 1, 1, true), 2);
assert.equal(nudge(seed, 1, 1), 11, '1 % of 1..999');
assert.equal(nudge(seed, 500, 1, true), 501, 'fine: one step');

// clamped at the ends
assert.equal(nudge(opts, 3, 1), 3);
assert.equal(nudge(opts, 0, -1), 0);
assert.equal(nudge(lin, 1, 5), 1);
assert.equal(nudge(pan, -1, -1), -1);
assert.equal(nudge(log, 20000, 1), 20000);

// log controllers move 1 % of the slider, i.e. a constant ratio
const a = nudge(log, 100, 1);
const b = nudge(log, 1000, 1);
assert.ok(Math.abs(a / 100 - b / 1000) < 1e-9);
assert.ok(Math.abs(toNorm(log, a) - toNorm(log, 100) - 0.01) < 1e-9);

assert.equal(nudge(lin, 0.5, 0), 0.5);

// wheel deltas: up = positive; a mouse wheel click is exactly one notch in every browser
assert.equal(wheelNotches(-100, 0), 1); // Chrome
assert.equal(wheelNotches(120, 0), -1); // Chrome, some mice
assert.equal(wheelNotches(-3, 1), 1); // Firefox, line mode
assert.equal(wheelNotches(-48, 0), 1); // Firefox, pixel mode
assert.equal(wheelNotches(-300, 0), 3); // fast spin
assert.equal(wheelNotches(-1, 2), 1); // page mode
assert.ok(Math.abs(wheelNotches(-10, 0) - 0.1) < 1e-9, 'trackpad: small fractional deltas');

console.log('all params tests passed');
