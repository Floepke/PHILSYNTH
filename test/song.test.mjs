import assert from 'node:assert/strict';
import {
  snapStep, snapRound, snapFloor, normalizeSong, emptySong, addClip, duplicateClip, removeClip,
  trimClipStart, loopEnd, notesStarting, isBlack, inPiano, formatPos, noteName, clean,
  meter, barLines, beatLines, barRound, barCeil, barLength, setSig, removeSig, normalizeSigs,
  addAutoClip, isAuto, autoValue, automationAt, pointIndex,
  notePoints, noteVelAt, groupVelCurve, applyVelCurve,
} from '../src/song.js';
import { Transport } from '../src/transport.js';

// ---- snap grid: base note value ÷ divider ----
assert.equal(snapStep({ base: 4, div: 1 }), 1);
assert.equal(snapStep({ base: 16, div: 1 }), 0.25);
assert.equal(snapStep({ base: 8, div: 3 }), 1 / 6); // eighth triplets
assert.equal(snapStep({ base: 1, div: 1 }), 4); // whole note
assert.equal(snapStep({ base: 2, div: 1 }), 2); // half note
assert.equal(snapStep({ base: 1, div: 3 }), 4 / 3); // whole-note triplets
assert.equal(snapRound(0.34, 1 / 3), 0.333333333);
assert.equal(snapRound(0.7, 1 / 3), 0.666666667);
assert.equal(snapFloor(0.99, 0.25), 0.75);
assert.equal(snapFloor(0.75, 0.25), 0.75);
assert.equal(snapFloor(3 * (1 / 3), 1 / 3), 1); // no float-noise step back
assert.equal(snapRound(0.1 + 0.2, 0.1), 0.3);

// ---- keys ----
assert.deepEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map(isBlack),
  [false, true, false, true, false, false, true, false, true, false, true, false]);
assert.ok(inPiano(21) && inPiano(108) && !inPiano(20) && !inPiano(109));
assert.equal(noteName(60), 'C4');
assert.equal(noteName(21), 'A0');

// ---- normalize ----
const n = normalizeSong({
  snap: { base: 7, div: 0 },
  clips: [
    { id: 3, start: -2, length: 2, y: 10, target: 1, notes: [{ pitch: 60.5, start: 0, length: 1 }, { pitch: 'x' }, { pitch: 200, start: 0, length: 1, vel: 5 }] },
    { id: 3, start: 4 }, // duplicate id gets a new one
  ],
  selected: 3,
});
assert.deepEqual(n.snap, { base: 16, div: 1 });
assert.deepEqual(normalizeSong({ snap: { base: 1, div: 3 } }).snap, { base: 1, div: 3 }, 'whole-note base is kept');
assert.equal(normalizeSong({ snap: { base: 2 } }).snap.base, 2, 'half-note base is kept');
assert.equal(n.clips[0].start, 0);
assert.equal(n.clips[0].notes.length, 2);
assert.equal(n.clips[0].notes[0].pitch, 60.5);
assert.equal(n.clips[0].notes[0].vel, 0.8);
assert.equal(n.clips[0].notes[1].pitch, 127);
assert.equal(n.clips[0].notes[1].vel, 1);
assert.equal(n.clips[1].id, 4);
assert.equal(n.clips[1].length, 4);
assert.equal(n.nextId, 5);
assert.equal(n.selected, 3);
assert.deepEqual(normalizeSong(null), emptySong());
assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(n))), n); // save/load round trip

// ---- clip editing ----
const s = emptySong();
const a = addClip(s, { start: 4, length: 4, target: 2 });
a.notes.push({ pitch: 60, start: 1, length: 1, vel: 0.8 });
const b = duplicateClip(s, a);
assert.notEqual(b.id, a.id);
assert.notEqual(b.notes, a.notes);
b.notes[0].pitch = 61;
assert.equal(a.notes[0].pitch, 60);
const orig = structuredClone(a);
trimClipStart(a, 4.5, orig); // notes keep their song position
assert.equal(a.start, 4.5);
assert.equal(a.length, 3.5);
assert.equal(a.start + a.notes[0].start, 5);
assert.ok(removeClip(s, b.id));
assert.equal(s.clips.length, 1);

