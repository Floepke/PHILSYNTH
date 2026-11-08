// Run: node test/velocity2ctl.test.mjs   (VELOCITY2CTL kernel: Smooth glide)
import assert from 'node:assert/strict';

globalThis.sampleRate = 48000;
const { default: V2C, SMOOTH_MAX_MS } = await import('../src/modules/velocity2ctl.dsp.js');
const { getModule } = await import('../src/modules/index.js');

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
const BLOCKS_PER_S = 48000 / 128; // 375
const run = (k, n) => { for (let i = 0; i < n; i++) k.process(); };

const def = getModule('VELOCITY2CTL');
assert.deepEqual(def.params.map((p) => p.id), ['noteOffAction', 'smooth', 'outController', 'outMin', 'outMax', 'outSmooth'], 'Out block last');
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

{
  const { default: Phase2Ctl } = await import('../src/modules/phase2ctl.dsp.js');
  const phaseDef = getModule('PHASE2CTL');
  assert.deepEqual(phaseDef.params, def.params, 'phase converter shares velocity converter controls');
  assert.equal(phaseDef.liveMidi, false);
  const k = new Phase2Ctl();
  assert.equal(k.value, null, 'phase converter does nothing until the first note');
  for (const [phase, expected] of [[undefined, 0], [0.25, 0.25], [0.5, 0.5], [1, 0], [1.25, 0.25], [-0.25, 0.75], [NaN, 0]]) {
    k.message({ type: 'noteOn', id: 1, phase, velocity: 0.99 });
    assert.equal(k.value, expected, 'phase, not velocity, determines value');
    k.message({ type: 'noteMod', notes: [[1, 90, 0.1]] });
    assert.equal(k.value, expected, 'note curves do not alter start phase');
  }
  k.param('smooth', 1000);
  k.message({ type: 'noteOn', id: 2, phase: 0.8 });
  run(k, 375);
  near(k.value, 0.8, 'phase smoothing reaches target');
  k.param('noteOffAction', 1);
  k.message({ type: 'noteOff', id: 1 });
  assert.equal(k.target, 0.8, 'older note-off does not release newest phase');
  k.message({ type: 'noteOff', id: 2 });
  run(k, 375);
  near(k.value, 0, 'Control Down smooths to zero');
  k.param('noteOffAction', 2);
  k.message({ type: 'noteOn', id: 3, phase: 0.4 });
  k.panic();
  run(k, 375);
  assert.equal(k.value, 1, 'panic respects Control Up');

  const { dspTestHost } = await import('./dsphost.mjs');
  const { PatchRuntime } = await import('../src/patch.js');
  const { dsp, render, kernel } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp };
  const patch = await PatchRuntime.create(engine, dsp.destination);
  const phase = await patch.addModule('PHASE2CTL', { values: { outController: 3, outMin: 20, outMax: 80 } });
  const amp = await patch.addModule('AMP');
  assert.ok(patch.connect(phase.id, amp.id));
  phase.inst.noteOn(1, 60, 0.9, 0.25);
  render(2);
  assert.equal(kernel(phase.inst.node).value, 0.25, 'module forwards incoming phase to DSP');
  near(amp.values.fine, 0.35, 'phase routes through Out Min/Max to destination', 1 / 32768);
  phase.inst.noteMod(1, 72, 0.1);
  render(2);
  near(amp.values.fine, 0.35, 'velocity changes do not alter routed phase', 1 / 32768);
  const copy = await PatchRuntime.create(engine, dsp.destination);
  await copy.load(patch.toJSON());
  const restored = copy.modules.get(phase.id);
  assert.equal(restored.def.type, 'PHASE2CTL', 'new module persists and reloads');
  restored.inst.noteOn(2, 60, 0.2, 0.5);
  render(2);
  near(copy.modules.get(amp.id).values.fine, 0.5, 'restored phase routing works');
  phase.inst.allOff();
  render(2);
  near(kernel(phase.inst.node).value, 0.25, 'default note-off holds phase');
  patch.destroy(); copy.destroy();
}

console.log('velocity2ctl and phase2ctl tests passed');
