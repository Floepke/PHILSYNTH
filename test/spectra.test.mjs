import assert from 'node:assert/strict';
import spectra from '../src/modules/spectra.js';
import {
  SPECTRA_ROOT_HZ, SPECTRA_SAMPLE_SECONDS, SPECTRA_PARTIALS, SPECTRA_RENDER_RATE,
  defaultSpectraState, normalizeSpectraState, generateSpectraSample, randomSpectraPhases,
} from '../src/modules/spectra.sample.js';
import { attackLevel, decayLevel, releaseLevel } from '../src/modules/adsrcurve.js';
import { KERNELS } from '../src/dsp/kernels.js';
import { SPECS } from '../src/dsp/wasm.js';
import { loadKernel } from './kernelproc.mjs';
import { levelsToWaveform, waveformToLevels, WAVE_SAMPLES } from '../src/modules/spectrawave.js';

{
  const samples = (fn) => Float64Array.from({ length: WAVE_SAMPLES }, (_, i) => fn(2 * Math.PI * i / WAVE_SAMPLES));
  const expected = Array(SPECTRA_PARTIALS).fill(0);
  expected[0] = 50;
  expected[127] = 25;
  assert.deepEqual(waveformToLevels(samples(t => 0.1 + 0.5 * Math.cos(t) + 0.25 * Math.sin(128 * t + 0.2))), expected,
    'conversion ignores DC and phase while retaining the highest overtone');
  const preview = levelsToWaveform(expected);
  const expectedPreview = samples(t => 0.5 * Math.sin(t) + 0.25 * Math.sin(128 * t));
  assert.ok(preview.every((v, i) => Math.abs(v - expectedPreview[i]) < 1e-10));
  assert.deepEqual(waveformToLevels(preview), expected, 'reconstructed wave keeps the Amp levels');
  const scaled = waveformToLevels(samples(t => 2 * Math.sin(t) + Math.cos(2 * t)));
  assert.deepEqual(scaled.slice(0, 3), [100, 50, 0], 'over-range harmonics are scaled together');
}

const SR = 8000;
const length = SR * SPECTRA_SAMPLE_SECONDS;
const state = defaultSpectraState();
state.levels.fill(0);
state.levels[0] = 20;
state.detunes[0] = 17.3;
const phases = Array(SPECTRA_PARTIALS).fill(0);
phases[0] = 25;
const sample = generateSpectraSample(SR, state.levels, state.detunes, phases);
assert.equal(sample.length, SR * 15, 'finished loop lasts 15 seconds');
const frequency = 1.173 * SPECTRA_ROOT_HZ;
const raw = (i) => 0.2 * Math.sin(2 * Math.PI * (frequency * i / SR + 0.25));
for (const i of [0, 1, SR * 7, length / 2, length - 1]) {
  const t = i / length;
  const expected = raw(i + length) * (1 - t) + raw(i) * t;
  assert.ok(Math.abs(sample[i] - expected) < 1e-6, `full-length linear overlap at sample ${i}`);
}
const seamStep = raw(length) - raw(length - 1);
assert.ok(Math.abs((sample[0] - sample.at(-1)) - seamStep) < 2e-6, 'loop boundary continues the sine without a discontinuity');

for (const seconds of [1, 3.7, 16]) {
  const data = generateSpectraSample(SR, state.levels, state.detunes, phases, seconds);
  assert.equal(data.length, Math.round(SR * seconds), 'requested duration determines PCM length');
  for (const i of [0, Math.floor(data.length / 2), data.length - 1]) {
    const t = i / data.length;
    assert.ok(Math.abs(data[i] - (raw(i + data.length) * (1 - t) + raw(i) * t)) < 1e-6, 'variable duration preserves full-length overlap');
  }
}
for (const seconds of [0, 0.9, 16.1, NaN, Infinity]) {
  assert.throws(() => generateSpectraSample(SR, state.levels, state.detunes, phases, seconds), RangeError);
}