// ---- events ----
const song = emptySong();
const c1 = addClip(song, { start: 0, length: 2, target: 1 });
c1.notes.push(
  { pitch: 60, start: 0, length: 1, vel: 1 },
  { pitch: 64, start: 1.5, length: 4, vel: 1 }, // cut at the clip end
  { pitch: 67, start: 2, length: 1, vel: 1 }, // starts at the clip end: never plays
  { pitch: 69, start: -1, length: 1, vel: 1 }, // trimmed away
);
const c2 = addClip(song, { start: 4, length: 1.5, target: 2 });
c2.notes.push({ pitch: 72, start: 0.5, length: 0.5, vel: 0.5 });
assert.equal(loopEnd(song), 8); // 5.5 rounded up to two bars
assert.deepEqual(notesStarting(song, 0, 10).map((e) => [e.note.pitch, e.start, e.end]), [[60, 0, 1], [64, 1.5, 2], [72, 4.5, 5]]);
assert.deepEqual(notesStarting(song, 0, 1.5).map((e) => e.note.pitch), [60]);
assert.equal(formatPos(0), '1.1.00');
assert.equal(formatPos(5.5), '2.2.50');

// ---- transport ----
const log = [];
const synth = (name) => ({
  noteOn: (id, p, v) => log.push(['on', name, p, v, id]),
  noteOff: (id) => log.push(['off', name, id]),
});
const targets = { 1: synth('A'), 2: synth('B') };
let now = 0;
const ticker = () => ({ start() {}, stop() {} });
const states = [];
const run = (ms) => { while (now < ms) { now = Math.min(ms, now + 5); t.tick(); } };
const t = new Transport({ getSong: () => song, getBpm: () => 60, getTarget: (id) => targets[id] ?? null, now: () => now, ticker, onState: (x) => states.push(x.playing) });
assert.ok(t.play());
run(1);
assert.deepEqual(log.map((l) => l.slice(0, 3)), [['on', 'A', 60]]); // the note at the start position
run(1005); // 1 quarter at 60 BPM
assert.ok(Math.abs(t.pos - 1.005) < 1e-9);
assert.deepEqual(log.slice(1).map((l) => l.slice(0, 2)), [['off', 'A']]);
run(1600);
assert.deepEqual(log.at(-1).slice(0, 3), ['on', 'A', 64]);
run(2010);
assert.deepEqual(log.at(-1).slice(0, 2), ['off', 'A']); // cut at the clip end
run(4610);
assert.deepEqual(log.at(-1).slice(0, 4), ['on', 'B', 72, 0.5]);
log.length = 0;
run(4900); run(5100);
assert.deepEqual(log.map((l) => l[0]), ['off']);
// loop: wraps at bar 3 (8 quarters) and plays the first note again
log.length = 0;
run(8050);
assert.ok(Math.abs(t.pos - 0.05) < 1e-9);
assert.deepEqual(log.map((l) => l.slice(0, 3)), [['on', 'A', 60]]);
// stop releases sounding notes
log.length = 0;
t.stop();
assert.deepEqual(log.map((l) => l[0]), ['off']);
assert.deepEqual(states, [true, false]);
// a missing target is skipped; an empty song does not play
c1.target = 99;
t.seek(0); log.length = 0; t.play(); t.stop();
assert.equal(log.length, 0);
assert.equal(new Transport({ getSong: emptySong, getBpm: () => 120, getTarget: () => null, ticker }).play(), false);
// note ids are unique even for the same pitch
c1.target = 1;
t.seek(0); log.length = 0; t.play(); run(now + 16000);
const ids = log.filter((l) => l[0] === 'on').map((l) => l[4]);
assert.equal(new Set(ids).size, ids.length);
t.stop();

// snapped triplet edges stay free of float noise
{
  const st = snapStep({ base: 4, div: 3 });
  assert.equal(clean(snapRound(11.6, st) - 5), 6.666666667);
  const c = { start: 0, length: 8, notes: [{ pitch: 60, start: 1, length: 1, vel: 0.8 }] };
  trimClipStart(c, snapRound(1.3, st), structuredClone(c));
  assert.equal(c.length, 6.666666667);
}

