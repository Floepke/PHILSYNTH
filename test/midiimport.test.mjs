import assert from 'node:assert/strict';
import { parseMidiFile } from '../src/midiimport.js';
import { MAX_MIDI_BYTES } from '../src/fileformat.js';
import { normalizeSong, emptySong } from '../src/song.js';

const be16 = (n) => [n >> 8 & 255, n & 255];
const be32 = (n) => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const text = (s) => [...new TextEncoder().encode(s)];
const vlq = (n) => {
  const out = [n & 127];
  while ((n = Math.floor(n / 128))) out.unshift((n & 127) | 128);
  return out;
};
const event = (delta, ...data) => [...vlq(delta), ...data];
const end = event(0, 0xff, 0x2f, 0);
const track = (...events) => {
  const data = events.flat();
  return [...text('MTrk'), ...be32(data.length), ...data];
};
const midi = (format, division, ...tracks) => new Uint8Array([
  ...text('MThd'), ...be32(6), ...be16(format), ...be16(tracks.length), ...be16(division), ...tracks.flat(),
]);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

{
  const bytes = midi(0, 480, track(
    event(0, 0xff, 3, 4, ...text('Lead')),
    event(0, 0x90, 60, 127), event(120, 60, 64),
    event(120, 0x91, 60, 32), event(240, 0x80, 60, 0),
    event(240, 0x90, 60, 0), event(0, 0x81, 60, 0), end,
  ));
  const result = parseMidiFile(bytes, 'song.mid');
  assert.equal(result.format, 0);
  assert.equal(result.warnings, 0);
  const clip = result.clips[0];
  assert.equal(clip.name, 'Lead');
  assert.equal(clip.target, null);
  assert.equal(clip.length, 1.5);
  assert.deepEqual(clip.notes.map((n) => [n.pitch, n.start, n.length]), [[60, 0, 1], [60, 0.25, 1.25], [60, 0.5, 1]]);
  close(clip.notes[1].vel, 64 / 127);
  const song = emptySong();
  song.clips.push({ ...clip, id: 1 });
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(song))).clips[0].notes, clip.notes);
}
{
  const bytes = midi(1, 96, track(end), track(event(24, 0x90, 72, 100), event(96, 0x80, 72, 0), end));
  const { clips } = parseMidiFile(bytes, 'multi.midi');
  assert.equal(clips.length, 2);
  assert.equal(clips[0].name, 'multi - Track 1');
  assert.deepEqual(clips[0].notes, []);
  assert.equal(clips[1].notes[0].start, 0.25);
  assert.equal(clips[1].notes[0].length, 1);
}
{
  const division = (256 - 25) * 256 + 40;
  const tempoTrack = track(event(100, 0xff, 0x51, 3, 0x0f, 0x42, 0x40), event(100, 0xff, 0x2f, 0));
  const noteTrack = track(event(0, 0x90, 60, 90), event(200, 0x80, 60, 0), end);
  close(parseMidiFile(midi(1, division, tempoTrack, noteTrack)).clips[1].notes[0].length, 0.3);
  close(parseMidiFile(midi(2, division, tempoTrack, noteTrack)).clips[1].notes[0].length, 0.4);
}
{
  const bytes = midi(0, 480, track(event(0, 0x80, 55, 0), event(0, 0x90, 60, 1),
    event(0, 0x80, 60, 0), event(0, 0x90, 61, 2), end));
  const { clips, warnings } = parseMidiFile(bytes);
  assert.equal(warnings, 3);
  assert.deepEqual(clips[0].notes.map((n) => n.length), [1 / 480, 1 / 480]);
}
{
  assert.throws(() => parseMidiFile(new Uint8Array(MAX_MIDI_BYTES + 1)), /too large/);
  assert.throws(() => parseMidiFile(midi(0, 480, track(event(0, 60, 100), end))), /running status/);
  assert.throws(() => parseMidiFile(midi(0, 480, track(event(0, 0x90, 60, 128), end))), /invalid channel event/);
  assert.throws(() => parseMidiFile(midi(0, 480, track(event(0, 0x90, 60, 1)))), /end-of-track/);
  assert.throws(() => parseMidiFile(midi(0, 480, track([0x81, 0x80, 0x80, 0x80, 0], end))), /variable-length/);
  assert.throws(() => parseMidiFile(midi(0, 480, track(end), track(end))), /track count/);
  assert.throws(() => parseMidiFile(midi(0, 0, track(end))), /division|quarter/);
  assert.throws(() => parseMidiFile(midi(0, 480, track(event(0, 0xff, 0x51, 3, 0, 0, 0), end))), /tempo/);
  assert.throws(() => parseMidiFile(midi(0, 480, track(end)).slice(0, -1)), /end of file/);
}
console.log('MIDI import parser tests passed');
