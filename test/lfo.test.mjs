// Run: node test/lfo.test.mjs   (runs the real LFO DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';

const SR = 48000;
const Proc = await loadKernel('lfo.dsp.js', SR);

// On/Off pauses both control-rate and audio-rate LFOs without losing phase or random state.
for (const audio of [false, true]) for (const wave of [0, 1, 2, 3, 4]) {
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  const output = [[new Float32Array(128), new Float32Array(128)]];
  const input = audio ? [[new Float32Array(128).fill(1), new Float32Array(128).fill(0.5)]] : [];
  const run = () => k.process(input, output);
  assert.equal(k.enabled, true);
  m({ type: 'param', id: 'wave', value: wave });
  run();
  const phase = k.phase;
  const from = k.from, to = k.to;
  m({ type: 'param', id: 'enabled', value: 0 });
  for (let i = 0; i < 400; i++) run();
  assert.equal(k.phase, phase);
  assert.equal(k.from, from);
  assert.equal(k.to, to, 'paused Random does not draw new targets');
  assert.equal(k.value, k.at(), 'paused wave level remains available for live trimming');
  if (audio) {
    assert.ok(output[0][0].every(v => v === output[0][0][0]), 'paused tremolo holds its gain');
  }
  m({ type: 'param', id: 'phase', value: 0.2 });
  assert.equal(k.phase, phase, 'Phase controller does not discard remembered phase');
  m({ type: 'noteOn', id: 1, pitch: 60, phase: 0.3 });
  assert.equal(k.phase, 0.5, 'MIDI phase resets even while Off');
  run();
  assert.equal(k.phase, 0.5);
  m({ type: 'param', id: 'enabled', value: 1 });
  run();
  assert.ok(Math.abs(k.phase - (0.5 + 128 / SR)) < 1e-9, 'On resumes from stored phase');
}

// VELOCITY2CTL can drive On/Off; the setting persists when the patch is saved/loaded.
{
  const { dspTestHost } = await import('./dsphost.mjs');
  const { PatchRuntime } = await import('../src/patch.js');
  const { dsp, kernel, render } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const lfo = await root.addModule('LFO');
  assert.equal(lfo.values.enabled, 1);
  assert.equal(lfo.def.params.at(-1).id, 'enabled', 'append without renumbering existing controllers');
  const vel = await root.addModule('VELOCITY2CTL', { values: {
    outController: lfo.def.params.findIndex(p => p.id === 'enabled'), noteOffAction: 1,
  } });
  root.connect(vel.id, lfo.id);
  vel.inst.noteOn(1, 60, 1);
  render(2);
  assert.equal(kernel(lfo.inst.node).enabled, true);
  vel.inst.noteOff(1);
  render(2);
  assert.equal(kernel(lfo.inst.node).enabled, false);
  const phase = kernel(lfo.inst.node).phase;
  render(30);
  assert.equal(kernel(lfo.inst.node).phase, phase);
  const saved = root.toJSON();
  const copy = await PatchRuntime.create(engine, dsp.destination);
  await copy.load(saved);
  render(2);
  assert.equal(kernel(copy.modules.get(lfo.id).inst.node).enabled, false, 'saved Off is restored');
  vel.inst.noteOn(2, 60, 1);
  render(3);
  assert.equal(kernel(lfo.inst.node).enabled, true);
  assert.notEqual(kernel(lfo.inst.node).phase, phase);
  root.destroy();
  copy.destroy();
}

const l = new Proc();
const msg = (data) => l.port.onmessage({ data });
const values = [];
l.port.postMessage = (v) => values.push(v);
msg({ type: 'rate', value: 10 });
msg({ type: 'wave', value: 2 });
for (let b = 0; b < 100; b++) l.process([], [[new Float32Array(128)]]);
msg({ type: 'wave', value: 4 }); // Random
const start = values.length;
for (let b = 0; b < 3000; b++) l.process([], [[new Float32Array(128)]]); // 8 s = 80 cycles
const r = values.slice(start);

assert.ok(r.every((v) => v >= 0 && v <= 1), 'stays in 0..1');
const maxStep = Math.max(...r.slice(1).map((v, i) => Math.abs(v - r[i])));
// smoothstep slope ≤ 1.5 per cycle; one post = 256 samples = 0.0533 cycles at 10 Hz
assert.ok(maxStep < 1.5 * (256 * 10 / SR) + 1e-9, `smooth, no jumps (max step ${maxStep})`);
// a new target every cycle: the values at cycle boundaries differ and cover the range
const ends = r.filter((_, i) => i % 19 === 0);
assert.ok(Math.max(...r) - Math.min(...r) > 0.6, 'random targets spread over the range');
assert.ok(new Set(ends.map((v) => v.toFixed(3))).size > 30, 'keeps moving to new targets');

// Frequency Unit MIDI Pitch: follows the newest held note (pitch curve too), falls back, keeps the last
{
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'freq', value: 3 });
  m({ type: 'param', id: 'unit', value: 4 });
  assert.equal(k.rate, 0, 'stands still before the first note');
  m({ type: 'noteOn', id: 1, pitch: 33 }); // A1 = 55 Hz
  assert.equal(k.rate, 55);
  m({ type: 'noteOn', id: 2, pitch: 45 });
  assert.equal(k.rate, 110, 'newest note wins');
  m({ type: 'noteMod', notes: [[2, 57, 1]] });
  assert.equal(k.rate, 220, 'follows its pitch curve');
  m({ type: 'noteMod', notes: [[1, 21, 1]] });
  assert.equal(k.rate, 220, 'older notes do not change it');
  m({ type: 'noteOff', id: 2 });
  assert.equal(k.rate, 27.5, 'the previous held note takes over');
  m({ type: 'noteOff', id: 1 });
  assert.equal(k.rate, 27.5, 'none held: keeps the last pitch');
  const p0 = k.phase;
  for (let b = 0; b < 375; b++) k.process([], [[new Float32Array(128)]]); // 1 s
  assert.ok(Math.abs(((k.phase - p0 + 1) % 1) - ((27.5 * 375 * 128 / SR) % 1)) < 1e-6, 'phase advances at the note frequency');
  m({ type: 'param', id: 'unit', value: 0 });
  assert.equal(k.rate, 3, 'Hz: Frequency again');
}