const silent = defaultSpectraState();
silent.levels.fill(0);
assert.ok(generateSpectraSample(SR, silent.levels, silent.detunes).every((v) => v === 0), 'zero amplitudes produce silence');
silent.levels[127] = 100;
assert.ok(generateSpectraSample(SR, silent.levels, silent.detunes).every((v) => v === 0), 'partials above Nyquist are omitted');
const high = generateSpectraSample(SPECTRA_RENDER_RATE, silent.levels, silent.detunes);
assert.ok(high.some((v) => v !== 0), '128th partial is retained in the oversampled table');
assert.ok(high.every((v) => Number.isFinite(v) && Math.abs(v) <= 0.900001), 'sample stays finite and peak-limited');
const normalized = normalizeSpectraState({ levels: [200, NaN], detunes: [-200], phases: [125] });
assert.equal(normalized.levels[0], 100);
assert.equal(normalized.detunes[0], -100);
assert.ok(!Object.hasOwn(normalized, 'phases'), 'saved manual phases are discarded');
assert.equal(normalized.levels.length, 128);
assert.equal(normalized.levels[1], defaultSpectraState().levels[1]);
assert.deepEqual(normalizeSpectraState(JSON.parse(JSON.stringify(state))), state, 'Amp and Pitch survive serialization');
assert.throws(() => generateSpectraSample(0, state.levels, state.detunes), RangeError);
assert.throws(() => generateSpectraSample(SR, [20], state.detunes), TypeError);
assert.throws(() => generateSpectraSample(SR, state.levels, state.detunes, [NaN, ...phases.slice(1)]), TypeError);
const oldGraph = { levels: Array(64).fill(25), detunes: Array(64).fill(-12), phases: Array(64).fill(50) };
const expanded = normalizeSpectraState(oldGraph);
for (const key of ['levels', 'detunes']) {
  assert.deepEqual(expanded[key].slice(0, 64), oldGraph[key], 'existing 64-overtone settings survive expansion');
  assert.ok(expanded[key].slice(64).every((v) => v === 0), 'new overtone slots start silent and unshifted');
}

{
  const previousRandom = Math.random;
  let draws = 0;
  Math.random = () => (++draws - 0.5) / SPECTRA_PARTIALS;
  try {
    const random = randomSpectraPhases();
    assert.equal(draws, SPECTRA_PARTIALS, 'each overtone, including silent ones, gets an independent phase');
    assert.ok(random.every((v) => v >= 0 && v < 100));
    assert.equal(new Set(random).size, SPECTRA_PARTIALS);
    assert.deepEqual(state, normalizeSpectraState(state), 'random phases do not become saved graph edits');
  } finally { Math.random = previousRandom; }
}

const Proc = await loadKernel('spectra.dsp.js', SR);
assert.equal(KERNELS.spectra, Proc.Kernel);
assert.ok(Object.hasOwn(SPECS, 'spectra'), 'SPECTRA has a native playback twin');
const kernel = new Proc();
kernel.message({ type: 'sample', rate: SR, data: sample });
kernel.noteOn('note', 60, 1, 0);
const left = new Float32Array(128);
const right = new Float32Array(128);
const outputs = [[left, right]];
kernel.process([], outputs);
assert.ok(left.some((v) => v !== 0), 'MIDI note renders loop audio');
assert.deepEqual(left, right);
assert.equal(kernel.speedOf(60), 1, 'C4 plays at exact reference pitch');
assert.equal(kernel.speedOf(72), 2, 'octave transposition doubles playback speed');
kernel.voices[0].pos = length - 64;
kernel.process([], outputs);
assert.equal(kernel.voices[0].pos, 64, 'playback wraps the entire 15-second table');
kernel.noteMod('note', 60, 0.5);
kernel.process([], outputs);
assert.ok(kernel.voices[0].vel > 0.5 && kernel.voices[0].vel < 0.55, 'velocity glides');
kernel.message({ type: 'sample', rate: SR, data: sample.slice() });
kernel.process([], outputs);
assert.equal(kernel.oldSample.data, sample, 'old table retained during replacement');
assert.ok(kernel.sampleBlend > 0 && kernel.sampleBlend < 1);
kernel.process([], outputs);
assert.equal(kernel.oldSample, null, 'old sample is released after the swap');
kernel.noteOff('note');
for (let i = 0; i < 3; i++) kernel.process([], outputs);
assert.equal(kernel.voices[0].stage, 0);

