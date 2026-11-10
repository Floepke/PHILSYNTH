import assert from 'node:assert/strict';
import { MidiRecorder } from '../src/seq/recording.js';
import { Transport } from '../src/transport.js';
import { AudioTransport } from '../src/audiotransport.js';
import { Playback } from '../src/dsp/playback.js';
import { emptySong, addClip, addAutoClip, cloneClip, setSig } from '../src/song.js';

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-7, message ?? `${a} != ${b}`);

function setup({ start = 4, length = 4 } = {}) {
  const song = emptySong();
  const clip = addClip(song, { start, length, target: 1 });
  song.selected = clip.id;
  const beats = [], events = [], errors = [];
  let now = 0, commits = 0, edits = 0;
  const transport = new Transport({
    getSong: () => song, getBpm: () => bpm, getTarget: () => ({
      noteOn: (...args) => events.push(['on', ...args]),
      noteOff: (...args) => events.push(['off', ...args]),
    }),
    now: () => now,
    ticker: () => ({ start() {}, stop() {} }),
    onCountBeat: (beat) => beats.push([beat, now]),
    onState: () => recorder.update(),
  });
  let bpm = 120;
  const recorder = new MidiRecorder({
    transport, song: () => song, clip: () => song.clips.find((c) => c.id === song.selected),
    onState() {}, onNotes: () => edits++, onCommit: () => commits++, onError: (message) => errors.push(message),
  });
  const run = (ms) => {
    const end = now + ms;
    while (now < end - 1e-8) {
      now = Math.min(end, now + 5);
      transport.tick();
      recorder.update();
    }
  };
  const input = (type, key = 'device:0:60', pitch = 60, velocity = 0.75) => recorder.input({ type, key, pitch, velocity });
  return {
    song, clip, transport, recorder, run, input, beats, events, errors,
    commits: () => commits, edits: () => edits, tempo: (value) => { bpm = value; },
  };
}

// Arming alone neither starts transport nor creates clips; count-in waits at the cursor.
{
  const h = setup();
  h.clip.notes.push({ pitch: 48, start: 1, length: 1, vel: 0.5 });
  h.transport.seek(5.25);
  h.recorder.arm();
  assert.equal(h.transport.playing, false);
  assert.equal(h.song.clips.length, 1);
  h.recorder.start();
  assert.equal(h.transport.countingIn, true);
  near(h.transport.pos, 5.25);
  h.input('on');
  h.run(1995);
  h.input('off');
  assert.equal(h.clip.notes.length, 1, 'count-in input is ignored');
  assert.equal(h.events.length, 0, 'even chased notes wait for the count-in');
  near(h.transport.pos, 5.25);
  assert.deepEqual(h.beats, [[0, 0], [1, 500], [2, 1000], [3, 1500]]);
  h.run(10);
  assert.equal(h.transport.countingIn, false);
  assert.ok(h.events.some(([type]) => type === 'on'), 'playback starts after one whole bar');
  h.input('on', 'a', 60, 0.25);
  h.input('on', 'b', 64, 1);
  h.run(115);
  h.input('off', 'a');
  h.run(80);
  h.input('off', 'b');
  assert.deepEqual(h.clip.notes.slice(1).map(({ pitch, vel }) => [pitch, vel]), [[60, 0.25], [64, 1]]);
  near(h.clip.notes[1].start, 1.26);
  near(h.clip.notes[1].length, 0.23);
  near(h.clip.notes[2].length, 0.39);
  h.transport.stop();
  assert.equal(h.recorder.armed, false);
  assert.equal(h.commits(), 1, 'the entire take is one undoable edit');
}

// The meter at the recording start controls the count-in, including denominator and hidden lines.
{
  const h = setup({ start: 4, length: 8 });
  setSig(h.song, 4, 7, 8, []);
  h.transport.seek(5);
  h.recorder.arm();
  h.recorder.start();
  h.run(1745);
  assert.equal(h.transport.countingIn, true);
  assert.deepEqual(h.beats.map(([beat]) => beat), [0, 1, 2, 3, 4, 5, 6]);
  h.run(10);
  assert.equal(h.transport.countingIn, false);
  near(h.transport.pos, 5.01);
  h.transport.stop();
  assert.equal(h.commits(), 0, 'an empty take adds no undo step');
}

// Tempo changes affect the count-in on the same musical clock as playback.
{
  const h = setup();
  h.recorder.arm();
  h.recorder.start({ loop: true });
  h.run(500);
  h.tempo(60);
  h.run(2995);
  assert.equal(h.transport.countingIn, true);
  h.run(10);
  assert.equal(h.transport.countingIn, false);
  assert.deepEqual(h.beats, [[0, 0], [1, 500], [2, 1500], [3, 2500]]);
}

// Loop recording overdubs on every pass; a held note is split at every boundary.
{
  const h = setup({ length: 1 });
  const linked = cloneClip(h.song, h.clip);
  h.recorder.arm();
  h.recorder.start({ loop: true });
  h.run(2100);
  h.input('on', 'held', 60);
  h.run(1300);
  h.input('off', 'held');
  h.input('on', 'new', 67);
  h.run(50);
  h.input('off', 'new');
  near(h.clip.notes[0].start, 0.2);
  near(h.clip.notes[0].length, 0.8);
  near(h.clip.notes[1].start, 0);
  near(h.clip.notes[1].length, 1);
  near(h.clip.notes[2].start, 0);
  near(h.clip.notes[2].length, 0.8);
  near(h.clip.notes[3].start, 0.8);
  near(h.clip.notes[3].length, 0.1);
  assert.equal(linked.notes, h.clip.notes, 'linked clips retain shared notes');
  assert.ok(h.clip.notes.every((n) => n.start >= 0 && n.start + n.length <= h.clip.length + 1e-7));
  assert.equal(h.transport.playing, true);
  assert.ok(h.edits() >= 3, 'completed loop segments are published for next-pass playback');
  h.input('on', 'stop', 72);
  h.run(20);
  h.transport.stop();
  assert.equal(h.clip.notes.at(-1).pitch, 72);
  near(h.clip.notes.at(-1).length, 0.04);
  assert.equal(h.recorder.held.size, 0);
  assert.equal(h.recorder.armed, false);
}

