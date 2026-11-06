// Run: node test/render.test.mjs   (offline song render + WAV encoding, src/render.js)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.sampleRate ??= 48000;
const { dspTestHost } = await import('./dsphost.mjs');
const { Graph } = await import('../src/dsp/graph.js');
const { PatchRuntime } = await import('../src/patch.js');
const { emptySong, addClip } = await import('../src/song.js');
const { renderSong, encodeWav, TAIL_MAX_S } = await import('../src/render.js');
const { addSample } = await import('../src/samples.js');

// a project: OSC (module 1, plays MIDI) -> Output; one clip with a one-beat note at 120 BPM
const { dsp } = dspTestHost();
const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
const root = await PatchRuntime.create(engine, dsp.destination);
const osc = await root.addModule('OSC');
assert.ok(root.connect(osc.id, 0));
const song = emptySong();
const clip = addClip(song, { start: 0, length: 4, target: osc.id });
clip.notes.push({ pitch: 69, start: 0, length: 1, vel: 0.8 });
const project = { format: 'modsynth', version: 1, patch: root.toJSON(), song };
const rate = 48000;
const secondsPerQuarter = 60 / root.bpm;
await assert.rejects(renderSong(project, { signal: AbortSignal.abort() }), { name: 'AbortError' });
const cancellation = new AbortController();
await assert.rejects(renderSong(project, {
  signal: cancellation.signal,
  onProgress: () => cancellation.abort(),
}), { name: 'AbortError' });
assert.equal(globalThis.sampleRate, 48000, 'cancelled renders restore the sample rate');

for (const wasm of [null, await readFile(new URL('../src/dsp/modsynth.wasm', import.meta.url))]) {
  const progress = [];
  const out = await renderSong(structuredClone(project), { sampleRate: rate, wasm, onProgress: (f) => progress.push(f) });
  const kind = wasm ? 'wasm' : 'js';
  assert.equal(out.left.length, out.length);
  assert.equal(out.right.length, out.length);
  assert.equal(globalThis.sampleRate, 48000, `${kind}: the global sample rate is restored`);
  const songLen = 4 * secondsPerQuarter * rate; // the song ends with its last clip
  assert.ok(out.length >= songLen, `${kind}: the whole song is rendered (${out.length} >= ${songLen})`);
  assert.ok(out.length <= songLen + TAIL_MAX_S * rate + 128, `${kind}: the tail is bounded`);
  const peakIn = (a, b) => { let p = 0; for (let i = Math.floor(a * rate); i < Math.min(out.length, Math.floor(b * rate)); i++) p = Math.max(p, Math.abs(out.left[i]), Math.abs(out.right[i])); return p; };
  assert.ok(peakIn(0.05, 0.4) > 0.01, `${kind}: the note sounds`);
  assert.ok(peakIn(1.5, 2) < 1e-3, `${kind}: silence after the note's release`);
  assert.ok(out.peak > 0.01 && Number.isFinite(out.peak));
  assert.equal(progress.at(-1), 1, `${kind}: progress ends at 100%`);
}

// Sample-based songs export the same audio with native and fallback kernels, at different
// engine rates, using the normal project state -> sample feeder -> native graph path.
{
  const sampleId = addSample({
    rate: 22050,
    channels: [Float32Array.from({ length: 8192 }, (_, i) => 0.6 * Math.sin(i * 0.13))],
  });
  const wasm = await readFile(new URL('../src/dsp/modsynth.wasm', import.meta.url));
  for (const type of ['SAMPLER', 'WAVETABLE']) for (const sampleRate of [44100, 96000]) {
    const data = structuredClone(project);
    const source = data.patch.modules.find(m => m.id === osc.id);
    source.type = type;
    source.state = { sampleId, frame: 256 };
    source.values = type === 'SAMPLER'
      ? { playMode: 2, selStart: 11.3, selLength: 41.7, release: 0.02 }
      : { position: 37.3, release: 0.02 };
    const js = await renderSong(data, { sampleRate });
    const native = await renderSong(data, { sampleRate, wasm });
    assert.equal(native.length, js.length, `${type}: same export length`);
    assert.ok(native.peak > 0.01, `${type}: exported audio is not silent`);
    let worst = 0;
    for (let i = 0; i < js.length; i++) {
      worst = Math.max(worst, Math.abs(js.left[i] - native.left[i]), Math.abs(js.right[i] - native.right[i]));
    }
    assert.ok(worst < 1e-5, `${type} ${sampleRate}: native export differs by ${worst}`);
  }
}

// Delayed MIDI survives export's silent tail.
for (const type of ['STRUM', 'MULTIMIDI']) {
  const delayed = structuredClone(project);
  const id = 2;
  delayed.patch.modules.push({
    id, type, x: 0, y: 0,
    values: type === 'STRUM' ? { duration: 5000 } : { randomDelay: 5000 },
  });
  delayed.patch.cables.push({ from: id, to: osc.id });
  delayed.song.clips[0].target = id;
  delayed.song.clips[0].notes = [
    ...(type === 'STRUM' ? [{ pitch: 60, start: 0, length: 0.25, vel: 0 }] : []),
    { pitch: 69, start: 0, length: 0.25, vel: 0.8 },
  ];
  const oldRandom = Math.random;
  Math.random = () => 0.8;
  let out;
  try { out = await renderSong(delayed, { sampleRate: rate }); }
  finally { Math.random = oldRandom; }
  const onset = type === 'STRUM' ? 5 : 4;
  let early = 0, late = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out.left[i]);
    if (i < (onset - 0.02) * rate) early = Math.max(early, a);
    if (i > (onset + 0.02) * rate) late = Math.max(late, a);
  }
  assert.ok(early < 1e-3, `${type}: delayed note does not sound early`);
  assert.ok(late > 0.01, `${type}: pending MIDI survives silent offline tail until delayed onset`);
  assert.ok(out.seconds > onset, `${type}: export includes all delayed notes`);
}