// A constant table isolates the audible envelope and Gain from waveform phase.
const envKernel = new Proc();
envKernel.message({ type: 'sample', rate: SR, data: new Float32Array(length).fill(1) });
for (const [id, value] of Object.entries({
  attack: 0.1, decay: 0.2, sustain: 0.4, release: 0.2,
  atkCurve: 100, decCurve: -50, relCurve: 100, gain: 0.3,
})) envKernel.param(id, value);
envKernel.noteOn('env', 60, 1, 0);
const tick = () => {
  const out = new Float32Array(1);
  envKernel.process([], [[out]]);
  return out[0];
};
for (let i = 1; i <= 800; i++) {
  const value = tick();
  if (i === 400) assert.ok(Math.abs(value - 0.3 * attackLevel(0.5, 100)) < 1e-6, 'audible curved attack and Gain match OSC math');
}
for (let i = 1; i <= 1600; i++) {
  const value = tick();
  if (i === 800) assert.ok(Math.abs(value - 0.3 * decayLevel(0.5, -50, 0.4)) < 0.001, 'audible inverse decay matches OSC');
}
tick();
envKernel.noteOff('env');
const releaseStart = envKernel.voices[0].l0;
for (let i = 1; i <= 1601; i++) {
  const value = tick();
  if (i === 800) assert.ok(Math.abs(value - 0.3 * releaseLevel(0.5, 100, releaseStart)) < 1e-6, 'curved release matches OSC');
}
assert.equal(envKernel.voices[0].stage, 0);
envKernel.param('gain', 0);
envKernel.noteOn('muted', 60, 1, 0);
assert.equal(tick(), 0, 'Gain zero mutes playback');

// Staged phases wait for the oldest voice's wrap, with a continuous, pitch-dependent fade.
for (const pitch of [48, 60, 72]) {
  const cycleKernel = new Proc();
  const current = new Float32Array(length).fill(0.5);
  const next = new Float32Array(length).fill(-0.5);
  cycleKernel.message({ type: 'sample', rate: SR, data: current });
  cycleKernel.noteOn('oldest', pitch, 1, 0);
  cycleKernel.process([], outputs);
  cycleKernel.message({ type: 'nextSample', rate: SR, data: next });
  cycleKernel.noteOn('younger', pitch, 0, 0.9999);
  cycleKernel.process([], outputs);
  assert.equal(cycleKernel.meter, 0, 'a younger voice cannot consume the next phase frame');
  assert.equal(cycleKernel.sample.data, current, 'staging leaves the current waveform unchanged');
  cycleKernel.voices[0].pos = length - cycleKernel.speedOf(pitch);
  cycleKernel.process([], outputs);
  assert.equal(cycleKernel.meter, 1, 'oldest voice consumes a frame at its loop boundary');
  assert.equal(cycleKernel.sample.data, next);
  assert.equal(cycleKernel.nextSample, null);
  cycleKernel.message({ type: 'phaseSample', frame: 1, rate: SR, data: next });
  assert.equal(cycleKernel.pendingSample, null, 'a copy that already consumed the shared frame does not queue a duplicate fade');
  const fadeSamples = Math.round(Math.min(4, 15 / (2 ** ((pitch - 60) / 12)) / 4) * SR);
  assert.equal(cycleKernel.sampleBlendStep, 1 / fadeSamples, 'fade fits the pitch-dependent cycle');
  for (let i = 1; i < left.length; i++) {
    assert.ok(Math.abs(left[i] - left[i - 1] + cycleKernel.p.gain / fadeSamples) < 1e-7, 'random-frame transition follows a continuous linear fade');
  }
  const edit = new Float32Array(length).fill(0.2);
  cycleKernel.message({ type: 'sample', rate: SR, data: edit });
  assert.equal(cycleKernel.sample.data, next, 'editing does not interrupt an active random-phase fade');
  assert.equal(cycleKernel.pendingSample.data, edit);
  for (let i = 0; i < Math.ceil((fadeSamples + SR * 0.02) / 128) + 2; i++) cycleKernel.process([], outputs);
  assert.equal(cycleKernel.sample.data, edit, 'queued edit takes effect after the cycle fade');
  assert.equal(cycleKernel.oldSample, null);
  assert.equal(cycleKernel.pendingSample, null);
}

