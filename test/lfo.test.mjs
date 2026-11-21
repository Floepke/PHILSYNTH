// Run: node test/lfo.test.mjs   (runs the real LFO DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import lfo from '../src/modules/lfo.js';

const SR = 48000;
const Proc = await loadKernel('lfo.dsp.js', SR);

// On/Off pauses both control-rate and audio-rate LFOs without losing phase or random state.
for (const mode of [0, 1, 2]) for (const wave of [0, 1, 2, 3, 4, 5, 6]) {
  const k = new Proc();
  k.param('mode', mode);
  const m = (data) => k.port.onmessage({ data });
  const output = [[new Float32Array(128), new Float32Array(128)]];
  const input = mode ? [[Float32Array.from({ length: 128 }, (_, i) => Math.sin(i)),
    Float32Array.from({ length: 128 }, (_, i) => Math.cos(i) * 0.5)]] : [];
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
  assert.equal(k.value, null, 'Off emits no controller modulation');
  if (mode) {
    assert.deepEqual(output[0], input[0], 'Off bypasses audio without changing either channel');
    k.param('amp', 0);
    k.param('outMin', 100);
    k.param('outMax', 0);
    run();
    assert.deepEqual(output[0], input[0], 'Off ignores audio modulation settings');
    k.process([[input[0][0]]], output);
    assert.deepEqual(output[0][0], input[0][0]);
    assert.deepEqual(output[0][1], input[0][0], 'Off duplicates mono input to stereo unchanged');
    assert.equal(k.process([], output), false, 'Off with no audio input remains silent');
  }
  m({ type: 'param', id: 'phase', value: 0.2 });
  assert.equal(k.phase, phase, 'Phase controller does not discard remembered phase');
  m({ type: 'noteOn', id: 1, pitch: 60, phase: 0.3 });
  assert.equal(k.phase, 0.5, 'MIDI phase resets even while Off');
  assert.equal(k.value, null, 'MIDI phase reset does not enable controller output');
  run();
  assert.equal(k.phase, 0.5);
  m({ type: 'param', id: 'enabled', value: 1 });
  run();
  assert.ok(Math.abs(k.phase - (0.5 + 128 / SR)) < 1e-9, 'On resumes from stored phase');
}

