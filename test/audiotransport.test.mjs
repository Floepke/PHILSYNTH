import assert from 'node:assert/strict';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';
import { playbackModel, playbackSong, preparePlayback } from '../src/playbackmodel.js';
import { Playback } from '../src/dsp/playback.js';
import { AudioTransport } from '../src/audiotransport.js';
import { MidiRecorder } from '../src/seq/recording.js';
import { emptySong, addClip, addAutoClip, notesStarting, notesSounding } from '../src/song.js';
import { readFileSync } from 'node:fs';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';
import { modules } from '../src/modules/index.js';
import { addSample, addImage } from '../src/samples.js';
import { newNoteId, useAudioNoteIds } from '../src/modmidi.js';

const RATE = 48000;
const DT = 128 / RATE;
const note = (pitch, start = 0, length = 0.1) => ({ pitch, start, length, vel: 0.8 });

async function harness(options = {}) {
  const { graph, dsp } = dspTestHost(options);
  dsp.remoteNotes = true;
  const ctx = { currentTime: 0 };
  const root = await PatchRuntime.create({ dsp, ctx }, dsp.destination);
  const playback = new Playback(graph, () => ctx.currentTime);
  const song = emptySong();
  const events = [];
  const message = graph.message.bind(graph);
  graph.message = (h, m) => {
    if (m.type.startsWith('note')) events.push({ h, ...m, time: ctx.currentTime });
    message(h, m);
  };
  const update = async () => {
    await preparePlayback(root);
    await playback.model(structuredClone(playbackModel(root)));
    playback.setSong(structuredClone(playbackSong(song)));
  };
  const start = (scope = [], clipId = null, pos = 0) => {
    playback.command({ type: 'start', revision: 1, scope, clipId, pos, chase: true });
  };
  const left = new Float32Array(128), right = new Float32Array(128);
  const run = (seconds) => {
    const end = ctx.currentTime + seconds;
    while (ctx.currentTime < end - 1e-10) {
      playback.process();
      graph.render(left, right);
      playback.receive(graph.report(ctx.currentTime)?.mods);
      ctx.currentTime += DT;
    }
  };
  return { root, dsp, graph, ctx, playback, song, events, update, start, run };
}

// Metronome commands reach the worklet without cancelling a pending asynchronous playback start.
{
  const h = await harness();
  addClip(h.song, { length: 16 });
  await h.update();
  let ready;
  const transport = new AudioTransport({
    getScope: () => [], getSong: () => h.song, getBpm: () => 120, getTarget: () => null,
    now: () => h.ctx.currentTime * 1000,
  }, {
    dsp: { post: ([, , data]) => h.playback.command(data) },
    sync: () => new Promise(resolve => { ready = resolve; }),
    onError: (error) => { throw error; }, audioTime: () => h.ctx.currentTime,
  });
  transport.play();
  transport.setMetronome(true);
  ready();
  await Promise.resolve();
  assert.equal(h.playback.transport.playing, true, 'toggle does not cancel pending start');
  h.run(DT * 2);
  assert.equal(h.playback.blip.hz, 880, 'first bar uses the count-in accent');
  const left = new Float32Array(128), right = new Float32Array(128);
  h.playback.renderCountIn(left, right, RATE);
  assert.ok(left.some(v => v !== 0), 'metronome produces audible samples');
  assert.deepEqual(left, right, 'click is centered in stereo');
  h.run(0.5);
  assert.equal(h.playback.blip.hz, 440, 'other beats use the count-in low pitch');
  transport.setMetronome(false);
  assert.equal(h.playback.blip, null, 'turning off immediately silences the click');
  h.run(0.5);
  assert.equal(h.playback.blip, null, 'no clicks while disabled');
  transport.setMetronome(true);
  transport.stop();
  assert.equal(h.playback.blip, null, 'stop clears click audio');
  assert.equal(transport.metronome, true, 'stop preserves toggle for next play');
  h.root.destroy();
}

