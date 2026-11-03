// Run: node test/velocity2ctl.test.mjs   (VELOCITY2CTL kernel: Smooth glide)
import assert from 'node:assert/strict';

globalThis.sampleRate = 48000;
const { default: V2C, SMOOTH_MAX_MS } = await import('../src/modules/velocity2ctl.dsp.js');
const { getModule } = await import('../src/modules/index.js');

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
const BLOCKS_PER_S = 48000 / 128; // 375
const run = (k, n) => { for (let i = 0; i < n; i++) k.process(); };

const def = getModule('VELOCITY2CTL');
assert.deepEqual(def.params.map((p) => p.id), ['noteOffAction', 'smooth', 'outController', 'outMin', 'outMax'], 'Out block last');
const sp = def.params.find((p) => p.id === 'smooth');
assert.equal(sp.default, 0, 'Smooth defaults to 0 (jump, as before)');
assert.equal(sp.max, SMOOTH_MAX_MS);
assert.equal(sp.format(0), 'Off (jump)');
assert.equal(sp.format(250), '250 ms');
assert.equal(sp.format(1500), '1.50 s');

// Smooth 0: identical to before (values jump, null until the first note)
{
  const k = new V2C();
  assert.equal(k.value, null);
  run(k, 3);
  assert.equal(k.value, null, 'no value before the first note');
  k.message({ type: 'noteOn', id: 1, velocity: 0.8 });
  assert.equal(k.value, 0.8, 'jumps on noteOn');
  k.message({ type: 'noteMod', notes: [[1, 60, 0.3]] });
  assert.equal(k.value, 0.3, 'jumps on the velocity curve');
  k.param('noteOffAction', 2);
  k.message({ type: 'noteOff', id: 1 });
  assert.equal(k.value, 1, 'Control Up jumps');
}

// Smooth 1000 ms: the first note jumps, later values glide linearly in one second
{
  const k = new V2C();
  k.param('smooth', 1000);
  k.message({ type: 'noteOn', id: 1, velocity: 0.2 });
  assert.equal(k.value, 0.2, 'first value jumps: nothing to glide from');
  k.message({ type: 'noteOn', id: 2, velocity: 0.8 });
  assert.equal(k.value, 0.2, 'no jump on the new note');
  run(k, 1);
  near(k.value, 0.2 + 0.6 / BLOCKS_PER_S, 'one step per block');
  run(k, 149);
  near(k.value, 0.2 + 0.6 * 150 / 375, 'linear: 150 of 375 blocks', 1e-6);
  run(k, 224);
  assert.ok(k.value < 0.8, 'not there one block early');
  run(k, 1);
  near(k.value, 0.8, 'arrives after one second (375 blocks)', 1e-6);
  run(k, 10);
  assert.equal(k.value, 0.8, 'holds the target');

  // a new target mid-glide starts from where the value is (no jump)
  k.message({ type: 'noteOn', id: 3, velocity: 0 });
  run(k, 75);
  const mid = k.value;
  near(mid, 0.8 - 0.8 * 75 / 375, '75 blocks down', 1e-6);
  k.message({ type: 'noteMod', notes: [[3, 60, 1]] });
  assert.equal(k.value, mid, 'velocity curve change does not jump');
  run(k, BLOCKS_PER_S);
  near(k.value, 1, 'reaches the new target in Smooth time', 1e-6);

  // Noteoff Action glides too
  k.param('noteOffAction', 1);
  k.message({ type: 'noteOff', id: 3 });
  assert.equal(k.value, 1, 'Control Down does not jump');
  run(k, 150);
  near(k.value, 1 - 150 / 375, 'gliding down', 1e-6);
  run(k, 225);
  near(k.value, 0, 'at Out Min after one second', 1e-6);
}

// a Smooth shorter than one block jumps
{
  const k = new V2C();
  k.param('smooth', 2); // 96 samples
  k.message({ type: 'noteOn', id: 1, velocity: 0.1 });
  k.message({ type: 'noteOn', id: 2, velocity: 0.9 });
  assert.equal(k.value, 0.9);
}

console.log('velocity2ctl tests passed');
