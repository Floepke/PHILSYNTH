import assert from 'node:assert/strict';
import { emptySong, addClip, addAutoClip, removeClip, notesSounding } from '../src/song.js';
import { Transport } from '../src/transport.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const note = (pitch, start = 0, length = 1) => ({ pitch, start, length, vel: 0.7 });

function setup() {
  const song = emptySong();
  const selected = addClip(song, { start: 4.25, length: 0.5, target: 1 });
  selected.notes.push(note(60, 0, 1), note(64, 0.25, 0.1), note(67, 0.5), note(69, -0.25));
  const other = addClip(song, { start: 4.25, length: 1, target: 2 });
  other.notes.push(note(80));
  const first = addClip(song, { start: 0, length: 1, target: 3 });
  first.notes.push(note(48));
  song.selected = selected.id;
  let now = 0;
  let starts = 0;
  let stops = 0;
  const events = [];
  const targets = new Map([1, 2, 3].map((target) => [target, {
    noteOn(id, pitch, vel) { events.push({ type: 'on', target, id, pitch, vel }); },
    noteOff(id) { events.push({ type: 'off', target, id }); },
  }]));
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: (id) => targets.get(id),
    now: () => now, ticker: () => ({ start() { starts++; }, stop() { stops++; } }),
  });
  const tick = (ms) => { now += ms; transport.tick(); };
  const run = (ms) => { for (let left = ms; left > 0; left -= 5) tick(Math.min(left, 5)); };
  return { song, selected, other, transport, events, tick, run, starts: () => starts, stops: () => stops };
}

// Slash playback starts at the clip's absolute start and ignores every other clip.
{
  const { selected, transport, events, run } = setup();
  transport.seek(10);
  assert.equal(transport.playClip(selected.id), true);
  assert.equal(transport.clipId, selected.id);
  assert.equal(transport.pos, 4.25);
  run(260);
  near(transport.pos, 4.27);
  assert.deepEqual(events.filter((e) => e.type === 'on').map((e) => e.pitch), [60, 64, 60]);
  assert.ok(events.every((e) => e.target === 1));
  const firstOn = events.find((e) => e.type === 'on');
  assert.ok(events.some((e) => e.type === 'off' && e.id === firstOn.id));
  assert.equal(transport.active.length, 1);
  near(transport.active[0].end, 4.75);
  transport.stop();
  assert.equal(transport.playing, false);
  assert.equal(transport.clipId, null);
  assert.equal(transport.active.length, 0);
  transport.stop({ to: 3 });
  assert.equal(transport.pos, 3, 'stop can park the playhead');
  transport.stop();
  assert.equal(transport.pos, 3, 'plain stop keeps the position');
}

// Restarting the selected clip releases existing notes and retriggers the first note.
{
  const { selected, transport, events, run } = setup();
  transport.playClip(selected.id);
  run(100);
  const firstId = transport.active[0].id;
  transport.playClip(selected.id);
  assert.equal(transport.pos, selected.start);
  assert.ok(events.some((e) => e.type === 'off' && e.id === firstId));
  run(5);
  assert.notEqual(transport.active[0].id, firstId);
  transport.stop();
}

// Period resumes song playback and exits clip-only mode without stopping an already playing song.
{
  const { selected, transport, events, run, starts } = setup();
  transport.playClip(selected.id);
  run(5);
  transport.seek(selected.start);
  assert.ok(transport.play());
  assert.equal(transport.clipId, null);
  assert.equal(transport.pos, selected.start);
  run(5);
  assert.deepEqual(events.filter((e) => e.type === 'on').slice(-2).map((e) => e.pitch), [60, 80]);
  const before = { pos: transport.pos, starts: starts(), active: [...transport.active] };
  assert.ok(transport.play());
  assert.equal(transport.pos, before.pos);
  assert.equal(starts(), before.starts);
  assert.deepEqual(transport.active, before.active);
  transport.stop();
  const stoppedAt = transport.pos;
  assert.ok(transport.play());
  assert.equal(transport.pos, stoppedAt);
  transport.stop();
}