// Changing duration preserves the old read position while the new loop wraps independently.
{
  const k = new Proc();
  const old = Float32Array.from({ length: SR * 16 }, (_, i) => 0.3 * Math.sin(i * 0.17));
  const short = Float32Array.from({ length: SR }, (_, i) => 0.2 * Math.cos(i * 0.11));
  k.message({ type: 'sample', rate: SR, data: old });
  k.noteOn('held', 60, 1, 0.9);
  for (let i = 0; i < 3; i++) k.process([], outputs);
  const oldPos = k.voices[0].pos;
  k.message({ type: 'sample', rate: SR, data: short });
  assert.equal(k.voices[0].oldPos, oldPos);
  assert.equal(k.voices[0].pos, oldPos % short.length);
  const single = new Float32Array(1);
  k.process([], [[single]]);
  const blend = 1 / Math.round(SR * 0.02);
  const expected = (old[oldPos] * (1 - blend) + short[oldPos % short.length] * blend) * k.p.gain;
  assert.ok(Math.abs(single[0] - expected) < 1e-7, 'shortening starts the fade from the uninterrupted old waveform');
  k.message({ type: 'sample', rate: SR, data: old });
  for (let i = 0; i < 100; i++) {
    k.process([], outputs);
    assert.ok(left.every(Number.isFinite), 'shortening, queued expansion and wrapping stay finite');
  }
  assert.equal(k.sample.data.length, SR * 16);
  assert.equal(k.oldSample, null);
}

const sent = [];
const node = { send: (m) => sent.push(m), destroy() {} };
const instance = spectra.create({ sampleRate: SR }, spectra, { dsp: { create: () => node } });
const entry = { state: defaultSpectraState() };
instance.attach(entry);
instance.setState(state);
assert.equal(sent.filter((m) => m.type === 'sample').length, 2, 'saved graph is applied synchronously during loading');
assert.equal(sent.at(-1).rate, SPECTRA_RENDER_RATE);
assert.equal(sent.at(-1).data.length, SPECTRA_RENDER_RATE * 15);
assert.equal(sent.at(-1).type, 'nextSample', 'saved graph prepares a fresh frame ahead of playback');
assert.ok(sent.at(-1).data.some((v, i) => v !== sent.at(-2).data[i]), 'current and staged frames use different phases');
instance.setParam('gain', 0.2);
instance.setParam('atkCurve', -50);
instance.noteOn('module-note', 60, 1);
assert.equal(sent.at(-1).type, 'noteOn');
const changed = normalizeSpectraState(state);
changed.levels[0] = 50;
instance.setState(changed);
changed.detunes[0] = 60;
instance.setState(changed);
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(sent.filter((m) => m.type === 'sample').length, 3, 'graph edits coalesce; envelope changes do not rebuild');
assert.equal(sent.at(-1).type, 'nextSample', 'edited graph also prepares its next phase frame');
const stagedBefore = sent.filter((m) => m.type === 'nextSample').length;
const stagedFrame = sent.filter((m) => m.type === 'nextSample').at(-1).frame;
node.onMeter(stagedFrame);
node.onMeter(stagedFrame);
assert.equal(sent.filter((m) => m.type === 'nextSample').length, stagedBefore + 1, 'consuming a frame prepares exactly one successor');
assert.deepEqual(changed, normalizeSpectraState(changed), 'automatic phase refresh preserves Amp and Pitch');
instance.restoreValues({ amp1: 37, detune1: -25 });
assert.equal(entry.state.levels[0], 37, 'old prototype amplitudes migrate into saved graph state');
assert.equal(entry.state.detunes[0], -25);
assert.equal(entry.state.levels.length, SPECTRA_PARTIALS);
instance.destroy();