// Recording's continuous mode reaches the worklet even when its song snapshot still has
// the old clip length; stopping finalizes the held note before parking the playhead.
{
  const h = await harness();
  const clip = addClip(h.song, { length: 1 });
  h.song.selected = clip.id;
  await h.update();
  let commits = 0;
  const transport = new AudioTransport({
    getScope: () => [],
    getSong: () => h.song, getBpm: () => 120, getTarget: () => null,
    now: () => h.ctx.currentTime * 1000, onState: () => recorder.update(),
  }, {
    dsp: { post: ([, , data]) => h.playback.command(data) },
    sync: async () => {}, onError: (error) => { throw error; },
    audioTime: () => h.ctx.currentTime,
  });
  const recorder = new MidiRecorder({
    transport, song: () => h.song, clip: () => clip,
    onNotes() {}, onState() {}, onCommit: () => commits++,
    onError: (message) => assert.fail(message),
  });
  recorder.arm();
  recorder.start();
  await Promise.resolve();
  h.run(2.1);
  transport.receive(h.playback.report());
  recorder.input({ type: 'on', key: 'held', pitch: 60, velocity: 0.8 });
  h.run(3);
  transport.receive(h.playback.report());
  recorder.update();
  assert.ok(transport.pos > 6, 'audio playback does not wrap at the original song end');
  assert.equal(transport.playing, true);
  transport.stop({ to: 0 });
  assert.equal(clip.notes.length, 1);
  assert.ok(clip.notes[0].length > 5.9, 'held note continues past the old clip end');
  assert.equal(clip.length, 8);
  assert.equal(commits, 1);
  assert.equal(h.playback.transport.playing, false);

  // Disarming during the asynchronous start must not cancel that pending start.
  recorder.arm();
  recorder.start();
  recorder.finish();
  await Promise.resolve();
  assert.equal(h.playback.transport.playing, true);
  assert.equal(h.playback.transport.continuous, false);
  transport.stop();
}

for (const native of [false, true]) {
  const options = native ? wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), RATE) : {};
  const h = await harness(options);
  const osc = await h.root.addModule('OSC');
  h.root.connect(osc.id, 0);
  const clip = addClip(h.song, { length: 4, target: osc.id });
  clip.notes.push(note(60, 0.1, 0.1), note(64, 0.3, 0.1));
  const nodeCount = h.graph.nodes.size;
  await h.update();
  assert.equal(h.graph.nodes.size, nodeCount, 'control copies do not duplicate DSP nodes');
  h.start();
  // Only the audio thread runs: no UI transport tick, clock message handling or microtasks.
  h.run(0.3);
  const ons = h.events.filter((e) => e.type === 'noteOn');
  const offs = h.events.filter((e) => e.type === 'noteOff');
  assert.equal(ons.length, 2, `both note-ons run without a UI tick (${native ? 'Wasm' : 'JS'})`);
  assert.equal(offs.length, 2);
  for (const [i, expected] of [0.05, 0.15].entries()) {
    assert.ok(Math.abs(ons[i].time - expected) <= DT + 1e-9);
    assert.ok(Math.abs(offs[i].time - (expected + 0.05)) <= DT + 1e-9);
  }
  const indexed = h.playback.events;
  for (const [from, to] of [[0, 0.1], [0.1, 0.3], [0.3, 2], [-1, 2]]) {
    assert.deepEqual(indexed.starting(h.playback.song, from, to), notesStarting(h.playback.song, from, to));
    assert.deepEqual(indexed.sounding(h.playback.song, from), notesSounding(h.playback.song, from));
  }
}