// Comma always starts the whole song at zero, even during clip or song playback.
{
  const { selected, transport, events, run } = setup();
  transport.playClip(selected.id);
  run(5);
  const activeId = transport.active[0].id;
  assert.ok(transport.play({ fromStart: true }));
  assert.equal(transport.pos, 0);
  assert.equal(transport.clipId, null);
  assert.ok(events.some((e) => e.type === 'off' && e.id === activeId));
  run(100);
  assert.equal(events.filter((e) => e.type === 'on').at(-1).pitch, 48);
  assert.ok(transport.play({ fromStart: true }));
  assert.equal(transport.pos, 0);
  run(5);
  assert.equal(events.filter((e) => e.type === 'on').at(-1).pitch, 48);
  transport.stop();
}

// Switching selection does not silently switch the running loop; slash explicitly selects it.
{
  const { song, selected, other, transport, events, run } = setup();
  transport.playClip(selected.id);
  song.selected = other.id;
  run(5);
  assert.equal(transport.clipId, selected.id);
  assert.ok(events.every((e) => e.target === 1));
  transport.playClip(song.selected);
  run(5);
  assert.equal(transport.clipId, other.id);
  assert.equal(events.filter((e) => e.type === 'on').at(-1).pitch, 80);
  transport.stop();
}

// Seeking stays within the clip; moving/shrinking/deleting the looped clip cannot leak playback.
{
  const { song, selected, transport, run } = setup();
  transport.playClip(selected.id);
  transport.seek(4.4);
  assert.equal(transport.pos, 4.4);
  transport.seek(0);
  assert.equal(transport.pos, 4.25);
  transport.seek(4.75);
  assert.equal(transport.pos, 4.25);
  selected.start = 8;
  run(5);
  near(transport.pos, 8.01);
  transport.seek(8.4);
  selected.length = 0.1;
  run(5);
  assert.ok(transport.pos >= 8 && transport.pos < 8.1);
  removeClip(song, selected.id);
  run(5);
  assert.equal(transport.playing, false);
  assert.equal(transport.clipId, null);
  assert.equal(transport.active.length, 0);
}

// Sub-tick loops are bounded and always wrap into the actual clip, even after a stalled tick.
{
  const { selected, transport, tick, events } = setup();
  selected.length = 0.001;
  selected.notes = [note(60, 0, 1)];
  transport.playClip(selected.id);
  tick(249);
  assert.ok(transport.pos >= selected.start && transport.pos < selected.start + selected.length);
  assert.ok(events.filter((e) => e.type === 'on').length <= 5);
  assert.ok(transport.active.length <= 1);
  tick(5000);
  assert.ok(transport.pos >= selected.start && transport.pos < selected.start + selected.length);
  transport.stop();
  const ons = events.filter((e) => e.type === 'on');
  assert.equal(new Set(ons.map((e) => e.id)).size, ons.length);
  assert.equal(events.filter((e) => e.type === 'off').length, ons.length);
}

// Missing selection is reported by the caller, not a fallback to whole-song playback.
{
  const { song, transport, stops } = setup();
  assert.equal(transport.playClip(null), false);
  assert.equal(transport.playClip(999), false);
  assert.equal(transport.playing, false);
  transport.play();
  assert.equal(transport.playClip(null), false);
  assert.equal(transport.playing, true);
  assert.equal(transport.clipId, null);
  assert.equal(transport.toggle(), false);
  assert.equal(transport.playing, false);
  assert.equal(transport.toggle(), true);
  song.clips = [];
  assert.equal(transport.play({ fromStart: true }), false);
  assert.equal(transport.playing, false);
  assert.ok(stops() >= 2);
}

