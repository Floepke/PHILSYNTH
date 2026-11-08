import assert from 'node:assert/strict';
import { parseMidiFile, midiTempoClip } from '../src/midiimport.js';
import { MAX_MIDI_BYTES } from '../src/fileformat.js';
import { normalizeSong, emptySong, autoValue } from '../src/song.js';
import { fromNorm } from '../src/params.js';
import out from '../src/modules/out.js';
import { Transport } from '../src/transport.js';

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
const tempo = (delta, value) => event(delta, 0xff, 0x51, 3, value >> 16 & 255, value >> 8 & 255, value & 255);
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
  const us = 497925;
  const bytes = midi(1, 480,
    track(tempo(0, us), tempo(480, 600000), event(480, 0xff, 0x2f, 0)),
    track(event(240, 0x90, 60, 100), event(480, 0x80, 60, 0), event(240, 0xff, 0x2f, 0)));
  const without = parseMidiFile(bytes);
  assert.equal(without.tempoEvents, null);
  assert.equal(without.clips[1].notes[0].start, 0.5);
  assert.equal(without.clips[1].notes[0].length, 1);
  const result = parseMidiFile(bytes, 'song.mid', { importTempo: true });
  const beatChange = us / 1000000 * 121 / 60;
  close(result.tempoEvents[1].t, beatChange);
  assert.deepEqual(result.tempoEvents.map((e) => e.bpm), [121, 100]);
  const note = result.clips[1].notes[0];
  close(note.start * 60 / 121, us / 2000000);
  close((note.start + note.length - beatChange) * 60 / 100, 0.3);
  const param = out.params.find((p) => p.id === 'bpm');
  const clip = midiTempoClip(result, 0, out.params.indexOf(param), param);
  assert.equal(clip.target, 0);
  assert.equal(clip.controller, 0);
  assert.deepEqual(clip.points.map((p) => [p.t, fromNorm(param, p.v), p.r]),
    [[0, 121, 0], [beatChange, 121, 0], [beatChange, 100, 0]]);
  assert.equal(fromNorm(param, autoValue(clip, beatChange - 0.000001)), 121);
  assert.equal(fromNorm(param, autoValue(clip, beatChange)), 100);
  const song = emptySong();
  song.clips.push({ ...clip, start: 0, y: 0, id: 1 });
  const restored = normalizeSong(JSON.parse(JSON.stringify(song))).clips[0];
  assert.deepEqual(restored.points, clip.points);
  assert.equal(fromNorm(param, autoValue(restored, beatChange)), 100);

  const playbackSong = emptySong();
  playbackSong.clips = [
    { ...result.clips[1], start: 0, y: 0, id: 1, target: 7 },
    { ...clip, start: 0, y: 34, id: 2 },
  ];
  let bpm = 120, now = 0, noteOn = null, noteOff = null;
  const transport = new Transport({
    getSong: () => playbackSong, getBpm: () => bpm,
    setAuto: (_id, c, value) => { if (c) bpm = fromNorm(param, value); },
    getTarget: () => ({ noteOn() { noteOn = now; }, noteOff() { noteOff = now; } }),
    now: () => now, ticker: () => ({ start() {}, stop() {} }),
  });
  transport.play();
  for (now = 5; now <= 1100; now += 5) {
    transport.tick();
    if (now === 250) assert.equal(bpm, 121);
    if (now === 750) assert.equal(bpm, 100);
  }
  assert.ok(Math.abs(noteOn - 250) <= 5, `note started at ${noteOn} ms`);
  assert.ok(Math.abs(noteOff - 800) <= 10, `note ended at ${noteOff} ms`);
  transport.stop();
}
{
  const file = midi(2, 100,
    track(tempo(0, 1000000), event(100, 0xff, 0x2f, 0)),
    track(tempo(0, 500000), event(0, 0x90, 64, 100), event(100, 0x80, 64, 0), end));
  const result = parseMidiFile(file, 'format2.mid', { importTempo: true });
  assert.equal(result.tempoEvents[0].bpm, 60);
  close(result.clips[1].notes[0].length, 0.5);
}
{
  const division = (256 - 25) * 256 + 40;
  const file = midi(1, division, track(tempo(100, 1000000), event(100, 0xff, 0x2f, 0)),
    track(event(0, 0x90, 60, 90), event(200, 0x80, 60, 0), end));
  const result = parseMidiFile(file, 'smpte.mid', { importTempo: true });
  close(result.tempoEvents[1].t, 0.2);
  close(result.clips[1].notes[0].length, 0.3);
}
{
  const file = midi(0, 100, track(tempo(0, 10000000), event(0, 0x90, 60, 100), event(100, 0x80, 60, 0), end));
  const result = parseMidiFile(file, 'slow.mid', { importTempo: true });
  assert.equal(result.clampedTempos, 1);
  assert.equal(result.tempoEvents[0].bpm, 20);
  close(result.clips[0].notes[0].length * 60 / 20, 10);
  assert.throws(() => parseMidiFile(file, 'x.mid', { importTempo: true, minBpm: 0 }), /BPM controller range/);
}
{
  const file = midi(0, 100, track(tempo(100, 750000), tempo(0, 1000000), event(100, 0xff, 0x2f, 0)));
  const result = parseMidiFile(file, 'change.mid', { importTempo: true });
  assert.deepEqual(result.tempoEvents, [{ t: 0, bpm: 120 }, { t: 1, bpm: 60 }], 'default tempo and last simultaneous event win');
  close(result.clips[0].length, 2);
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