// time signatures
{
  const song = emptySong();
  assert.deepEqual(song.sigs, [{ at: 0, num: 4, den: 4 }]);
  assert.deepEqual(barLines(song, 0, 8).map((b) => b.t), [0, 4, 8]);
  assert.deepEqual(beatLines(song, 0, 4), [1, 2, 3]);
  assert.ok(setSig(song, 8, 7, 8)); // bars 3.. are 7/8 (3.5 quarters)
  assert.ok(!setSig(song, 4, 5, 3)); // invalid denominator
  assert.deepEqual(barLines(song, 0, 16).map((b) => [b.t, b.bar]), [[0, 0], [4, 1], [8, 2], [11.5, 3], [15, 4]]);
  assert.deepEqual(beatLines(song, 8, 11.5), [8.5, 9, 9.5, 10, 10.5, 11]); // 6 dashed + 2 bar lines = 7 beats
  assert.equal(barLength(song, 9), 3.5);
  assert.equal(barRound(song, 10.5), 11.5);
  assert.equal(barCeil(song, 8.1), 11.5);
  assert.equal(formatPos(11.5 + 1.25, song), '4.3.50'); // bar 4, beat 3 (eighths), halfway
  song.clips.push({ id: 1, name: 'a', start: 8, length: 1, y: 0, target: null, notes: [] });
  assert.equal(loopEnd(song), 11.5);
  // a change inside a bar cuts that bar short; later bars count on from the change
  setSig(song, 2, 3, 4);
  assert.deepEqual(barLines(song, 0, 9).map((b) => [b.t, b.bar]), [[0, 0], [2, 1], [5, 2], [8, 3]]);
  assert.ok(removeSig(song, 2));
  assert.ok(!removeSig(song, 0)); // the first one stays
  setSig(song, 0, 3, 4); // but can be changed
  assert.deepEqual(song.sigs.map((x) => `${x.at}:${x.num}/${x.den}`), ['0:3/4', '8:7/8']);
  assert.deepEqual(meter(song).map((x) => x.bar), [0, 3]); // 8 quarters of 3/4 = 2⅔ → 3 bars
  // loading: invalid entries dropped, sorted, 4/4 at 0 added when missing
  assert.deepEqual(normalizeSigs([{ at: 6, num: 5, den: 8 }, { at: 2, num: 0, den: 4 }, null]), [{ at: 0, num: 4, den: 4 }, { at: 6, num: 5, den: 8 }]);
  assert.deepEqual(normalizeSong({ clips: [] }).sigs, [{ at: 0, num: 4, den: 4 }]);
}

// automation clips
{
  const song = emptySong();
  const a = addAutoClip(song, { start: 4, length: 4, target: 1, controller: 3 });
  assert.ok(isAuto(a));
  assert.equal(a.name, `Auto ${a.id}`);
  assert.deepEqual(a.notes, []);
  assert.equal(autoValue(a, 1), null, 'no points: no value');
  assert.deepEqual(automationAt(song, 5), [], 'clips without points do nothing');
  a.points.push({ t: 1, v: 0, r: 0 }, { t: 3, v: 1, r: 0 });
  assert.equal(autoValue(a, 0), 0, 'holds before the first point');
  assert.ok(Math.abs(autoValue(a, 2) - 0.5) < 1e-9, 'linear between points');
  assert.equal(autoValue(a, 3.9), 1, 'holds after the last point');
  assert.equal(pointIndex(a.points, 2), 1);
  assert.equal(pointIndex(a.points, 3), 2, 'same time goes after');
  // rounding a corner bends the curve off the straight lines
  a.points.splice(1, 0, { t: 2, v: 1, r: 0 });
  const sharp = autoValue(a, 1.9);
  a.points[1].r = 1;
  assert.ok(autoValue(a, 1.9) < sharp, 'rounded corner stays below the sharp peak');
  assert.equal(autoValue(a, 2.9), 1, 'flat part after the corner');
  a.points[1].r = 0;
  const at = automationAt(song, 6);
  assert.equal(at.length, 1);
  assert.equal(at[0].clip, a);
  assert.equal(at[0].value, 1);
  assert.deepEqual(automationAt(song, 8), [], 'clip end is exclusive');
  assert.deepEqual(automationAt(song, 3.9), []);
  // normalising keeps automation fields; note clips stay without them
  const n = addClip(song, { start: 0, length: 4 });
  const loaded = normalizeSong(JSON.parse(JSON.stringify({ ...song, clips: [...song.clips, { ...a, id: 99, points: [{ t: 2, v: 3, r: -1 }, { t: 1, v: 0.5 }, { t: 'x', v: 1 }] }] })));
  const la = loaded.clips.find((c) => c.id === a.id);
  assert.equal(la.kind, 'auto');
  assert.equal(la.controller, 3);
  assert.deepEqual(la.points, a.points);
  assert.deepEqual(loaded.clips.find((c) => c.id === 99).points, [{ t: 1, v: 0.5, r: 0 }, { t: 2, v: 1, r: 0 }], 'sorted, clamped, invalid dropped');
  const ln = loaded.clips.find((c) => c.id === n.id);
  assert.equal('kind' in ln, false);
  assert.equal('points' in ln, false);
  // duplicate copies the points, trimming the start shifts them
  const d = duplicateClip(song, a);
  assert.ok(isAuto(d) && d.points !== a.points && d.points.length === 3);
  const orig = structuredClone(a);
  a.start = 5; a.length = 3;
  trimClipStart(a, 5, orig);
  assert.deepEqual(a.points.map((p) => p.t), [0, 1, 2]);
}