// Note chasing: starting or jumping into the middle of a note triggers it for its remaining length.
{
  const song = emptySong();
  const clip = addClip(song, { start: 2, length: 4, target: 1 });
  clip.notes.push(note(60, 0, 2), note(62, 1, 0.5), note(64, 1.5, 4), note(65, 3, 1));
  // 60: 2..4, 62: 3..3.5, 64: 3.5..6 (clipped to the clip end), 65: 5..6
  assert.deepEqual(notesSounding(song, 3.25).map((e) => e.note.pitch), [60, 62]);
  assert.deepEqual(notesSounding(song, 2).map((e) => e.note.pitch), [], 'a note starting exactly at q is not chased');
  assert.deepEqual(notesSounding(song, 4).map((e) => e.note.pitch), [64], 'a note ending exactly at q is not chased');
  near(notesSounding(song, 5.5).find((e) => e.note.pitch === 64).end, 6);
  assert.deepEqual(notesSounding(song, 6).map((e) => e.note.pitch), []);

  let now = 0;
  const events = [];
  const inst = {
    noteOn(id, pitch, vel) { events.push({ type: 'on', id, pitch, vel }); },
    noteOff(id) { events.push({ type: 'off', id }); },
  };
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: (t) => (t === 1 ? inst : null),
    now: () => now, ticker: () => ({ start() {}, stop() {} }),
  });
  const run = (ms) => { for (let left = ms; left > 0; left -= 5) { now += 5; transport.tick(); } };
  const ons = () => events.filter((e) => e.type === 'on').map((e) => e.pitch);

  // play from the middle of notes 60 and 62
  transport.seek(3.25);
  assert.equal(events.length, 0, 'nothing sounds before playback starts');
  transport.play();
  run(5);
  assert.deepEqual(ons(), [60, 62]);
  assert.equal(events.find((e) => e.pitch === 60).vel, 0.7);
  near(transport.active.find((n) => n.end === 4).end, 4);
  run(125); // 3.25 + 0.25 q = 3.5: chased 62 ends, 64 starts
  assert.deepEqual(ons(), [60, 62, 64]);
  const id62 = events.find((e) => e.pitch === 62).id;
  assert.ok(events.some((e) => e.type === 'off' && e.id === id62), 'chased note ends at its normal end');

  // jumping while playing: release everything, then chase at the new position
  events.length = 0;
  transport.seek(5.5);
  assert.equal(events.filter((e) => e.type === 'on').length, 0);
  assert.equal(events.filter((e) => e.type === 'off').length, 2, 'sounding notes released on seek');
  run(5);
  assert.deepEqual(ons(), [64, 65]);
  transport.stop();

  // a note starting exactly at the start position plays once (normal note-on, not chased too)
  events.length = 0;
  transport.seek(3.5);
  transport.play();
  run(5);
  assert.deepEqual(ons(), [60, 64]);
  transport.stop();

  // clip loop mode chases only notes of that clip, at the clip start after each wrap nothing extra
  const other = addClip(song, { start: 2, length: 4, target: 1 });
  other.notes.push(note(90, 0, 4));
  events.length = 0;
  transport.playClip(clip.id);
  run(5);
  assert.deepEqual(ons(), [60]);
  run(2000); // wraps once (4 q at 120 BPM = 2 s)
  assert.ok(!ons().includes(90));
  assert.equal(ons().filter((p) => p === 60).length, 2, 'loop restart retriggers the first note once');
  transport.stop();

  // chasing can be switched off
  transport.chase = false;
  events.length = 0;
  removeClip(song, other.id);
  transport.seek(3.25);
  transport.play();
  run(5);
  assert.deepEqual(ons(), []);
  transport.stop();
}