// MULTIMIDI's saved velocity mappings run in its audio-side control copy, for both backends.
for (const native of [false, true]) {
  const options = native ? wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), RATE) : {};
  const h = await harness(options);
  const mm = await h.root.addModule('MULTIMIDI');
  const osc = await h.root.addModule('OSC');
  h.root.connect(mm.id, osc.id);
  h.root.connect(osc.id, 0);
  const state = structuredClone(mm.state);
  state.velocityMap[60] = 0.5;
  state.velocityCurve = { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 0.5, r: 0 }] };
  h.root.setState(mm.id, state);
  h.root.setParam(mm.id, 'velocity', 0.8);
  addClip(h.song, { length: 4, target: mm.id }).notes.push(note(60, 0, 2));
  await h.update();
  h.start();
  h.run(0.01);
  const on = h.events.find((e) => e.h === osc.inst.node.h && e.type === 'noteOn');
  assert.ok(Math.abs(on.velocity - 0.16) < 1e-8, 'audio-thread note onset uses response, key trim and Velocity');
  state.velocityMap[60] = 0.25;
  h.root.setState(mm.id, state);
  await h.update();
  h.run(0.01);
  assert.ok(h.events.some((e) => e.type === 'noteMod' && e.notes?.some(([id, , vel]) => id === on.id && Math.abs(vel - 0.08) < 1e-8)),
    'held audio-thread notes follow state edits without GUI-side note processing');
}

// Timed MIDI processors use the same audio clock as their downstream DSP.
for (const type of ['MULTIMIDI', 'STRUM', 'TRILL', 'TUNING', 'DELAY']) {
  const h = await harness();
  const source = await h.root.addModule(type);
  const osc = await h.root.addModule('OSC');
  h.root.connect(source.id, osc.id);
  h.root.connect(osc.id, 0);
  if (type === 'MULTIMIDI') {
    h.root.setParam(source.id, 'transpose', 12);
    h.root.setParam(source.id, 'drift', 1);
    h.root.setParam(source.id, 'randomDelay', 10);
  }
  if (type === 'STRUM') h.root.setParam(source.id, 'duration', 50);
  if (type === 'TRILL') h.root.setParam(source.id, 'humanize', 0);
  if (type === 'DELAY') h.root.setParam(source.id, 'left', 30);
  const clip = addClip(h.song, { length: 4, target: source.id });
  clip.notes.push(note(60, 0, 0.4), note(64, 0, 0.4), note(67, 0, 0.4));
  await h.update();
  h.start();
  h.run(0.7);
  const ons = h.events.filter((e) => e.h === osc.inst.node.h && e.type === 'noteOn');
  const offs = h.events.filter((e) => e.h === osc.inst.node.h && e.type === 'noteOff');
  assert.ok(ons.length >= 3, `${type} generates routed notes`);
  assert.ok(ons.every((on) => offs.some((off) => off.id === on.id)), `${type} releases every routed note without UI`);
  if (type === 'STRUM') {
    assert.deepEqual(ons.map((e) => e.pitch), [60, 64, 67]);
    assert.ok(Math.abs(ons[2].time - ons[0].time - 0.05) <= DT + 1e-9);
  }
  if (type === 'DELAY') assert.ok(ons.every((e) => e.time >= 0.03));
  assert.ok(h.playback.report().midi.some((event) => event[2] === source.id && event[3] === osc.id),
    `${type}: MIDI cable visualization is reported without UI-side note delivery`);
}

// A rejected topology snapshot is explicit, and a subsequent valid one repairs partial updates.
{
  const h = await harness();
  const osc = await h.root.addModule('OSC');
  await h.update();
  const invalid = structuredClone(playbackModel(h.root));
  invalid.bindings[0].modules.find((m) => m.id === osc.id).nodes[0].h = 999999;
  await assert.rejects(h.playback.model(invalid), /Playback DSP binding mismatch/);
  await h.update();
  assert.ok(h.playback.root.modules.get(osc.id));
}