// velocity curves
{
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  const n = { pitch: 60, start: 2, length: 4, vel: 0.5 };
  assert.equal(noteVelAt(n, 3), 0.5, 'no curve: constant');
  n.vels = [{ t: 2, v: 1, r: 0 }];
  near(noteVelAt(n, 1), 0.75);
  assert.equal(noteVelAt(n, 3.5), 1, 'holds after the last point');
  assert.deepEqual(notePoints(n)[0], { t: 0, v: 0.5, r: 0 });
  // saved and loaded; invalid / t = 0 points dropped, plain notes stay plain
  const song = emptySong();
  const c = addClip(song, { length: 8 });
  c.notes.push({ ...n, vels: [{ t: 0, v: 0.2 }, { t: 2, v: 1, r: 0 }, { t: 'x', v: 0 }] }, { pitch: 62, start: 0, length: 1, vel: 0.3 });
  const loaded = normalizeSong(JSON.parse(JSON.stringify(song))).clips[0].notes;
  assert.deepEqual(loaded[0].vels, [{ t: 2, v: 1, r: 0 }]);
  assert.equal('vels' in loaded[1], false);

  // one note: its own curve in clip time
  assert.deepEqual(groupVelCurve([n]), [{ t: 2, v: 0.5, r: 0 }, { t: 4, v: 1, r: 0 }]);
  // equal constant notes: one value
  const a = { pitch: 60, start: 0, length: 1, vel: 0.6 };
  const b = { pitch: 64, start: 0, length: 1, vel: 0.6 };
  const d = { pitch: 67, start: 2, length: 2, vel: 0.6 };
  assert.deepEqual(groupVelCurve([a, b, d]), [{ t: 0, v: 0.6, r: 0 }]);
  // chord notes with different velocities average at their shared start
  b.vel = 0.8;
  assert.deepEqual(groupVelCurve([a, b, d]).map((p) => +p.v.toFixed(6)), [0.7, 0.6]);
  // a ramp from 0 at t=0 to 1 at t=4: every note follows it
  applyVelCurve([a, b, d], [{ t: 0, v: 0, r: 0 }, { t: 4, v: 1, r: 0 }]);
  assert.equal(a.vel, 0); assert.equal(b.vel, 0);
  assert.deepEqual(a.vels, [{ t: 1, v: 0.25, r: 0 }], 'value at the note end where the line continues');
  near(d.vel, 0.5);
  assert.deepEqual(d.vels, [{ t: 2, v: 1, r: 0 }]);
  near(noteVelAt(d, 1), 0.75);
  // and the group curve read back from the notes is the same line
  assert.deepEqual(groupVelCurve([a, b, d]).map((p) => [p.t, +p.v.toFixed(6)]), [[0, 0], [1, 0.25], [2, 0.5], [4, 1]]);
  // a flat curve removes the note curves again
  applyVelCurve([a, b, d], [{ t: 0, v: 0.9, r: 0 }]);
  for (const x of [a, b, d]) { assert.equal(x.vel, 0.9); assert.equal('vels' in x, false); }
  // points beyond a note's end inside its own curve are cut at the end
  const long = { pitch: 60, start: 0, length: 1, vel: 0, vels: [{ t: 2, v: 1, r: 0 }] };
  assert.deepEqual(groupVelCurve([long]), [{ t: 0, v: 0, r: 0 }, { t: 1, v: 0.5, r: 0 }]);
}

console.log('song tests passed');