// Offline rendering advances many DSP blocks without yielding to microtasks. Pitch-bend and
// velocity curves must therefore flush on the audio clock, not only in a queued microtask.
{
  const bent = structuredClone(project);
  const id = 2;
  bent.patch.modules.push({ id, type: 'MULTIMIDI', x: 0, y: 0 });
  bent.patch.cables.push({ from: id, to: osc.id });
  bent.song.clips[0].target = id;
  bent.song.clips[0].notes = [{
    pitch: 69, start: 0, length: 1, vel: 0.8,
    bends: [{ t: 0.1, d: 0, r: 1 }, { t: 0.2, d: 2, r: 1 }, { t: 0.4, d: 2, r: 1 }, { t: 0.5, d: 0, r: 1 }],
    vels: [{ t: 0.1, v: 0.2, r: 1 }, { t: 0.4, v: 0.9, r: 1 }],
  }];

  const oldHandle = Graph.prototype.handle;
  let updates = 0;
  Graph.prototype.handle = function (batch) {
    for (const op of batch) if (op[0] === 'msg' && op[2]?.type === 'noteMod') updates++;
    return oldHandle.call(this, batch);
  };
  try {
    await renderSong(bent, { sampleRate: rate });
  } finally {
    Graph.prototype.handle = oldHandle;
  }
  assert.ok(updates > 50, `bend/velocity updates are not coalesced until note-off (${updates})`);
}

// A multi-instance PATCH routes simultaneous notes round-robin to separate monophonic OPERATORs.
{
  const patch = await root.addModule('PATCH', { values: { inputModule: 1, instances: 2 } });
  const innerOp = await patch.inst.patch.addModule('OPERATOR');
  patch.inst.patch.connect(innerOp.id, 0);
  const poly = emptySong();
  const clip = addClip(poly, { start: 0, length: 1, target: patch.id });
  clip.notes.push(
    { pitch: 48, start: 0, length: 0.75, vel: 0.8 },
    { pitch: 60, start: 0, length: 0.75, vel: 0.8 },
  );
  const data = { format: 'modsynth', version: 1, patch: root.toJSON(), song: poly };
  const oldHandle = Graph.prototype.handle;
  const operatorNotes = [];
  Graph.prototype.handle = function (batch) {
    for (const op of batch) {
      if (op[0] !== 'msg' || op[2]?.type !== 'noteOn') continue;
      if (this.nodes.get(op[1])?.kind === 'operator') operatorNotes.push([op[1], op[2].pitch]);
    }
    return oldHandle.call(this, batch);
  };
  try {
    await renderSong(data, { sampleRate: rate });
  } finally {
    Graph.prototype.handle = oldHandle;
  }
  assert.deepEqual(operatorNotes.map(([, pitch]) => pitch).sort((a, b) => a - b), [48, 60]);
  assert.equal(new Set(operatorNotes.map(([handle]) => handle)).size, 2, 'each note reaches a separate OPERATOR instance');
}

// TRILL through a MIDI cable: one held key repeats every 1/16 (0.125 s) for 1/32 (62.5 ms)
{
  const trilled = structuredClone(project);
  const id = 2;
  trilled.patch.modules.push({ id, type: 'TRILL', x: 0, y: 0, values: { separation: 16, length: 32, humanize: 0 } });
  trilled.patch.cables.push({ from: id, to: osc.id });
  trilled.song.clips[0].target = id;
  const out = await renderSong(trilled, { sampleRate: rate });
  const peak = (a, b) => { let p = 0; for (let i = Math.floor(a * rate); i < Math.floor(b * rate); i++) p = Math.max(p, Math.abs(out.left[i])); return p; };
  for (let k = 0; k < 4; k++) {
    assert.ok(peak(k * 0.125 + 0.01, k * 0.125 + 0.05) > 0.01, `TRILL: note ${k} sounds`);
    assert.ok(peak(k * 0.125 + 0.08, k * 0.125 + 0.115) < 1e-3, `TRILL: gap after note ${k}`);
  }
  assert.ok(peak(0.6, 1) < 1e-3, 'TRILL: stops when the key is released');
}

// an empty song cannot be exported
await assert.rejects(renderSong({ ...structuredClone(project), song: emptySong() }, { sampleRate: rate }), /empty/);

// the live project is not touched
assert.equal(clip.notes.length, 1);

// WAV: RIFF header, 24-bit stereo PCM, clipped samples
{
  const L = new Float32Array([0, 1, -1, 2, 0.5]);
  const R = new Float32Array([0, -0.5, 0.25, -3, NaN]);
  const buf = encodeWav(L, R, 44100);
  const v = new DataView(buf);
  const str = (at, n) => String.fromCharCode(...new Uint8Array(buf, at, n));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 2, 'stereo');
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(v.getUint32(40, true), 5 * 2 * 3);
  assert.equal(buf.byteLength, 44 + 30);
  const s24 = (frame, ch) => { const at = 44 + (frame * 2 + ch) * 3; const x = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16); return x & 0x800000 ? x - 0x1000000 : x; };
  assert.equal(s24(1, 0), 0x7fffff);
  assert.equal(s24(2, 0), -0x800000);
  assert.equal(s24(3, 0), 0x7fffff, 'clipped high');
  assert.equal(s24(3, 1), -0x800000, 'clipped low');
  assert.equal(s24(1, 1), -0x400000);
  assert.equal(s24(4, 1), 0, 'NaN becomes silence');
}

await import('./audioexport.test.mjs');
console.log('render tests passed');
