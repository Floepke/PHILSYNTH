import assert from 'node:assert/strict';
import { exportMidi, midiNoteSegments, MIDI_PPQN } from '../src/midiexport.js';
import { emptySong, addClip, addAutoClip, setSig, notePitchAt } from '../src/song.js';
import { parseMidiFile } from '../src/midiimport.js';

function decode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(8), 1);
  assert.equal(view.getUint16(12), MIDI_PPQN);
  const tracks = [];
  let position = 14;
  function vlq() {
    let value = 0, byte;
    do { byte = bytes[position++]; value = value * 128 + (byte & 127); } while (byte & 128);
    return value;
  }
  for (let i = 0; i < view.getUint16(10); i++) {
    assert.equal(new TextDecoder().decode(bytes.slice(position, position + 4)), 'MTrk');
    const end = position + 8 + view.getUint32(position + 4);
    position += 8;
    let tick = 0;
    const events = [];
    while (position < end) {
      tick += vlq();
      const status = bytes[position++];
      if (status === 255) {
        const type = bytes[position++], length = vlq();
        const data = bytes.slice(position, position + length);
        position += length;
        events.push({ tick, type, data: [...data], text: new TextDecoder().decode(data) });
      } else events.push({ tick, status, pitch: bytes[position++], velocity: bytes[position++] });
    }
    tracks.push(events);
  }
  assert.equal(position, bytes.length);
  return tracks;
}

const song = emptySong();
const note = (pitch, start, length, vel = 0.5) => ({ pitch, start, length, vel });
const clip = addClip(song, { target: 7, start: 2, length: 4, y: 0 });
clip.notes = [note(60, 0, 2), { ...note(64, 2, 2), vels: [{ t: 1, v: 1 }] }];
const second = addClip(song, { target: 7, start: 0, length: 2, y: 68 });
second.notes = [note(62, 0, 1)];
const third = addClip(song, { target: 2, start: 1, length: 2, y: 34 });
third.notes = [note(69, -1, 2), note(70, 1.5, 10)];
const idea = addClip(song, { target: 99, start: 0, length: 4, y: -34 });
idea.notes = [note(100, 0, 1)];
addAutoClip(song, { target: 33, start: 0, length: 4, y: 102 });
setSig(song, 4, 7, 8, [0, 2, 4]);
const original = structuredClone(song);
const result = exportMidi(song, { bpm: 90, metadata: { songName: 'Test song', creator: 'Creator', comment: 'Notes' }, destinationName: id => `#${id} Synth` });
assert.deepEqual(song, original, 'export never edits the song');
assert.equal(result.tracks, 2);
const tracks = decode(result.bytes);
assert.deepEqual(tracks.map(events => events.find(e => e.type === 3).text), ['Test song', '#2 Synth', '#7 Synth']);
assert.ok(tracks[0].some(e => e.text === 'Creator: Creator'));
assert.ok(tracks[0].some(e => e.text === 'Notes'));
assert.deepEqual(tracks[0].filter(e => e.type === 0x58).map(e => [e.tick, e.data]), [[0, [4, 2, 24, 8]], [3840, [7, 3, 24, 8]]]);
assert.deepEqual(tracks[0].find(e => e.type === 0x51).data, [10, 44, 43]);
const events = tracks[2].filter(e => e.status);
assert.deepEqual(events.filter(e => (e.status & 240) === 144).map(e => [e.tick, e.pitch, e.velocity]), [[0, 62, 64], [1920, 60, 64], [3840, 64, 64]]);
assert.equal(tracks[1].find(e => e.status).tick, 960, 'trimmed note is chased at clip start');
assert.equal(tracks[1].filter(e => e.status).at(-1).tick, 2880, 'long notes stop at clip end');
assert.equal(parseMidiFile(result.bytes).clips.filter(c => c.notes.length).length, 2, 'standard parser can import exported tracks');

for (const bends of [
  [{ t: 2, d: 3, r: 0 }],
  [{ t: 1, d: -3, r: 1 }, { t: 2, d: 3, r: 0 }],
  [{ t: 1, d: 3, r: 0.5 }, { t: 2, d: -2, r: 0 }],
]) {
  const n = { ...note(60, 0, 3), bends };
  const segments = midiNoteSegments(n);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, 3);
  for (let t = 0.0001; t < 3; t += 0.0037) {
    const segment = segments.find(s => s.start <= t && t < s.end);
    assert.equal(segment.pitch, Math.round(notePitchAt(n, t)), `bend pitch matches playback at ${t}`);
  }
}
assert.deepEqual(midiNoteSegments({ ...note(60, 0, 2), bends: [{ t: 2, d: 2, r: 0 }] }),
  [{ start: 0, end: 0.5, pitch: 60 }, { start: 0.5, end: 1.5, pitch: 61 }, { start: 1.5, end: 2, pitch: 62 }]);
for (const [pitch, offset, bend] of [[125, 0, 20], [1, 0, -20], [125, 4, -20], [1, -4, 20]]) {
  const n = { ...note(pitch, 0, 2), bends: [{ t: 2, d: bend, r: 0 }] };
  const segments = midiNoteSegments(n, 0.2, 1.9, offset);
  for (let t = 0.2001; t < 1.9; t += 0.0037) {
    const segment = segments.find(s => s.start <= t && t < s.end);
    assert.equal(segment.pitch, Math.round(Math.max(0, Math.min(127, notePitchAt(n, t) + offset))), 'range-clipped bends and global transpose match playback');
  }
}
const bent = emptySong();
addClip(bent, { target: 1, start: 0, length: 2 }).notes = [{ ...note(60, 0, 2), bends: [{ t: 2, d: 2, r: 0 }] }];
assert.deepEqual(decode(exportMidi(bent).bytes)[1].filter(e => (e.status & 240) === 144).map(e => [e.tick, e.pitch]), [[0, 60], [480, 61], [1440, 62]]);
const overlap = emptySong();
addClip(overlap, { target: 1, start: 0, length: 4 }).notes = [note(60, 0, 3), note(60, 1, 3), note(61, 0, 1, 0)];
assert.deepEqual(decode(exportMidi(overlap).bytes)[1].filter(e => e.status).map(e => [e.tick, e.pitch]),
  [[0, 60], [3840, 60]], 'overlapping equal pitches sustain to the final end; zero start velocity stays silent');
assert.equal(exportMidi(emptySong()).tracks, 0, 'empty song is a valid conductor-only MIDI');
assert.throws(() => exportMidi(song, { bpm: 0 }), /tempo/);
assert.throws(() => exportMidi({ ...song, clips: [{ ...clip, start: 1e9 }] }), /tick range/);
console.log('MIDI export tests passed');