const playbackMessages = [];
const playbackInstance = spectra.create({ sampleRate: SR }, spectra, {
  dsp: { controlOnly: true, create: () => ({ send: (m) => playbackMessages.push(m), destroy() {} }) },
});
playbackInstance.setState?.(state);
playbackInstance.setState?.(changed);
playbackInstance.setParam('sampleLength', 1);
playbackInstance.noteOn('playback', 60, 1);
assert.deepEqual(playbackMessages.map((m) => m.type), ['param', 'noteOn'], 'audio-thread playback binds the existing loop without generation or timers');
playbackInstance.destroy();

const offlineMessages = [];
const offline = spectra.create({ sampleRate: SR }, spectra, {
  dsp: { clockBatch: true, onClock: () => () => {}, create: () => ({ send: (m) => offlineMessages.push(m), destroy() {} }) },
});
offline.setState(state);
const beforeEdit = offlineMessages.length;
offline.setState(changed);
assert.equal(offlineMessages.length, beforeEdit + 2, 'offline edits synchronously rebuild current and upcoming frames');
assert.equal(offlineMessages.at(-2).type, 'sample');
assert.equal(offlineMessages.at(-1).type, 'nextSample');
offline.setParam('sampleLength', 1);
assert.equal(offlineMessages.filter(m => m.type === 'sample').at(-1).data.length, SPECTRA_RENDER_RATE);
offline.onModulated('sampleLength', 16);
assert.equal(offlineMessages.at(-1).data.length, SPECTRA_RENDER_RATE * 16, 'offline modulation rebuilds at the requested length');
assert.throws(() => offline.setParam('sampleLength', NaN), RangeError);
offline.destroy();