// Phase: start point on creation (project load), panic and incoming notes; turning it does not jump
{
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'wave', value: 2 }); // saw: value = phase
  m({ type: 'param', id: 'phase', value: 0.25 });
  assert.equal(k.phase, 0.25, 'set before the first block: starts there');
  assert.equal(k.value, 0.25);
  for (let b = 0; b < 100; b++) k.process([], [[new Float32Array(128)]]);
  const running = k.phase;
  m({ type: 'param', id: 'phase', value: 0.75 });
  assert.equal(k.phase, running, 'turned while running: no jump');
  k.panic();
  assert.equal(k.phase, 0.75, 'panic resets to Phase');
  for (let b = 0; b < 10; b++) k.process([], [[new Float32Array(128)]]);
  m({ type: 'noteOn', id: 1, pitch: 60, phase: 0.5 });
  assert.equal(k.phase, 0.25, 'noteOn: Phase + note phase, wrapped');
  m({ type: 'noteOn', id: 2, pitch: 60 });
  assert.equal(k.phase, 0.75, 'noteOn without phase: Phase');
  m({ type: 'reset' });
  assert.equal(k.phase, 0.75);
}

// Audio input: tremolo. Output = input × the wave mapped like a controller (Amplitude, then
// Out Min..Out Max in %), computed per sample; no input: silent, as before.
{
  const { tremoloGain } = await import('../src/modules/lfo.dsp.js');
  assert.equal(tremoloGain(1, 100, 0, 100), 1);
  assert.equal(tremoloGain(0, 100, 0, 100), 0);
  assert.equal(tremoloGain(0, 50, 0, 100), 0.25, 'Amplitude: depth around the middle');
  assert.equal(tremoloGain(1, 100, 20, 60), 0.6, 'Out Max = loudest');
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'wave', value: 2 }); // saw: value = phase
  m({ type: 'param', id: 'freq', value: SR / 128 / 4 }); // a quarter cycle per block
  const out = () => [[new Float32Array(128), new Float32Array(128)]];
  assert.equal(k.process([], out()), false, 'no input: no sound');
  const o = out();
  const ones = new Float32Array(128).fill(1);
  const halves = new Float32Array(128).fill(0.5);
  assert.equal(k.process([[ones, halves]], o), true);
  // phase 0.25 -> 0.5 over this block: the saw per sample
  const [L, R] = o[0];
  assert.ok(L.every((v, j) => Math.abs(v - (0.25 + j / 512)) < 1e-6), 'the wave per sample');
  assert.ok(Math.abs(R[127] - 0.5 * (0.25 + 127 / 512)) < 1e-6, 'stereo: each channel scaled');
  assert.equal(k.value, 0.25, 'the control value still starts the block');
  m({ type: 'param', id: 'outMin', value: 50 });
  m({ type: 'param', id: 'amp', value: 0 });
  const o2 = out();
  k.process([[ones]], o2);
  assert.ok(o2[0][0].every((v) => Math.abs(v - 0.75) < 1e-6) && o2[0][1][5] === o2[0][0][5], 'Amplitude 0: steady middle of Out Min..Out Max; mono to both');
}

// Tremolo with Frequency Unit MIDI Pitch: audio-rate amplitude modulation at the note frequency
{
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'unit', value: 4 });
  m({ type: 'noteOn', id: 1, pitch: 69 }); // 440 Hz, sine
  const ones = new Float32Array(128).fill(1);
  const g = [];
  for (let b = 0; b < 375; b++) { // 1 s
    const o = [[new Float32Array(128), new Float32Array(128)]];
    k.process([[ones]], o);
    g.push(...o[0][0]);
  }
  let rises = 0;
  for (let j = 1; j < g.length; j++) if (g[j - 1] < 0.5 && g[j] >= 0.5) rises++;
  assert.ok(Math.abs(rises - 440) <= 1, `440 cycles a second (${rises})`);
  assert.ok(Math.min(...g) < 1e-3 && Math.max(...g) > 0.999, 'full swing');
}

// Slow Square / Saw tremolo: edges ramp over ~1 ms (no clicks); fast ones keep a recognisable shape
{
  for (const wave of [3, 2]) {
    const k = new Proc();
    const m = (data) => k.port.onmessage({ data });
    m({ type: 'param', id: 'wave', value: wave });
    m({ type: 'param', id: 'freq', value: 2 });
    const ones = new Float32Array(128).fill(1);
    const g = [];
    for (let b = 0; b < 375; b++) {
      const o = [[new Float32Array(128), new Float32Array(128)]];
      k.process([[ones]], o);
      g.push(...o[0][0]);
    }
    const maxStep = Math.max(...g.slice(1).map((v, j) => Math.abs(v - g[j])));
    assert.ok(maxStep < 1.1 / (0.001 * SR), `${wave === 3 ? 'Square' : 'Saw'}: edges take ~1 ms (max step ${maxStep})`);
    assert.ok(Math.min(...g) < 0.01 && Math.max(...g) > 0.99, 'still the full swing');
  }
}

console.log('lfo tests passed');
