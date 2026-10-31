// Run: node test/delay.test.mjs (both DSP backends plus MODMIDI / patch integration).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dspTestHost } from './dsphost.mjs';
import DelayKernel from '../src/modules/delay.dsp.js';
import delayDef from '../src/modules/delay.js';
import { delayPeriod, delaySeconds, formatDelay } from '../src/modules/delaytime.js';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';
import { PatchRuntime, cableSignals } from '../src/patch.js';
import { getModule } from '../src/modules/index.js';

const SR = sampleRate;
const native = wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), SR);
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`);
const unitValue = (period) => Math.log(period * 4) / Math.log(256) * 10000;

assert.equal(delaySeconds(10000, 0, 120), 10);
for (const period of [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
  assert.equal(delayPeriod(unitValue(period)), period);
  for (const bpm of [20, 120, 1000]) for (let unit = 1; unit <= 3; unit++) {
    close(delaySeconds(unitValue(period), unit, bpm), period * 60 / bpm / 2 ** (unit - 1), 'musical time');
  }
}
assert.equal(formatDelay(10000, { unit: 0 }), '10000.0 ms');
assert.equal(formatDelay(unitValue(1 / 3), { unit: 2 }), '1/3 \u00d7 1/8');
assert.equal(formatDelay(10000, { unit: 1 }), '64 \u00d7 1/4');

// Block-by-block rendering detects early leaks and missing tails even when input disappears.
function impulse(K, left, right, unit = 0, bpm = 120) {
  const k = new K();
  k.param('left', left); k.param('right', right); k.param('unit', unit);
  k.message({ type: 'bpm', value: bpm });
  const delays = [left, right].map((v) => delaySeconds(v, unit, bpm) * SR);
  const input = [[new Float32Array(128), new Float32Array(128)]];
  input[0][0][0] = 1;
  input[0][1][0] = 0.5;
  const output = [[new Float32Array(128), new Float32Array(128)]];
  const hits = [[], []];
  const end = Math.ceil(Math.max(...delays)) + 256;
  for (let at = 0; at < end; at += 128) {
    const live = k.process(at ? [[]] : input, output);
    if (!live) continue;
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < 128; i++) {
      if (Math.abs(output[0][ch][i]) > 1e-7) hits[ch].push([at + i, output[0][ch][i]]);
    }
  }
  for (let ch = 0; ch < 2; ch++) {
    const d = delays[ch], floor = Math.floor(d), fraction = d - floor, amp = ch ? 0.5 : 1;
    const expected = [[floor, amp * (1 - fraction)], [floor + 1, amp * fraction]].filter(([, v]) => v > 1e-7);
    assert.equal(hits[ch].length, expected.length, 'only the delayed impulse, no dry leakage');
    for (let i = 0; i < expected.length; i++) {
      assert.equal(hits[ch][i][0], expected[i][0], 'sample-exact delay');
      close(hits[ch][i][1], expected[i][1], 'fractional delay gain');
    }
  }
  k.destroy?.();
}

for (const K of [DelayKernel, native.kernels.delay]) {
  impulse(K, 0, 5);
  impulse(K, 10.125, 20.25);
  impulse(K, 10000, 10000);
  impulse(K, unitValue(1), unitValue(1.5), 2, 120);
  // Full 64-quarter-note delay at minimum BPM: 192 seconds, not silently capped at 10 s.
  impulse(K, 10000, 0, 1, 20);
}

// Deterministic audio-clock MIDI harness, independent of wall-clock timers.
function midiHarness() {
  const t = dspTestHost();
  const ctx = { currentTime: 0 };
  const inst = delayDef.create(ctx, delayDef, t);
  const calls = [];
  const target = Object.fromEntries(['noteOn', 'noteMod', 'noteOff', 'allOff'].map((type) =>
    [type, (...args) => calls.push([ctx.currentTime, type, ...args])]));
  inst.getMidiTargets = () => [target];
  const at = (time) => { ctx.currentTime = time; t.dsp.receive({ time }); };
  return { ...t, inst, calls, target, at };
}
{
  const h = midiHarness();
  h.inst.setParam('left', 100);
  h.inst.setParam('right', 9000);
  h.inst.noteOn(7, 60.25, 0.63, 0.75);
  h.at(0.05); h.inst.noteMod(7, 61.5, 0.4);
  h.at(0.06); h.inst.noteOff(7);
  h.at(0.099); assert.deepEqual(h.calls, []);
  h.at(0.1);
  assert.deepEqual(h.calls[0].slice(1), ['noteOn', h.calls[0][2], 60.25, 0.63, 0.75, 0.1]);
  const id = h.calls[0][2];
  h.at(0.15); assert.deepEqual(h.calls[1].slice(1), ['noteMod', id, 61.5, 0.4]);
  h.at(0.16); assert.deepEqual(h.calls[2].slice(1), ['noteOff', id]);
  h.inst.destroy();
  assert.equal(h.dsp.clocks.size, 0, 'destroy unsubscribes');
}
{
  const h = midiHarness();
  h.inst.setParam('left', 100);
  h.inst.noteOn(1, 60, 1);
  h.at(0.02);
  h.inst.onModulated('left', 200);
  h.inst.noteMod(1, 62.5, 0.2);
  h.at(0.1);
  h.inst.setParam('left', 300);
  h.inst.noteOff(1);
  h.at(0.22);
  h.at(0.4);
  assert.deepEqual(h.calls.map((c) => [c[0], c[1]]), [[0.1, 'noteOn'], [0.22, 'noteMod'], [0.4, 'noteOff']], 'each message uses current delay');
  h.inst.destroy();
}
{
  const h = midiHarness();
  h.inst.setParam('left', 100);
  h.inst.noteOn(1, 60, 1);
  h.at(0.02); h.inst.setParam('left', 0); h.inst.noteOff(1);
  h.at(1);
  assert.deepEqual(h.calls, [], 'an overtaking off cancels the pending on');
  h.inst.noteOn(1, 60, 1);
  h.inst.allOff();
  assert.deepEqual(h.calls.map((c) => c[1]), ['noteOn', 'noteOff'], 'panic releases only owned notes');
  h.inst.setParam('left', 100);
  h.inst.noteOn(2, 62, 1);
  h.inst.allOff();
  h.at(2);
  assert.equal(h.calls.length, 2, 'panic clears queued events');
  h.inst.destroy();
}
{
  const h = midiHarness();
  h.inst.setParam('left', 100);
  h.inst.noteOn(1, 60, 1);
  h.inst.releaseTarget(h.target);
  h.at(0.1);
  assert.deepEqual(h.calls, [], 'disconnect cancels pending delivery');
  h.inst.noteOn(2, 64, 1);
  h.at(0.2);
  h.inst.releaseTarget(h.target);
  assert.deepEqual(h.calls.map((c) => c[1]), ['noteOn', 'noteOff']);
  h.inst.destroy();
}
{
  const h = midiHarness();
  h.inst.setParam('left', unitValue(1));
  h.inst.setParam('unit', 1);
  h.inst.setBpm(120);
  h.inst.noteOn(1, 60, 1);
  h.at(0.1); h.inst.setBpm(60); h.inst.noteOff(1);
  h.at(0.5); h.at(1.1);
  assert.deepEqual(h.calls.map((c) => [c[0], c[1]]), [[0.5, 'noteOn'], [1.1, 'noteOff']], 'tempo change affects new events only');
  h.inst.destroy();
}

// Stock module registration, dual cables, copies, round trips, clocks, native render path.
for (const opts of [undefined, native]) {
  const t = dspTestHost(opts);
  const engine = { ctx: { currentTime: 0 }, dsp: t.dsp };
  const patch = await PatchRuntime.create(engine, t.dsp.destination);
  const d = await patch.addModule('DELAY', { values: { left: 10, right: 20 } });
  const e = await patch.addModule('ECHO', { values: { filter: 6, cutoff: 800 } });
  const osc = await patch.addModule('OSC');
  const mm = await patch.addModule('MULTIMIDI');
  assert.ok(patch.connect(mm.id, d.id), 'MIDI input');
  assert.ok(patch.connect(d.id, osc.id), 'MIDI-only output to OSC');
  assert.ok(patch.connect(d.id, e.id) && patch.connect(e.id, 0), 'audio output to ECHO / OUT');
  assert.deepEqual(d.inst.getMidiTargets(), [osc.inst], 'audio-only targets never get MIDI');
  assert.ok(d.inst.node.out.has(e.inst.input));
  assert.ok(patch.hasMidiInput(d.id) && patch.hasMidiInput(osc.id));
  assert.equal(patch.hasMidiInput(e.id), false);
  assert.equal(patch.connect(osc.id, d.id), false, 'mixed MIDI/audio cycle rejected');
  assert.deepEqual(cableSignals(d.def, getModule('PATCH')), { audio: true, midi: true });
  patch.setParam(0, 'bpm', 87);
  if (!opts) assert.equal(t.kernel(d.inst.node).bpm, 87);
  t.render();
  if (opts) assert.ok(t.graph.prog, 'new effects retain native whole-graph rendering');
  const data = patch.toJSON();
  await patch.load(data);
  assert.deepEqual(patch.toJSON(), data, 'parameters and cable behavior survive saving');
  const copy = await patch.duplicate(d.id);
  assert.deepEqual(copy.values, patch.modules.get(d.id).values);
  assert.notEqual(copy.inst, patch.modules.get(d.id).inst);
  patch.destroy();
  assert.equal(t.dsp.clocks.size, 0, 'load / destroy leaves no MIDI timers');
}
console.log('all delay tests passed');
