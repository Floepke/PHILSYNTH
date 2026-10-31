// Run: node test/params.test.mjs   (controller value math: wheel nudging)
import assert from 'node:assert/strict';
import { nudge, wheelNotches, toNorm, wheelAccumulator, wheelDelta } from '../src/params.js';

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

// macOS: a slow mouse-wheel click arrives as a tiny pixel delta; after a pause it is a whole notch
{
  const ev = (timeStamp, deltaY) => ({ timeStamp, deltaY, deltaMode: 0 });
  const stepped = wheelAccumulator({ whole: true });
  assert.equal(stepped(ev(0, -4)), 1, 'slow click: one step up');
  assert.equal(stepped(ev(400, -4)), 1, 'the next slow click too');
  assert.equal(stepped(ev(800, 4)), -1, 'and down');
  // a trackpad stream (16 ms apart): the first event moves, the rest adds up
  const pad = wheelAccumulator({ whole: true });
  const got = [];
  for (let i = 0; i < 30; i++) got.push(pad(ev(2000 + i * 16, -5)));
  assert.equal(got[0], 1);
  assert.equal(got.reduce((a, b) => a + b, 0), 1 + Math.trunc(29 * 0.05 + 1e-9), 'small deltas accumulate');
  // continuous controllers get fractions during a stream, a whole notch after a pause
  const cont = wheelAccumulator();
  assert.equal(cont(ev(0, -3)), 1);
  assert.ok(Math.abs(cont(ev(16, -3)) - 0.03) < 1e-9);
  assert.equal(cont(ev(500, 100)), -1, 'mouse notch');
}

// wheelStep: a fixed amount per wheel click (the Output's BPM moves 1 BPM per click)
{
  const { nudge: nudgeBy } = await import('../src/params.js');
  const { getModule } = await import('../src/modules/index.js');
  const bpm = getModule('OUT').params.find((x) => x.id === 'bpm');
  assert.equal(bpm.wheelStep, 1);
  assert.equal(nudgeBy(bpm, 120, 1), 121, 'one click up = +1 BPM');
  assert.equal(nudgeBy(bpm, 120, -3), 117);
  assert.equal(nudgeBy(bpm, 120, 1, true), 121, 'Shift: still 1 BPM');
  assert.equal(nudgeBy(bpm, 1000, 1), 1000, 'clamped to the range');
}
// Firefox can deliver non-finite wheel deltas; they must not poison views or values (NaN%).
assert.ok(wheelNotches(NaN, 0) === 0 && wheelNotches(undefined, 1) === 0);
assert.deepEqual(wheelDelta({ deltaX: NaN, deltaY: undefined, deltaMode: 1 }), { dx: 0, dy: 0, mode: 1 });
assert.equal(wheelDelta({ deltaX: 3, deltaY: -40, deltaMode: 0 }).dy, -40);

console.log('all params tests passed');

// Sequencer views clamp scroll positions; NaN must land on the lower bound, not stick.
const { clamp } = await import('../src/seq/surface.js');
assert.equal(clamp(NaN, 0, 10), 0);
assert.equal(clamp(12, 0, 10), 10);