// A single pass ends exactly at the existing clip end, not at a song loop/restart point.
{
  const h = setup({ length: 1 });
  h.transport.seek(4.5);
  h.song.restart = 4;
  h.recorder.arm();
  h.recorder.start();
  h.run(2050);
  h.input('on');
  h.run(300);
  assert.equal(h.transport.playing, false);
  near(h.transport.pos, 5);
  near(h.clip.length, 1);
  near(h.clip.notes[0].start, 0.6);
  near(h.clip.notes[0].length, 0.4);
  assert.equal(h.recorder.armed, false);
}

// Repeated pitches and different inputs/channels keep their independent starts and releases.
{
  const h = setup();
  h.recorder.arm();
  h.recorder.start({ loop: true });
  h.run(2010);
  h.input('on', 'a:0:60');
  h.run(100);
  h.input('on', 'b:1:60');
  h.run(100);
  h.input('on', 'a:0:60');
  h.run(50);
  h.recorder.input({ type: 'allOff', prefix: 'a:0:' });
  assert.equal(h.recorder.held.size, 1);
  h.run(100);
  h.input('off', 'b:1:60');
  assert.equal(h.clip.notes.length, 3);
  near(h.clip.notes[0].length, 0.4);
  near(h.clip.notes[1].length, 0.1);
  near(h.clip.notes[2].length, 0.5);
  h.transport.stop();
}

// Cancelling a count-in does not record; invalid clip/start choices are explicit.
{
  const h = setup();
  h.recorder.arm();
  assert.equal(h.recorder.start(), false, 'the playhead is outside the clip');
  assert.match(h.errors.at(-1), /inside the selected clip/);
  h.recorder.start({ loop: true });
  h.run(500);
  h.input('on');
  h.transport.stop();
  assert.equal(h.clip.notes.length, 0);
  assert.equal(h.recorder.armed, false);
  const auto = addAutoClip(h.song);
  h.song.selected = auto.id;
  h.recorder.arm();
  assert.equal(h.recorder.armed, false);
  assert.match(h.errors.at(-1), /Select a MIDI clip/);
}

// Changing selection or seeking ends the take and keeps its already played duration.
for (const action of ['selection', 'seek']) {
  const h = setup();
  h.recorder.arm();
  h.recorder.start({ loop: true });
  h.run(2010);
  h.input('on');
  h.run(100);
  if (action === 'selection') h.song.selected = addClip(h.song).id;
  else h.transport.seek(4);
  h.recorder.update();
  assert.equal(h.recorder.armed, false);
  near(h.clip.notes[0].length, 0.2);
  h.transport.stop();
}

// The facade interpolates event timestamps against audio time, not UI frame arrival time.
{
  const song = emptySong();
  addClip(song, { length: 4 });
  let audioTime = 10;
  const tr = new AudioTransport({
    getSong: () => song, getBpm: () => 120, getTarget: () => null, now: () => 20000,
  }, { dsp: { post() {} }, sync: async () => {}, onError: (e) => { throw e; }, audioTime: () => audioTime });
  tr.play({ countIn: { beats: 4, beat: 1 } });
  assert.equal(tr.recordingTime(), null, 'a pending start has no recording clock');
  tr.receive({ revision: tr.revision, playing: true, clipId: null, pos: 0, elapsed: -0.5, time: 10, bpm: 120 });
  audioTime = 10.3;
  near(tr.recordingTime(), 0.1);
  near(tr.recordingTime(19.9), -0.1, 'an input received 100 ms late retains its original time');
  tr.stop();
  near(tr.elapsed, 0.1);
  assert.equal(tr.recordingTime(), null);
}

// The count-in is a short sine blip, with the specified pitches, stereo and a rapid fade.
{
  let time = 0;
  const playback = new Playback({}, () => time);
  for (const [beat, hz] of [[0, 440], [1, 220]]) {
    playback.transport.onCountBeat(beat);
    const l = new Float32Array(4800), r = new Float32Array(4800);
    playback.renderCountIn(l, r, 48000);
    assert.deepEqual(l, r);
    for (const i of [25, 100, 1000, 4000]) {
      const t = i / 48000;
      const expected = 0.2 * Math.min(1, t / 0.002) * (1 - t / 0.1) * Math.exp(-t * 55) * Math.sin(2 * Math.PI * hz * t);
      near(l[i], expected);
    }
    const peak = (from, to) => Math.max(...l.slice(from, to).map(Math.abs));
    assert.ok(peak(0, 960) > 10 * peak(3840, 4800), 'the tail decays quickly');
    time += 0.1;
    l.fill(0); r.fill(0);
    playback.renderCountIn(l, r, 48000);
    assert.ok(l.every((v) => v === 0), 'the blip ends within 100 ms');
  }
}

console.log('MIDI recording and count-in tests passed');