// Nested Patch instances, mapped automation, and layer playback reuse their existing bindings.
{
  const h = await harness();
  const folder = await h.root.addModule('PATCH');
  const inner = folder.inst.patch;
  const osc = await inner.addModule('OSC');
  inner.connect(osc.id, 0);
  h.root.connect(folder.id, 0);
  h.root.setParam(folder.id, 'instances', 2);
  h.root.setState(folder.id, { maps: [{ key: 'map1', module: osc.id, param: 'gain', label: 'Gain' }] });
  const clip = addClip(h.song, { length: 4, target: folder.id });
  clip.notes.push(note(60), note(64));
  const auto = addAutoClip(h.song, { length: 4, target: folder.id, controller: 11, y: 34 });
  auto.points.push({ t: 0, v: 0.25, r: 0 }, { t: 4, v: 0.25, r: 0 });
  const sketch = addClip(inner.song, { length: 4, target: osc.id });
  sketch.notes.push(note(72));
  await h.update();
  h.start();
  h.run(0.1);
  const bound = h.playback.root.modules.get(folder.id).inst;
  const nodes = [osc.inst.node.h, folder.inst.clones[0].modules.get(osc.id).inst.node.h];
  assert.equal(bound.clones.length, 1);
  assert.ok(nodes.every((id) => h.events.some((e) => e.h === id && e.type === 'noteOn')), 'round robin uses existing instance nodes');
  assert.ok(nodes.every((id) => Math.abs(h.graph.nodes.get(id).values.gain - 0.25) < 1e-6), 'mapped automation reaches every instance');
  await inner.addModule('FILTER');
  await h.update();
  assert.equal(h.playback.root.modules.get(folder.id).inst, bound, 'editing nested topology preserves its parent instance');
  assert.equal(bound.clones[0].modules.size, inner.modules.size, 'hidden control copies follow nested topology edits');
  h.playback.command({ type: 'stop', revision: 2, pos: 0 });
  h.events.length = 0;
  h.start([folder.id]);
  h.run(0.1);
  assert.deepEqual(h.events.filter((e) => e.type === 'noteOn').map((e) => e.pitch), [72], 'only the playing layer sketch sounds');
}

// Song edits preserve held notes; stop/seek/restart cancel old notes, not live keyboard voices.
{
  const h = await harness();
  const osc = await h.root.addModule('OSC');
  h.root.connect(osc.id, 0);
  const clip = addClip(h.song, { length: 4, target: osc.id });
  clip.notes.push(note(60, 0, 2));
  await h.update();
  osc.inst.noteOn(999999, 84, 0.8);
  h.start();
  h.run(0.1);
  const old = h.events.find((e) => e.type === 'noteOn' && e.id !== 999999);
  const held = h.playback.transport.active[0].note;
  clip.name = 'Edited';
  clip.notes[0].bends = [{ t: 0.1, d: 2, r: 0 }, { t: 2, d: 2, r: 0 }];
  clip.notes[0].vel = 0.4;
  await h.update();
  assert.equal(h.playback.transport.active[0].note, held, 'held note retains its identity through edits');
  h.run(0.05);
  assert.ok(h.events.some((e) => e.type === 'noteMod' && e.notes?.some((n) => n[0] === old.id && n[1] === 62 && n[2] === 0.4)),
    'pitch and velocity edits reach the held voice');
  assert.ok(!h.events.some((e) => e.type === 'noteOff' && e.id === old.id), 'song update does not cut a held note');
  const boundOsc = h.playback.root.modules.get(osc.id).inst;
  const filter = await h.root.addModule('FILTER');
  await h.update();
  assert.equal(h.playback.root.modules.get(osc.id).inst, boundOsc, 'unrelated topology edits preserve control instances');
  assert.ok(!h.events.some((e) => e.type === 'noteOff' && e.id === old.id), 'inserting a module does not retrigger held notes');
  h.root.removeModule(filter.id);
  await h.update();
  assert.equal(h.playback.root.modules.get(osc.id).inst, boundOsc);
  h.playback.command({ type: 'seek', revision: 2, pos: 0.5 });
  assert.ok(h.events.some((e) => e.type === 'noteOff' && e.id === old.id));
  h.run(0.05);
  h.playback.command({ type: 'stop', revision: 3, pos: 0.6 });
  const afterStop = h.events.length;
  h.run(0.1);
  assert.equal(h.events.length, afterStop, 'stop leaves no stray scheduled note-ons');
  assert.ok(!h.events.some((e) => e.type === 'noteOff' && e.id === 999999), 'live note is not released');
}

