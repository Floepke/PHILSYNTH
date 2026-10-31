// Run: node test/render.test.mjs   (offline song render + WAV encoding, src/render.js)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.sampleRate ??= 48000;
const { dspTestHost } = await import('./dsphost.mjs');
const { PatchRuntime } = await import('../src/patch.js');
const { emptySong, addClip } = await import('../src/song.js');
const { renderSong, encodeWav, TAIL_MAX_S } = await import('../src/render.js');

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

console.log('render tests passed');