const hadWorker = Object.hasOwn(globalThis, 'Worker');
const previousWorker = globalThis.Worker;
let worker;
const workers = [];
globalThis.Worker = class {
  constructor() { worker = this; workers.push(this); this.requests = []; this.terminated = false; }
  postMessage(message) { this.requests.push(message); }
  terminate() { this.terminated = true; }
};
try {
  const messages = [];
  const asyncNode = { send: (m) => messages.push(m), destroy() {} };
  const asyncInstance = spectra.create({ sampleRate: SR }, spectra, {
    dsp: { create: () => asyncNode },
  });
  asyncInstance.setState(defaultSpectraState());
  asyncInstance.setState(state);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const first = worker.requests[0];
  const newer = normalizeSpectraState(state);
  newer.detunes[0] = 75;
  asyncInstance.setState(newer);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(worker.requests.length, 1, 'only one expensive render can be in flight');
  newer.detunes[0] = 80;
  asyncInstance.setState(newer);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(worker.requests.length, 1, 'further edits overwrite the pending request instead of queuing builds');
  worker.onmessage({ data: { revision: first.revision, mode: first.mode, sample } });
  assert.equal(messages.filter((m) => m.type === 'sample').length, 1, 'outdated worker results cannot replace the loop');
  const latest = worker.requests[1];
  assert.equal(latest.detunes[0], 80, 'worker receives only the latest pitch graph');
  assert.equal(latest.mode, 'current', 'edits take priority over upcoming random frames');
  worker.onmessage({ data: { revision: latest.revision, mode: latest.mode, sample } });
  assert.equal(messages.filter((m) => m.type === 'sample').length, 2, 'latest worker result reaches the DSP');
  const nextRequest = worker.requests[2];
  assert.equal(nextRequest.mode, 'next');
  assert.deepEqual(nextRequest.detunes, latest.detunes, 'next frame retains the edited pitch graph');
  assert.notDeepEqual(nextRequest.phases, latest.phases, 'next frame has independently randomized phases');
  worker.onmessage({ data: { revision: nextRequest.revision, mode: nextRequest.mode, sample } });
  assert.equal(messages.at(-1).type, 'nextSample');
  asyncNode.onMeter(1);
  assert.equal(worker.requests.length, 4, 'worker prepares another frame after consumption');
  asyncInstance.destroy();
  assert.ok(worker.terminated, 'module destruction stops its worker');
  worker.onmessage({ data: { revision: nextRequest.revision, mode: 'next', sample } });
  assert.equal(messages.filter((m) => m.type === 'nextSample').length, 1, 'late results cannot reach a destroyed module');

  const shared = new Map();
  const copies = Array.from({ length: 16 }, () => {
    const messages = [];
    const node = { send: (m) => messages.push(m), destroy() {} };
    const inst = spectra.create({ sampleRate: SR }, spectra, { shared, dsp: { create: () => node } });
    inst.setState(state);
    return { node, inst, messages };
  });
  const sharedWorker = worker;
  assert.equal(workers.length, 2, '16 PATCH copies create one sample-generation worker');
  assert.equal(sharedWorker.requests.length, 1, 'copies do not request independent phase frames');
  const currents = copies.map((copy) => copy.messages.filter((m) => m.type === 'sample').at(-1).data);
  assert.equal(new Set(currents).size, 1, 'all copies reuse the exact same current PCM');
  const currentIds = copies.map((copy) => copy.messages.filter((m) => m.type === 'sample').at(-1).sampleId);
  assert.ok(Number.isSafeInteger(currentIds[0]) && currentIds[0] > 0);
  assert.equal(new Set(currentIds).size, 1, 'all copies identify the same immutable PCM');
  const reply = (data) => {
    const request = sharedWorker.requests.at(-1);
    sharedWorker.onmessage({ data: { revision: request.revision, mode: request.mode, sample: data } });
  };
  const firstFrame = new Float32Array(SPECTRA_RENDER_RATE * 15).fill(0.1);
  reply(firstFrame);
  assert.ok(copies.every((copy) => copy.messages.at(-1).data === firstFrame && copy.messages.at(-1).frame === 1));
  const firstFrameId = copies[0].messages.at(-1).sampleId;
  assert.notEqual(firstFrameId, currentIds[0], 'new phases get a new PCM identity');
  assert.ok(copies.every(copy => copy.messages.at(-1).sampleId === firstFrameId));
  copies[5].node.onMeter(1);
  assert.equal(sharedWorker.requests.length, 2, 'one copy starts one shared phase refresh');
  assert.ok(copies.every((copy, i) => i === 5 || copy.messages.at(-1).type === 'phaseSample' && copy.messages.at(-1).data === firstFrame));
  assert.ok(copies.every(copy => copy.messages.at(-1).sampleId === firstFrameId), 'phase adoption keeps the staged PCM identity');
  const secondFrame = new Float32Array(SPECTRA_RENDER_RATE * 15).fill(0.2);
  reply(secondFrame);
  assert.notEqual(copies[0].messages.at(-1).sampleId, firstFrameId);
  copies[7].node.onMeter(1);
  assert.equal(sharedWorker.requests.length, 2, 'late reports cannot consume the newly staged frame');
  copies[11].node.onMeter(2);
  assert.equal(sharedWorker.requests.length, 3);
  reply(new Float32Array(SPECTRA_RENDER_RATE * 15).fill(0.3));
  copies[0].inst.setState(changed);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sharedWorker.requests.at(-1).mode, 'current');
  reply(new Float32Array(SPECTRA_RENDER_RATE * 15).fill(0.4));
  const latestFrame = new Float32Array(SPECTRA_RENDER_RATE * 15).fill(0.5);
  reply(latestFrame);
  assert.equal(copies[0].messages.at(-1).frame, 4, 'graph edits allocate a fresh phase ID instead of reusing an unacknowledged frame');
  copies[1].node.onMeter(3);
  assert.equal(sharedWorker.requests.length, 5, 'a delayed pre-edit report cannot consume the edited next sample');
  copies[1].node.onMeter(4);
  assert.equal(sharedWorker.requests.length, 6);
  for (const copy of copies.slice(0, -1)) copy.inst.destroy();
  assert.equal(sharedWorker.terminated, false, 'removing copies keeps the shared generator alive');
  const joiningMessages = [];
  const joining = spectra.create({ sampleRate: SR }, spectra, {
    shared, dsp: { create: () => ({ send: (m) => joiningMessages.push(m), destroy() {} }) },
  });
  joining.setState(changed);
  assert.equal(joiningMessages[0].data, latestFrame, 'a newly added copy reuses the latest shared phase');
  assert.equal(joiningMessages[0].sampleId, copies.at(-1).messages.findLast(m => m.type === 'phaseSample').sampleId,
    'a newly added copy reuses the latest shared sample identity');
  assert.equal(workers.length, 2);
  copies.at(-1).inst.destroy();
  assert.equal(sharedWorker.terminated, false);
  joining.destroy();
  assert.equal(sharedWorker.terminated, true, 'last copy releases the worker and shared PCM');
  assert.equal(shared.size, 0);
  copies[0].inst.destroy();
  const freshMessages = [];
  const fresh = spectra.create({ sampleRate: SR }, spectra, {
    shared, dsp: { create: () => ({ send: (m) => freshMessages.push(m), destroy() {} }) },
  });
  assert.equal(workers.length, 3, 'removed modules cannot leave stale shared generators');
  fresh.destroy();

  {
    const shared = new Map(), messages = [];
    const make = () => spectra.create({ sampleRate: SR }, spectra, {
      shared, dsp: { create: () => ({ send: m => messages.push(m), destroy() {} }) },
    });
    const a = make();
    a.setParam('sampleLength', 1);
    a.setState(state);
    assert.equal(messages.filter(m => m.type === 'sample').at(-1).data.length, SPECTRA_RENDER_RATE, 'saved length is applied synchronously before state loading');
    const b = make();
    b.setParam('sampleLength', 1);
    b.setState(state);
    const w = worker;
    const reply = (request) => w.onmessage({ data: {
      revision: request.revision, mode: request.mode,
      sample: new Float32Array(Math.round(request.rate * request.seconds)),
    } });
    a.setParam('sampleLength', 16);
    b.setParam('sampleLength', 16);
    await new Promise(resolve => setTimeout(resolve, 100));
    reply(w.requests[0]);
    assert.equal(w.requests.length, 2, 'shared copies queue a single length rebuild');
    assert.equal(w.requests[1].seconds, 16);
    reply(w.requests[1]);
    assert.equal(w.requests[2].seconds, 16, 'upcoming phases use the new length too');
    reply(w.requests[2]);
    assert.ok(messages.filter(m => m.type === 'nextSample').every(m => m.data.length === SPECTRA_RENDER_RATE * 16));
    a.onModulated('sampleLength', 2.5);
    b.onModulated('sampleLength', 2.5);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(w.requests.length, 4, 'modulation updates the one shared generator');
    assert.equal(w.requests[3].seconds, 2.5);
    a.destroy(); b.destroy();
  }

  const previousIsolated = globalThis.crossOriginIsolated;
  globalThis.crossOriginIsolated = true;
  const isolatedCopies = [];
  try {
    const shared = new Map();
    for (let i = 0; i < 2; i++) {
      const messages = [];
      const inst = spectra.create({ sampleRate: SR }, spectra, {
        shared, dsp: { create: () => ({ send: (m) => messages.push(m), destroy() {} }) },
      });
      inst.setState(defaultSpectraState());
      isolatedCopies.push({ inst, messages });
    }
    const transported = isolatedCopies.map(copy => structuredClone(copy.messages[0]).data);
    assert.ok(transported.every(data => data.buffer instanceof SharedArrayBuffer));
    transported[0][0] = 0.123;
    assert.equal(transported[1][0], transported[0][0], 'separate message batches reuse the same physical PCM buffer');
  } finally {
    isolatedCopies.forEach(copy => copy.inst.destroy());
    if (previousIsolated === undefined) delete globalThis.crossOriginIsolated;
    else globalThis.crossOriginIsolated = previousIsolated;
  }
} finally {
  if (hadWorker) globalThis.Worker = previousWorker;
  else delete globalThis.Worker;
}