// Off never changes routed controllers, including when browsing targets or changing depth settings.
{
  const { dspTestHost } = await import('./dsphost.mjs');
  const { PatchRuntime } = await import('../src/patch.js');
  const { dsp, graph, render, kernel } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const source = await root.addModule('LFO', { values: { enabled: 0 } });
  const target = await root.addModule('AMP', { values: { amp: 1.37, pan: 0.23, fine: 0.61 } });
  root.connect(source.id, target.id);
  const unchanged = { ...target.values };
  const graphValues = () => ({ ...graph.nodes.get(target.inst.node.h).values });
  const originalGraphValues = graphValues();
  for (const controller of [0, 1, 2, 3]) {
    root.setParam(source.id, 'outController', controller);
    root.setParam(source.id, 'outMin', 100);
    root.setParam(source.id, 'outMax', 100);
    root.setParam(source.id, 'amp', 0);
    root.setParam(source.id, 'outSmooth', 100);
    source.inst.noteOn(1, 60, 1, 0.25);
    render(10);
    assert.deepEqual(target.values, unchanged, 'Off leaves every selected target controller untouched');
    assert.deepEqual(graphValues(), originalGraphValues, 'Off leaves audio-thread controller values untouched too');
    assert.equal(kernel(source.inst.node).value, null);
  }
  root.setParam(source.id, 'outController', 1);
  root.setParam(source.id, 'outSmooth', 0);
  root.setParam(source.id, 'enabled', 1);
  render(10);
  assert.equal(target.values.amp, 4, 'On resumes controller modulation');
  root.setParam(source.id, 'enabled', 0);
  root.setParam(target.id, 'amp', 1.37);
  root.setParam(source.id, 'outMin', 0);
  root.setParam(source.id, 'outMax', 0);
  render(10);
  assert.equal(target.values.amp, 1.37, 'Off allows manual controller edits without reapplying modulation');
  root.setParam(source.id, 'outController', 2);
  const copy = await PatchRuntime.create(engine, dsp.destination);
  await copy.load(root.toJSON());
  render(10);
  assert.equal(copy.modules.get(target.id).values.pan, unchanged.pan, 'loading an Off LFO does not apply its routes');
  root.destroy();
  copy.destroy();
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
  assert.equal(lfo.def.params[9].id, 'enabled', 'On/Off keeps controller 9');
  assert.equal(lfo.def.params[10].id, 'mode', 'MODE is controller 10');
  assert.deepEqual(lfo.def.params[10].options,
    ['Controller Modulation', 'Amp (audio modulation)', 'Panning (audio modulation)']);
  assert.equal(lfo.values.mode, 0, 'default is Controller Modulation');
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
msg({ type: 'param', id: 'freq', value: 10 });
msg({ type: 'param', id: 'wave', value: 2 });
for (let b = 0; b < 100; b++) l.process([], [[new Float32Array(128)]]);
msg({ type: 'param', id: 'wave', value: 4 }); // Original Random
const start = values.length;
for (let b = 0; b < 3000; b++) l.process([], [[new Float32Array(128)]]); // 8 s = 80 cycles
const r = values.slice(start);

assert.ok(r.every((v) => v >= 0 && v <= 1), 'stays in 0..1');
const maxStep = Math.max(...r.slice(1).map((v, i) => Math.abs(v - r[i])));
// Smoothstep slope ≤ 1.5 per cycle; one post = 256 samples at 10 Hz.
assert.ok(maxStep < 1.5 * (256 * 10 / SR) + 1e-9, `smooth, no jumps (max step ${maxStep})`);
// a new target every cycle: the values at cycle boundaries differ and cover the range
const ends = r.filter((_, i) => i % 19 === 0);
assert.ok(Math.max(...r) - Math.min(...r) > 0.6, 'random targets spread over the range');
assert.ok(new Set(ends.map((v) => v.toFixed(3))).size > 30, 'keeps moving to new targets');

{
  assert.deepEqual(lfo.params[0].options, ['Sine', 'Triangle', 'Saw', 'Square', 'Random (smooth step)', 'Random (steps)', 'Random (linear)']);
  assert.equal(lfo.params[0].max, 6, 'append new waveforms without changing saved indices');
  const k = new Proc();
  k.param('wave', 4);
  k.from = 0.2; k.to = 0.8;
  k.phase = 0.25;
  assert.ok(Math.abs(k.at() - (0.2 + 0.6 * 0.15625)) < 1e-12, 'original Random keeps its smoothstep interpolation');
  k.param('wave', 6);
  k.from = 0.2; k.to = 0.8;
  for (const phase of [0, 0.25, 0.5, 0.75]) {
    k.phase = phase;
    assert.ok(Math.abs(k.at() - (0.2 + 0.6 * phase)) < 1e-12, 'Random (linear) interpolates in a straight line');
  }
  k.param('wave', 5);
  k.to = 0.8;
  k.phase = 0;
  k.param('freq', 2);
  k.advance(SR / 2 - 1);
  assert.equal(k.at(), 0.8, 'Random (steps) holds its value for the Frequency period');
  k.advance(1);
  assert.ok(k.phase < 1e-12, 'new step at the cycle boundary');
  assert.equal(k.at(), k.to, 'step changes immediately to the newly drawn target');
  assert.notEqual(k.to, 0.8, 'cycle chooses another random value');
  const target = k.to;
  k.advance(SR / 4);
  assert.equal(k.at(), target, 'no interpolation within a step');
  k.param('amp', 50); k.param('outMin', 20); k.param('outMax', 60);
  k.process([], [[new Float32Array(128)]]);
  assert.ok(Math.abs(k.meter - (20 + 40 * (0.5 + (target - 0.5) * 0.5))) < 1e-10, 'plot reports actual mapped DSP output');
}

// Live plot receives actual graph reports, stays bounded, and unsubscribes when the panel closes.
{
  const { dspTestHost } = await import('./dsphost.mjs');
  const { dsp, render, graph } = dspTestHost();
  const inst = lfo.create(null, lfo, { dsp });
  inst.setParam('wave', 2);
  inst.setParam('amp', 50);
  inst.setParam('outMin', 20);
  inst.setParam('outMax', 60);
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalObserver = globalThis.ResizeObserver;
  let disconnected = false;
  const strokes = [];
  const context = Object.fromEntries(['setTransform', 'clearRect', 'beginPath', 'stroke'].map(id => [id, () => {}]));
  context.moveTo = context.lineTo = (x, y) => strokes.push([x, y]);
  globalThis.document = { createElement: tag => ({
    tag, children: [], isConnected: true, clientWidth: 300, clientHeight: 100,
    append(...children) { this.children.push(...children); },
    setAttribute() {}, getContext: () => context,
  }) };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected = true; } };
  try {
    const view = lfo.view({ inst }, { color: '#05a6de' });
    render(10);
    assert.ok(inst.signal >= 0.3 && inst.signal < 0.31, 'display receives Amplitude / Out Min / Out Max from DSP without cables');
    const [wrap, info] = view.el.children;
    assert.match(info.textContent, /Live output: 30\.\d %/);
    assert.equal(wrap.children[0].width, 600, 'plot uses HiDPI sizing');
    render(2500);
    strokes.length = 0;
    view.refresh();
    assert.ok(strokes.length < 4000, 'plot retains only the last five seconds');
    assert.ok(strokes.every(([x, y]) => x >= -1e-8 && x <= 300 && y >= 6 && y <= 94 || y === 0 || y === 100), 'plot stays within its canvas');
    view.el.isConnected = false;
    render(1);
    assert.equal(dsp.clocks.size, 0, 'closing the panel stops its audio-clock subscription');
    assert.ok(disconnected, 'closing the panel disconnects its ResizeObserver');
    inst.destroy();
    assert.equal(graph.meters.size, 0, 'destroying the LFO removes its meter');
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.ResizeObserver = originalObserver;
  }
}

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
  k.param('mode', 1);
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
  k.param('mode', 1);
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
    k.param('mode', 1);
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