// Every module can be reconstructed without DOM APIs; dynamic controllers see the real inputs.
{
  const h = await harness();
  for (const def of modules) await h.root.addModule(def.type);
  await h.update();
  const osc = [...h.root.modules.values()].find((e) => e.def.type === 'OSC');
  for (const type of ['MODULATOR', 'COMPRESSOR']) {
    const target = [...h.root.modules.values()].find((e) => e.def.type === type);
    h.root.connect(osc.id, target.id);
    await h.update();
    assert.ok(h.playback.root.modules.get(target.id).inst.params().length > 0);
    addAutoClip(h.song, { length: 4, target: target.id, controller: 0 });
  }
  await h.update();
  h.start();
  h.run(0.02);
}

// Bound sample-module state never uploads/clears audio or images already held by Graph.
{
  const h = await harness();
  const sampleId = addSample({ rate: RATE, channels: [Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 20))] });
  const imageId = addImage({ width: 2, height: 2, rgb: new Uint8Array(12).fill(200) });
  for (const type of ['SAMPLER', 'WAVETABLE', 'IMAGESAMPLER']) {
    await h.root.addModule(type, { state: type === 'IMAGESAMPLER' ? { imageId } : { sampleId } });
  }
  const uploads = [];
  const send = h.graph.message.bind(h.graph);
  h.graph.message = (id, message) => {
    if (['sample', 'table', 'image'].includes(message.type)) uploads.push(message);
    send(id, message);
  };
  await h.update();
  for (const e of h.root.modules.values()) {
    if (e.def.type === 'OUT') continue;
    // Change the model directly: only the control-side setState is under test here.
    e.state = { ...e.state, name: 'Renamed' };
  }
  await h.update();
  assert.equal(uploads.length, 0, 'worklet control copies do not feed a second sample pool');
}

// New Patch instances bind only after the UI has provisioned their DSP nodes.
{
  const h = await harness();
  const folder = await h.root.addModule('PATCH');
  const osc = await folder.inst.patch.addModule('OSC');
  folder.inst.patch.connect(osc.id, 0);
  h.root.connect(folder.id, 0);
  await h.update();
  const bound = h.playback.root.modules.get(folder.id).inst;
  h.playback.root.driveId(folder.id, 'instances', 3);
  await bound.sync();
  assert.equal(bound.clones.length, 0, 'automation cannot allocate unprovisioned audio nodes');
  h.root.setParam(folder.id, 'instances', 3);
  await h.update();
  assert.equal(bound.clones.length, 2, 'new bindings enable the requested instances');
  const clip = addClip(h.song, { length: 4, target: folder.id });
  clip.notes.push(note(60, 0, 1), note(64, 0, 1), note(67, 0, 1));
  await h.update();
  h.start();
  h.run(0.05);
  assert.equal(new Set(h.events.filter((e) => e.type === 'noteOn').map((e) => e.h)).size, 3);
  h.root.setParam(folder.id, 'instances', 1);
  await h.update();
  assert.equal(bound.clones.length, 0);
  h.run(0.05);
}

for (const type of ['DELAY', 'STRUM', 'TRILL']) {
  const h = await harness();
  const source = await h.root.addModule(type);
  const osc = await h.root.addModule('OSC');
  h.root.connect(source.id, osc.id);
  h.root.connect(osc.id, 0);
  if (type === 'DELAY') h.root.setParam(source.id, 'left', 500);
  if (type === 'STRUM') h.root.setParam(source.id, 'duration', 500);
  const clip = addClip(h.song, { length: 4, target: source.id });
  clip.notes.push(note(60, 0, 2), note(64, 0, 2));
  await h.update();
  h.start();
  h.run(0.02);
  h.playback.command({ type: 'panic' });
  const count = h.events.filter((e) => e.type === 'noteOn').length;
  h.run(0.7);
  assert.equal(h.events.filter((e) => e.type === 'noteOn').length, count, `${type}: panic cancels queued playback`);
}

