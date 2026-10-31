import assert from 'node:assert/strict';
import {
  snapStep, snapRound, snapFloor, normalizeSong, emptySong, addClip, duplicateClip, removeClip, cloneClip, detachClip, linkedClips, isLinked, isClone, linkSource, LANE_H,
  trimClipStart, loopEnd, notesStarting, isBlack, inPiano, formatPos, noteName, clean,
  meter, barLines, beatLines, barRound, barCeil, barLength, setSig, removeSig, normalizeSigs,
  addAutoClip, isAuto, autoValue, automationAt, pointIndex,
  notePoints, noteVelAt, groupVelCurve, applyVelCurve, canConsolidate, consolidateClips, splitClip,
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
assert.equal(n.clips[0].start, -2, 'clips may be parked before zero');
assert.equal(n.clips[0].y, 0, 'y snaps to a lane');
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

// Linked clones share their notes; detaching copies them; JSON round trips re-share them by link id.
{
  const song = emptySong();
  const a = addClip(song, { length: 4 });
  a.name = 'Bass';
  a.notes.push({ pitch: 40, start: 0, length: 1, vel: 0.8 });
  const dup = duplicateClip(song, a);
  assert.equal(dup.name, 'Bass', 'no copy suffix');
  assert.equal(isLinked(song, a), false);
  const b = cloneClip(song, a);
  const c = cloneClip(song, b);
  assert.equal(b.notes, a.notes);
  assert.equal(c.notes, a.notes);
  assert.equal(linkedClips(song, a).length, 3);
  const dup2 = duplicateClip(song, b);
  assert.equal(dup2.link, undefined);
  assert.notEqual(dup2.notes, a.notes);
  const loaded = normalizeSong(JSON.parse(JSON.stringify(song)));
  const [la, , lb, lc] = loaded.clips;
  assert.equal(lb.notes, la.notes);
  assert.equal(lc.notes, la.notes);
  assert.equal(loaded.clips[1].link, undefined);
  detachClip(song, c);
  assert.notEqual(c.notes, a.notes);
  assert.deepEqual(c.notes, a.notes);
  assert.equal(c.link, undefined);
  assert.equal(linkedClips(song, a).length, 2);
  removeClip(song, b.id);
  assert.equal(isLinked(song, a), false, 'the last remaining clone becomes standalone');
  assert.equal(a.link, undefined);
}

// The link id is the source clip's id; a group that loses its source promotes its earliest clip.
{
  const song = emptySong();
  const src = addClip(song, { start: 8, length: 4 });
  const c1 = cloneClip(song, src);
  c1.start = 16;
  const c2 = cloneClip(song, c1); // a clone of a clone belongs to the same source
  c2.start = 4;
  assert.equal(src.link, src.id);
  assert.equal(c2.link, src.id);
  assert.equal(isClone(song, src), false);
  assert.equal(isClone(song, c1), true);
  assert.equal(linkSource(song, c2), src);
  removeClip(song, src.id);
  assert.equal(c1.link, c2.id, 'the earliest remaining clip becomes the source');
  assert.equal(isClone(song, c2), false);
  assert.equal(linkSource(song, c1), c2);
  const c3 = cloneClip(song, c1);
  detachClip(song, c2);
  assert.equal(c2.link, undefined);
  assert.ok([c1, c3].every((c) => c.link === c1.id), 'detaching the source promotes another');
  // loading a group whose source is gone repairs it the same way
  const loaded = normalizeSong({ clips: [{ id: 5, start: 4, link: 9 }, { id: 6, start: 0, y: 34, link: 9 }] });
  assert.deepEqual(loaded.clips.map((c) => c.link), [6, 6]);
  assert.equal(loaded.clips[0].notes, loaded.clips[1].notes);
}

// Loading puts freely placed clips on lanes without overlaps; starts may be negative.
{
  const n = normalizeSong({ clips: [
    { id: 1, start: 0, length: 4, y: 5 },
    { id: 2, start: 2, length: 4, y: 20 }, // rounds to lane 1 (34)
    { id: 3, start: 1, length: 2, y: 12 }, // rounds to lane 0, overlaps clip 1 and lane 1 has clip 2
    { id: 4, start: -8, length: 4, y: 0 },
  ] });
  assert.deepEqual(n.clips.map((c) => c.y), [0, LANE_H, 2 * LANE_H, 0]);
  assert.equal(n.clips[3].start, -8);
}

// Before time zero the first time signature continues backwards: bars 0, -1, ...
{
  const song = emptySong();
  assert.deepEqual(barLines(song, -8, 4).map((b) => [b.t, b.bar]), [[-8, -2], [-4, -1], [0, 0], [4, 1]]);
  assert.deepEqual(beatLines(song, -2, 0), [-2, -1]);
  assert.equal(formatPos(-3, song), '0.2.00');
  assert.equal(formatPos(-8, song), '-1.1.00');
  assert.equal(formatPos(5, song), '2.2.00');
}
// ---- consolidate / split: the song plays the same afterwards ----
{
  const played = (song) => notesStarting(song, -100, 100)
    .map((e) => `${e.note.pitch}@${clean(e.start)}-${clean(e.end)}v${e.note.vel}`).sort();
  const song = emptySong();
  const a = addClip(song, { start: 0, length: 4, target: 3 });
  a.notes.push({ pitch: 60, start: 0, length: 6, vel: 0.5 }, { pitch: 61, start: 5, length: 1, vel: 0.5 }, { pitch: 62, start: -1, length: 3, vel: 0.5 });
  const b = addClip(song, { start: 6, length: 2, target: 9 });
  b.notes.push({ pitch: 64, start: 1, length: 1, vel: 0.9, vels: [{ t: 0.5, v: 0.2, r: 0 }] });
  const clone = cloneClip(song, b);
  clone.start = 8;
  const other = addClip(song, { start: 2, length: 4, y: LANE_H, target: 1 });
  const auto = addAutoClip(song, { start: 0, length: 2, y: 2 * LANE_H });
  assert.equal(canConsolidate(song, [a]), false, 'one clip');
  assert.equal(canConsolidate(song, [a, other]), false, 'different lanes');
  assert.equal(canConsolidate(song, [a, clone]), false, 'b sits between them');
  assert.equal(canConsolidate(song, [a, auto]), false);
  const before = played(song);
  const m = consolidateClips(song, [clone, a, b]);
  assert.deepEqual(played(song), before, 'same notes, same times, cut where the clips ended');
  assert.deepEqual([m.start, m.length, m.target, m.name, m.link], [0, 10, 3, a.name, undefined], 'module and name of the first clip');
  assert.equal(song.clips.length, 3);
  assert.ok(!song.clips.includes(a) && !song.clips.includes(b) && !song.clips.includes(clone));
  assert.equal(m.notes.find((n) => n.pitch === 60).length, 4, 'cut at the old clip end');
  assert.ok(!m.notes.some((n) => n.pitch === 61 || n.pitch === 62), 'hidden notes are dropped');
  m.notes.find((n) => n.pitch === 64).vel = 0.1;
  assert.equal(b.notes[0].vel, 0.9, 'own copies of the notes');

  // split: same sound, linked clones are detached first, edges are strict
  const before2 = played(song);
  assert.equal(splitClip(song, m, 0), null);
  assert.equal(splitClip(song, m, 10), null);
  const r = splitClip(song, m, 7.5);
  assert.deepEqual([m.start, m.length, r.start, r.length, r.target, r.y], [0, 7.5, 7.5, 2.5, 3, m.y]);
  assert.deepEqual(played(song).filter((x) => !x.startsWith('64@7')), before2.filter((x) => !x.startsWith('64@7')));
  assert.ok(played(song).includes('64@7-7.5v0.1'), 'a note across the cut ends there');
  assert.ok(r.notes.every((n) => n.start >= 0) && m.notes.every((n) => n.start < 7.5));
  const src = addClip(song, { start: 20, length: 4 });
  src.notes.push({ pitch: 50, start: 3, length: 1, vel: 0.5 });
  const twin = cloneClip(song, src);
  twin.start = 30;
  const tr = splitClip(song, twin, 32);
  assert.ok(!isLinked(song, twin) && !isLinked(song, src), 'the split clone is detached');
  assert.equal(src.length, 4);
  assert.equal(src.notes.length, 1);
  assert.equal(tr.notes[0].start, 1);
  // automation: the curve plays the same after consolidating and splitting
  const s2 = emptySong();
  const p = addAutoClip(s2, { start: 0, length: 2, target: 4, controller: 2 });
  p.points = [{ t: -1, v: 0, r: 0 }, { t: 1, v: 1, r: 0 }];
  const q = addAutoClip(s2, { start: 3, length: 2, target: 5, controller: 7 });
  q.points = [{ t: 0, v: 0.2, r: 0 }, { t: 4, v: 1, r: 0 }];
  const values = (sg, ts) => ts.map((t) => automationAt(sg, t)[0]?.value ?? null);
  const ts = [0, 0.5, 1, 1.5, 1.99, 3, 3.5, 4.5, 4.99];
  const v0 = values(s2, ts);
  const am = consolidateClips(s2, [p, q]);
  assert.deepEqual([am.target, am.controller, am.kind], [4, 2, 'auto']);
  values(s2, ts).forEach((v, i) => assert.ok(Math.abs(v - v0[i]) < 1e-9, `auto at ${ts[i]}: ${v} vs ${v0[i]}`));
  const ar = splitClip(s2, am, 3.5);
  values(s2, ts).forEach((v, i) => assert.ok(Math.abs(v - v0[i]) < 1e-9, `split auto at ${ts[i]}`));
  assert.equal(ar.start, 3.5);
}
console.log('link tests passed');