// Controller mode ignores audio; panning preserves stereo at center and mutes the opposite side.
{
  const k = new Proc();
  const input = [[new Float32Array(128).fill(1), new Float32Array(128).fill(0.5)]];
  const output = [[new Float32Array(128), new Float32Array(128)]];
  assert.equal(k.process(input, output), false, 'default mode never emits input audio');
  k.param('mode', 2);
  k.param('amp', 0);
  assert.equal(k.process(input, output), true);
  assert.ok(output[0][0].every(v => v === 1), 'center keeps left unchanged');
  assert.ok(output[0][1].every(v => v === 0.5), 'center keeps right unchanged');
  for (const [pan, left, right] of [[0, 1, 0], [25, 1, 0.25], [75, 0.5, 0.5], [100, 0, 0.5]]) {
    k.param('outMin', pan);
    k.param('outMax', pan);
    k.process(input, output);
    assert.ok(output[0][0].every(v => v === left), `${pan} % pan: left`);
    assert.ok(output[0][1].every(v => v === right), `${pan} % pan: right`);
  }
  k.param('amp', 100);
  k.param('outMin', 0);
  k.param('outMax', 100);
  k.param('wave', 1);
  k.param('freq', SR / 128 / 2);
  k.restart(0);
  k.process([[input[0][0]]], output);
  for (let j = 0; j < 128; j++) {
    const pan = j / 128;
    assert.ok(Math.abs(output[0][0][j] - Math.min(1, 2 * (1 - pan))) < 1e-6);
    assert.ok(Math.abs(output[0][1][j] - Math.min(1, 2 * pan)) < 1e-6, 'mono pans per sample to both channels');
  }
  assert.equal(k.process([], output), false, 'audio mode with no input is silent');
}