// Waveform strokes write Amp only; Amp changes rebuild the reference waveform.
{
  let path;
  class Element extends EventTarget {
    constructor() {
      super();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.clientWidth = 0;
    }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getContext() {
      return {
        setTransform() {}, fillRect() {}, fillText() {}, stroke() {},
        beginPath() { path = []; }, moveTo(...p) { path.push(p); }, lineTo(...p) { path.push(p); },
      };
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    focus() {}
  }
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.ResizeObserver;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: () => new Element() };
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const entry = { state: normalizeSpectraState(state) };
    const before = structuredClone(entry.state);
    const edits = [];
    const editor = spectra.editor(entry, {
      color: spectra.color,
      beginEdit: () => edits.push('begin'),
      setState: (value) => { edits.push('state'); entry.state = normalizeSpectraState(value); },
      endEdit: () => edits.push('end'),
    });
    const [tabs, panel] = editor.el.children;
    const [canvas, tools] = panel.children;
    const [, valueLabel, reset] = tools.children;
    canvas.clientWidth = 562;
    canvas.clientHeight = 238;
    assert.deepEqual(tabs.children.map((button) => button.textContent), ['Amp', 'Pitch', 'Waveform']);
    tabs.children[1].dispatchEvent(new Event('click'));
    assert.equal(panel.attributes['aria-label'], 'Pitch overtone graph');
    const key = new Event('keydown', { cancelable: true });
    key.key = 'ArrowRight';
    tabs.children[1].dispatchEvent(key);
    assert.equal(panel.attributes['aria-label'], 'Waveform editor');
    tabs.children[2].dispatchEvent(key);
    assert.equal(panel.attributes['aria-label'], 'Amp overtone graph', 'keyboard navigation wraps after Waveform');
    assert.deepEqual(entry.state, before);
    assert.deepEqual(edits, [], 'switching graphs does not create state edits');

    tabs.children[2].dispatchEvent(new Event('click'));
    reset.dispatchEvent(new Event('click'));
    assert.ok(entry.state.levels.every(v => v === 0), 'clearing the waveform silences Amp');
    edits.length = 0;
    const pointer = (type, x, y) => canvas.dispatchEvent(Object.assign(new Event(type), { button: 0, clientX: x, clientY: y }));
    pointer('pointerdown', 40, 112);
    pointer('pointermove', 168, 12);
    pointer('pointermove', 424, 212);
    pointer('pointermove', 552, 112);
    pointer('pointerup', 552, 112);
    assert.ok(Math.abs(entry.state.levels[0] - 81.06) < 0.1, 'a drawn triangle produces the expected fundamental');
    assert.ok(Math.abs(entry.state.levels[2] - 9.01) < 0.1, 'the drawing sets upper harmonics too');
    assert.deepEqual(entry.state.detunes, before.detunes, 'drawing and clearing do not alter Pitch');
    assert.deepEqual(edits, ['begin', 'state', 'state', 'state', 'state', 'end'], 'one undo group per stroke');
    reset.dispatchEvent(new Event('click'));
    tabs.children[0].dispatchEvent(new Event('click'));
    const amp = valueLabel.children[1];
    amp.valueAsNumber = 25;
    amp.dispatchEvent(new Event('change'));
    tabs.children[2].dispatchEvent(new Event('click'));
    const [peakX, peakY] = path[WAVE_SAMPLES / 4];
    assert.equal(peakX, 168);
    assert.ok(Math.abs(peakY - 87) < 1e-9, 'an Amp change redraws the quarter-cycle peak');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousObserver;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}
console.log('SPECTRA tests passed');