// Automation clips drive their controller only while the playhead is inside them.
{
  const song = emptySong();
  const a = addAutoClip(song, { start: 1, length: 2, target: 5, controller: 2 });
  a.points.push({ t: 0, v: 0, r: 0 }, { t: 2, v: 1, r: 0 });
  const b = addAutoClip(song, { start: 0, length: 4, target: 6 }); // no points: ignored
  const notes = addClip(song, { start: 0, length: 4, target: 1 });
  notes.notes.push(note(60, 0, 4));
  let now = 0;
  const calls = [];
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: () => ({ noteOn() {}, noteOff() {} }),
    setAuto: (id, clip, v) => calls.push({ id, clip, v }),
    now: () => now, ticker: () => ({ start() {}, stop() {} }),
  });
  const run = (ms) => { for (let left = ms; left > 0; left -= 5) { now += 5; transport.tick(); } };
  transport.play({ fromStart: true });
  run(400); // 0.8 quarters: before the clip
  assert.deepEqual(calls, []);
  run(600); // 2 quarters: halfway
  const last = calls.at(-1);
  assert.equal(last.id, a.id);
  assert.equal(last.clip, a);
  assert.ok(Math.abs(last.v - 0.5) < 0.02, `halfway value ${last.v}`);
  assert.ok(calls.every((c) => c.id === a.id && c.clip), 'only the clip with points is applied');
  run(1100); // 4.2 quarters: past the clip -> released once
  const releases = calls.filter((c) => c.clip === null);
  assert.deepEqual(releases.map((c) => c.id), [a.id]);
  assert.ok(calls.filter((c) => c.clip).every((c) => c.v >= 0 && c.v <= 1));
  assert.ok(Math.max(...calls.filter((c) => c.clip).map((c) => c.v)) > 0.95);
  // stop inside the clip releases it
  calls.length = 0;
  transport.seek(1.5);
  transport.play();
  run(50);
  assert.ok(calls.length && calls.at(-1).clip === a);
  transport.stop();
  assert.deepEqual(calls.at(-1), { id: a.id, clip: null, v: null });
  // clip loop mode only applies the looped clip
  calls.length = 0;
  transport.playClip(notes.id);
  run(1500);
  assert.deepEqual(calls, [], 'looping a note clip ignores automation clips');
  transport.stop();
  transport.playClip(a.id);
  run(100);
  assert.ok(calls.length && calls.every((c) => c.id === a.id));
  transport.stop();
  void b;
}

// Velocity curves are followed with noteMod while notes sound; chased notes start on the curve.
{
  const song = emptySong();
  const c = addClip(song, { start: 0, length: 8, target: 1 });
  c.notes.push({ pitch: 60, start: 0, length: 4, vel: 0, vels: [{ t: 4, v: 1, r: 0 }] });
  let now = 0;
  const ev = [];
  const inst = {
    noteOn: (id, pitch, vel) => ev.push({ type: 'on', id, vel }),
    noteMod: (id, pitch, vel) => ev.push({ type: 'mod', id, pitch, vel }),
    noteOff: (id) => ev.push({ type: 'off', id }),
  };
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: () => inst,
    now: () => now, ticker: () => ({ start() {}, stop() {} }),
  });
  const run = (ms) => { for (let left = ms; left > 0; left -= 5) { now += 5; transport.tick(); } };
  transport.play({ fromStart: true });
  run(1000); // 2 quarters
  assert.equal(ev[0].type, 'on');
  assert.equal(ev[0].vel, 0);
  const mods = ev.filter((e) => e.type === 'mod');
  assert.ok(mods.length > 50 && mods.every((m) => m.id === ev[0].id && m.pitch === 60));
  assert.ok(Math.abs(mods.at(-1).vel - 0.5) < 0.01, `halfway ${mods.at(-1).vel}`);
  // live edit while sounding: a flat velocity is applied on the next tick
  c.notes[0].vel = 0.2;
  delete c.notes[0].vels;
  run(5);
  assert.equal(ev.at(-1).vel, 0.2);
  const count = ev.length;
  run(50);
  assert.equal(ev.length, count, 'no messages while the velocity stays the same');
  transport.stop();
  // chasing into the ramp
  c.notes[0].vel = 0;
  c.notes[0].vels = [{ t: 4, v: 1, r: 0 }];
  ev.length = 0;
  transport.seek(3);
  transport.play();
  run(5);
  assert.ok(Math.abs(ev[0].vel - 0.75) < 0.01, `chased at ${ev[0].vel}`);
  transport.stop();
}

console.log('transport mode tests passed');