// CTL2NOTE has one audio-side owner, and panic cancels delayed/trilling playback.
{
  const h = await harness();
  const ctl = await h.root.addModule('CTL2NOTE');
  const osc = await h.root.addModule('OSC');
  h.root.connect(ctl.id, osc.id);
  h.root.connect(osc.id, 0);
  h.root.setParam(ctl.id, 'noteState', 1);
  assert.equal(h.events.length, 0, 'UI copy does not generate duplicate autonomous notes');
  await h.update();
  h.run(0.1);
  assert.equal(h.events.filter((e) => e.type === 'noteOn').length, 1);
  h.playback.command({ type: 'panic' });
  const count = h.events.length;
  h.run(0.1);
  assert.equal(h.events.length, count, 'panic requires a new Off -> On transition');
}

// The facade ignores stale reports and does not resurrect a cancelled asynchronous start.
{
  const song = emptySong();
  addClip(song, { length: 4 });
  const ops = [];
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const tr = new AudioTransport({
    getScope: () => [], getSong: () => song, getBpm: () => 120, getTarget: () => null,
  }, { dsp: { post: (op) => ops.push(op) }, sync: () => pending, audioTime: () => 0, onError: (error) => { throw error; } });
  tr.play();
  tr.stop();
  resolve();
  await pending;
  await Promise.resolve();
  assert.deepEqual(ops.map((op) => op[2].type), ['stop']);
  tr.receive({ revision: 0, playing: true, pos: 3, clipId: null });
  assert.equal(tr.playing, false);
  assert.equal(tr.pos, 0);
}

{
  const song = emptySong();
  addClip(song, { length: 4 });
  const ops = [], errors = [];
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const tr = new AudioTransport({
    getScope: () => [], getSong: () => song, getBpm: () => 120, getTarget: () => null,
  }, { dsp: { post: (op) => ops.push(op) }, sync: () => pending, audioTime: () => 0, onError: (error) => errors.push(error) });
  tr.play();
  tr.seek(1.5);
  resolve();
  await pending;
  await Promise.resolve();
  assert.deepEqual(ops.map((op) => [op[2].type, op[2].pos]), [['start', 1.5]], 'seek supersedes a pending start');
  assert.equal(ops[0][2].fromStart, false, 'a seek is not a play from start');
  tr.receive({ revision: tr.revision - 1, playing: true, pos: 0.1, clipId: null });
  assert.equal(tr.pos, 1.5);
  tr.receive({ revision: tr.revision, playing: true, pos: 1.6, clipId: null });
  assert.equal(tr.pos, 1.6);
  tr.stop();
  tr.sync = async () => { throw new Error('test synchronization failure'); };
  tr.play();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tr.playing, false, 'failed synchronization stops the UI facade');
  assert.match(errors[0].message, /test synchronization failure/);
}

// play from start (,) tells the worklet to restart the LFOs; other starts do not
{
  const song = emptySong();
  addClip(song, { length: 4 });
  const ops = [];
  const tr = new AudioTransport({
    getScope: () => [], getSong: () => song, getBpm: () => 120, getTarget: () => null,
  }, { dsp: { post: (op) => ops.push(op) }, sync: async () => {}, audioTime: () => 0, onError: () => {} });
  tr.seek(2);
  tr.play();
  await Promise.resolve(); await Promise.resolve();
  tr.play({ fromStart: true });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(ops.filter((op) => op[2].type === 'start').map((op) => [op[2].pos, op[2].fromStart]), [[2, false], [0, true]]);
  const { graph } = dspTestHost();
  const playback = new Playback(graph, () => 0);
  let resets = 0;
  graph.songStart = () => resets++;
  playback.root = { modules: new Map() };
  for (const fromStart of [false, true]) {
    playback.command({ type: 'start', revision: 1, scope: [], clipId: null, pos: 0, chase: true, fromStart });
  }
  assert.equal(resets, 1, 'the worklet resets only for play from start');
}

useAudioNoteIds();
const firstAudioId = newNoteId();
assert.ok(firstAudioId < 0 && newNoteId() < firstAudioId, 'audio note IDs cannot collide with positive live MIDI IDs');

console.log('audio-thread transport tests passed');