// Audio modes smooth the mapped gain/pan with the same time constant as controller routes.
for (const sr of [44100, 48000, 96000]) for (const mode of [1, 2]) {
  globalThis.sampleRate = sr;
  try {
    const k = new Proc();
    k.param('mode', mode);
    k.param('freq', 0);
    k.param('amp', 0);
    k.param('outMin', 0);
    k.param('outMax', 0);
    k.param('outSmooth', 100);
    const input = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
    const output = [[new Float32Array(128), new Float32Array(128)]];
    const render = () => k.process(input, output);
    const value = () => mode === 1 ? output[0][0][127] : output[0][1][127] / 2;
    render();
    assert.equal(value(), 0, 'first audio value starts at its mapped target');
    k.param('outMax', 100);
    k.param('outMin', 100);
    const blocks = Math.round(sr * 0.1 / 128);
    for (let b = 0; b < blocks; b++) render();
    const expected = 1 - Math.exp(-blocks * 128 / (sr * 0.1));
    if (mode === 1) assert.ok(Math.abs(value() - expected) < 1e-6);
    else {
      assert.equal(output[0][1][127], 1, 'right channel reaches full gain');
      assert.ok(Math.abs(output[0][0][127] - 2 * (1 - expected)) < 1e-6, 'pan is smoothed before stereo mapping');
    }
    const previous = k.audioValue;
    k.param('enabled', 0);
    render();
    assert.equal(k.audioValue, previous, 'Off pauses the smoother');
    assert.ok(output[0][0].every(v => v === 1) && output[0][1].every(v => v === 1), 'Off bypasses audio');
    k.param('enabled', 1);
    render();
    assert.ok(k.audioValue > previous && k.audioValue < 1, 'On resumes smoothing');
    k.param('outSmooth', 0);
    render();
    assert.equal(k.audioValue, 1, 'turning smoothing off immediately applies the target');
    k.param('outSmooth', 100);
    k.param('outMin', 0);
    k.param('outMax', 0);
    render();
    assert.ok(k.audioValue < 1 && k.audioValue > 0.95, 'turning smoothing back on continues from the last value');
    k.process([], output);
    render();
    assert.equal(k.audioValue, 0, 'reconnected audio starts at the current mapped value');
  } finally { globalThis.sampleRate = SR; }
}

// Random steps and MIDI phase resets are filtered, including single-sample feedback rendering.
for (const mode of [1, 2]) {
  const k = new Proc();
  k.param('mode', mode);
  k.param('wave', 5);
  k.param('freq', 0);
  k.param('outSmooth', 100);
  k.to = 0;
  const one = new Float32Array([1]);
  const output = [[new Float32Array(1), new Float32Array(1)]];
  k.process([[one]], output);
  k.to = 1;
  k.process([[one]], output);
  const first = 1 - Math.exp(-1 / (SR * 0.1));
  assert.ok(Math.abs(k.audioValue - first) < 1e-12, 'a stepped waveform changes smoothly per sample');
  k.param('wave', 1);
  k.message({ type: 'noteOn', id: 1, pitch: 60, phase: 0.5 });
  k.process([[one]], output);
  assert.ok(Math.abs(k.audioValue - (1 - Math.exp(-2 / (SR * 0.1)))) < 1e-12, 'MIDI retrigger does not reset the smoother');
}

// Out Smooth may also be driven by another modulator through the graph.
{
  const { dspTestHost } = await import('./dsphost.mjs');
  const { Kernel } = await import('../src/dsp/kernel.js');
  const { KERNELS } = await import('../src/dsp/kernels.js');
  class Ones extends Kernel {
    process(_inputs, outputs) { outputs[0][0].fill(1); outputs[0][1].fill(1); return true; }
  }
  KERNELS.lfoTestOnes = Ones;
  try {
    const { dsp, graph, render, kernel } = dspTestHost();
    const source = dsp.create('lfoTestOnes');
    const lfo = dsp.create('lfo');
    const mod = dsp.create('lfo');
    source.connect(lfo);
    lfo.connect(dsp.destination);
    lfo.param('mode', 1);
    lfo.param('amp', 0);
    lfo.param('outMin', 0);
    lfo.param('outMax', 0);
    mod.param('amp', 0);
    mod.param('outMin', 2);
    mod.param('outMax', 2);
    mod.routes([{ to: lfo.h, id: 'outSmooth', min: 0, max: 5000 }]);
    render(2);
    assert.equal(graph.nodes.get(lfo.h).depth.outSmooth, 100);
    assert.equal(kernel(lfo).outSmooth, 100);
    lfo.param('outMin', 100);
    lfo.param('outMax', 100);
    const { L } = render();
    assert.ok(L[0] > 0 && L[0] < 0.001 && L[127] < 0.03, 'graph modulation reaches per-sample audio smoothing');
  } finally { delete KERNELS.lfoTestOnes; }
}

// play from start: periodic waves restart at Phase, Random waves keep running
for (const wave of [0, 1, 2, 3, 4, 5, 6]) {
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'wave', value: wave });
  m({ type: 'param', id: 'phase', value: 0.25 });
  const output = [[new Float32Array(128), new Float32Array(128)]];
  for (let i = 0; i < 100; i++) k.process([], output);
  const before = k.phase;
  k.songStart();
  if (wave < 4) assert.equal(k.phase, 0.25, `wave ${wave} restarts at Phase`);
  else assert.equal(k.phase, before, `Random wave ${wave} is not reset`);
}

console.log('lfo tests passed');
