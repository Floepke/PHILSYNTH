// Song: the clips on the TimeLine and the notes inside them.
// All times and lengths are float quarter notes; note times are relative to the clip start.
//   song = { clips, sigs, selected (clip id | null), snap: { base, div }, nextId }
//   sigs = time signature changes [{ at (quarters), num, den }], sorted, the first one at 0.
//          Each change starts a new bar, so a change inside a bar cuts that bar short.
//   clip = { id, name, start, length, y (lane * LANE_H, px), target (module number | null), notes }
//   start may be negative: clips before time zero are parked there (never played by the song,
//   the part of a clip that reaches past zero does play). Clips sit on lanes LANE_H px high.
//   note = { pitch (float MIDI note number, see modmidi.js), start, length, vel (0..1), vels? }
//   Velocity can change while a note sounds: note.vel is the velocity at the note start and the
//   optional note.vels = [{ t (quarters after the note start, > 0), v (0..1), r (0..1 rounding) }]
//   continues the curve (same curve maths as automation). Playback sends the changes as MODMIDI
//   noteMod. Treat vels as immutable: edits assign a new array (notes copied with {...n} share it).
// Automation clips have kind: 'auto' and drive one controller of the target module instead of
// playing notes (their notes array stays empty):
//   clip.controller = controller number of the target (same numbering as the LFO Out Controller)
//   clip.points = [{ t (quarters from the clip start), v (0..1 of the controller range), r (0..1 rounding) }]
//   Between points the value moves in straight lines; a point with r > 0 gets a rounded corner
//   (same curve maths as the WAVESHAPER curve, see curve.js). Before the first / after the last
//   point the value holds.
// Linked clones: clips with the same clip.link share ONE notes array (points for automation clips)
// in memory, so editing one edits them all. The toolbar keeps their name, Send to and controller
// equal too; position and length stay per clip. clip.link is the id of the group's source clip (the original the others were cloned from);
// when the source is deleted or detached, the earliest remaining clip becomes the source.
// The project file stores every clip's notes; loading re-shares them.
import { curvePolyline, sampleAt } from './curve.js';

export const SNAP_BASES = [1, 2, 4, 8, 16, 32, 64, 128]; // whole, half, quarter, eighth, 16th, ... note
export const SNAP_NAMES = { 1: 'Whole', 2: 'Half', 4: 'Quarter', 8: 'Eighth', 16: '16th', 32: '32nd', 64: '64th', 128: '128th' };
export const BAR = 4; // quarters per bar in 4/4 (the default time signature)
export const LANE_H = 34; // TimeLine lane height (px) = clip height
export const SIG_DENS = [1, 2, 4, 8, 16, 32];
export const SIG_NUM_MAX = 32;
export const PIANO_LOW = 21; // A0
export const PIANO_HIGH = 108; // C8
export const PITCH_MAX = 127;
export const DEFAULT_VEL = 0.8;

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
export const isBlack = (pitch) => BLACK[((Math.round(pitch) % 12) + 12) % 12];
export const inPiano = (pitch) => pitch >= PIANO_LOW && pitch <= PIANO_HIGH;
export const noteName = (pitch) => {
  const p = Math.round(pitch);
  return `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
};

// Grid step in quarters: base note value divided by `div` (Quarter ÷ 3 = quarter triplets = 1/3,
// Whole ÷ 3 = 4/3, Half ÷ 5 = 2/5).
export const snapStep = ({ base = 16, div = 1 } = {}) => 4 / base / div;
export const clean = (v) => Math.round(v * 1e9) / 1e9; // keep 0.1 + 0.2 style float noise out of the project
export const snapRound = (t, step) => clean(Math.round(t / step) * step);
export const snapFloor = (t, step) => clean(Math.floor(t / step + 1e-9) * step);

export const emptySong = () => ({ clips: [], sigs: [{ at: 0, num: 4, den: 4 }], selected: null, snap: { base: 16, div: 1 }, nextId: 1 });

const num = (v, d) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const isAuto = (clip) => clip?.kind === 'auto';

// ---- time signatures ----
export const validSig = (n, d) => Number.isInteger(n) && n >= 1 && n <= SIG_NUM_MAX && SIG_DENS.includes(d);

export function normalizeSigs(list) {
  const byAt = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    if (!validSig(x?.num, x?.den) || !Number.isFinite(x.at) || x.at < 0) continue;
    byAt.set(clean(x.at), { at: clean(x.at), num: x.num, den: x.den });
  }
  const sigs = [...byAt.values()].sort((a, b) => a.at - b.at);
  if (!sigs.length || sigs[0].at > 0) sigs.unshift({ at: 0, num: 4, den: 4 });
  return sigs;
}

// The time signature segments of a song: { at, end, num, den, len (quarters per bar), beat
// (quarters per beat), bar (0-based number of its first bar) }.
export function meter(song) {
  const sigs = song?.sigs?.length ? song.sigs : [{ at: 0, num: 4, den: 4 }];
  let bar = 0;
  return sigs.map((x, i) => {
    const end = sigs[i + 1]?.at ?? Infinity;
    const seg = { at: x.at, end, num: x.num, den: x.den, len: (x.num * 4) / x.den, beat: 4 / x.den, bar };
    if (end !== Infinity) bar += Math.ceil((end - x.at) / seg.len - 1e-9);
    return seg;
  });
}

export function segAt(m, t) {
  let seg = m[0];
  for (const x of m) if (x.at <= t + 1e-9) seg = x;
  return seg;
}

// Bar lines in [t0, t1]: [{ t, bar (0-based), seg }]
export function barLines(song, t0, t1, m = meter(song)) {
  const out = [];
  for (const seg of m) {
    if (seg.end <= t0 || (seg.at > t1 && seg !== m[0])) continue;
    let k = Math.ceil((t0 - seg.at) / seg.len - 1e-9);
    if (seg !== m[0]) k = Math.max(0, k); // the first segment also covers time before zero
    for (let t = seg.at + k * seg.len; t <= t1 && t < seg.end - 1e-9; t = seg.at + ++k * seg.len) out.push({ t: clean(t), bar: seg.bar + k, seg });
  }
  return out;
}

// Beat lines in [t0, t1] that are not bar lines.
export function beatLines(song, t0, t1, m = meter(song)) {
  const out = [];
  for (const seg of m) {
    if (seg.end <= t0 || (seg.at > t1 && seg !== m[0])) continue;
    let k = Math.ceil((t0 - seg.at) / seg.beat - 1e-9);
    if (seg !== m[0]) k = Math.max(0, k);
    for (let t = seg.at + k * seg.beat; t <= t1 && t < seg.end - 1e-9; t = seg.at + ++k * seg.beat) {
      if (k % seg.num) out.push(clean(t));
    }
  }
  return out;
}

// Nearest bar line to t / the first bar line at or after t / the bar length at t.
export function barRound(song, t, m = meter(song)) {
  const seg = segAt(m, t);
  const r = clean(seg.at + Math.round((t - seg.at) / seg.len) * seg.len);
  return Math.min(r, seg.end);
}
export function barCeil(song, t, m = meter(song)) {
  const seg = segAt(m, t);
  return Math.min(clean(seg.at + Math.ceil((t - seg.at) / seg.len - 1e-9) * seg.len), seg.end);
}
export const barLength = (song, t) => segAt(meter(song), t).len;

// Insert (or replace) the time signature starting at `at`.
export function setSig(song, at, n, d) {
  if (!validSig(n, d)) return false;
  song.sigs = normalizeSigs([...(song.sigs ?? []).filter((x) => Math.abs(x.at - at) > 1e-9), { at, num: n, den: d }]);
  return true;
}
// Remove a change (the first signature at 0 cannot be removed, only changed).
export function removeSig(song, at) {
  if (at <= 1e-9) return false;
  const n = song.sigs.length;
  song.sigs = song.sigs.filter((x) => Math.abs(x.at - at) > 1e-9);
  return song.sigs.length !== n;
}

// Validated copy of a saved song (missing or broken parts get defaults).
export function normalizeSong(s) {
  const song = emptySong();
  if (!s || typeof s !== 'object') return song;
  song.sigs = normalizeSigs(s.sigs);
  if (SNAP_BASES.includes(s.snap?.base)) song.snap.base = s.snap.base;
  song.snap.div = Math.min(64, Math.max(1, Math.round(num(s.snap?.div, 1))));
  const ids = new Set();
  for (const c of Array.isArray(s.clips) ? s.clips : []) {
    let id = Math.round(num(c?.id, 0));
    if (id < 1 || ids.has(id)) id = Math.max(0, ...ids) + 1;
    ids.add(id);
    const clip = {
      id,
      name: typeof c.name === 'string' ? c.name : `Clip ${id}`,
      start: num(c.start, 0),
      length: Math.max(1e-3, num(c.length, BAR)),
      y: laneY(num(c.y, 0)),
      target: Number.isInteger(c.target) ? c.target : null,
      notes: c.kind === 'auto' ? [] : (Array.isArray(c.notes) ? c.notes : [])
        .filter((n) => Number.isFinite(n?.pitch) && Number.isFinite(n.start) && n.length > 0)
        .map((n) => ({
          pitch: Math.min(PITCH_MAX, Math.max(0, n.pitch)),
          start: n.start,
          length: n.length,
          vel: Math.min(1, Math.max(0, num(n.vel, DEFAULT_VEL))),
          ...velsOf(n),
        })),
    };
    if (c.kind === 'auto') {
      clip.kind = 'auto';
      clip.controller = Math.max(0, Math.round(num(c.controller, 0)));
      clip.points = normalizePoints(c.points);
    }
    if (Number.isInteger(c.link) && c.link > 0) clip.link = c.link;
    song.clips.push(clip);
  }
  // linked clones share the content of the first clip of their group (same kind only)
  const groups = new Map();
  for (const clip of song.clips) {
    if (!clip.link) continue;
    const first = groups.get(clip.link);
    if (!first) { groups.set(clip.link, clip); continue; }
    if (isAuto(first) !== isAuto(clip)) { delete clip.link; continue; }
    clip.notes = first.notes;
    if (isAuto(clip)) clip.points = first.points;
  }
  for (const link of new Set(song.clips.map((c) => c.link).filter(Boolean))) repairLink(song, link);
  // older projects placed clips freely: put every clip on a lane, moving it down when it would overlap
  const placed = [];
  for (const clip of song.clips) {
    while (placed.some((c) => c.y === clip.y && c.start < clip.start + clip.length - 1e-9 && clip.start < c.start + c.length - 1e-9)) clip.y += LANE_H;
    placed.push(clip);
  }
  song.nextId = Math.max(num(s.nextId, 1), ...song.clips.map((c) => c.id + 1), 1);
  song.selected = song.clips.some((c) => c.id === s.selected) ? s.selected : null;
  return song;
}

// The lane y (px) nearest to y.
export const laneY = (y) => Math.max(0, Math.round(y / LANE_H)) * LANE_H;

export const getClip = (song, id) => song.clips.find((c) => c.id === id) ?? null;

export function addClip(song, { start = 0, y = 0, length = BAR, target = null } = {}) {
  const id = song.nextId++;
  const clip = { id, name: `Clip ${id}`, start, length, y, target, notes: [] };
  song.clips.push(clip);
  return clip;
}

export function addAutoClip(song, { start = 0, y = 0, length = BAR, target = null, controller = 0 } = {}) {
  const clip = addClip(song, { start, y, length, target });
  clip.name = `Auto ${clip.id}`;
  clip.kind = 'auto';
  clip.controller = controller;
  clip.points = [];
  return clip;
}

// ---- velocity curves ----
const velsOf = (n) => {
  const vels = normalizePoints(n.vels).filter((p) => p.t > 1e-9);
  return vels.length ? { vels } : {};
};

// All points of a note's velocity curve, the start point (note.vel) first.
export const notePoints = (note) => [{ t: 0, v: note.vel, r: 0 }, ...(note.vels ?? [])];

// Velocity of a note t quarters after its start.
export function noteVelAt(note, t) {
  if (!note.vels?.length) return note.vel;
  return clamp01(sampleAt(curvePolyline(notePoints(note).map((p) => ({ x: p.t, y: p.v, r: p.r }))), t));
}

// One shared curve (absolute clip times) through the velocity curves of several notes: every
// note contributes its points up to its end; points at the same time are averaged. Notes that all
// have the same constant velocity give a single point.
export function groupVelCurve(notes) {
  if (!notes.length) return [];
  const byT = new Map();
  for (const n of notes) {
    const pts = notePoints(n).filter((p) => p.t <= n.length + 1e-9);
    if (pts.length < notePoints(n).length) pts.push({ t: n.length, v: noteVelAt(n, n.length), r: 0 });
    for (const p of pts) {
      const t = clean(n.start + p.t);
      const e = byT.get(t) ?? { t, v: 0, r: 0, k: 0 };
      e.v += p.v; e.r = Math.max(e.r, p.r); e.k++;
      byT.set(t, e);
    }
  }
  const pts = [...byT.values()].sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, v: e.v / e.k, r: e.r }));
  pts[0].r = 0;
  if (pts.every((p) => Math.abs(p.v - pts[0].v) < 1e-9)) return [pts[0]];
  return pts;
}

// Make every note follow a shared curve (absolute clip times, see groupVelCurve): its start
// velocity is the curve value there, curve points inside the note are copied, and where the curve
// keeps changing after the note's last inner point the value at the note end is added.
export function applyVelCurve(notes, points) {
  if (!points.length) return;
  const poly = curvePolyline(points.map((p) => ({ x: p.t, y: p.v, r: p.r })));
  const at = (t) => clamp01(sampleAt(poly, t));
  const last = points[points.length - 1].t;
  for (const n of notes) {
    const end = n.start + n.length;
    n.vel = at(n.start);
    const vels = points
      .filter((p) => p.t > n.start + 1e-9 && p.t <= end + 1e-9)
      .map((p) => ({ t: clean(p.t - n.start), v: p.v, r: p.r }));
    const lastInner = vels.length ? n.start + vels[vels.length - 1].t : n.start;
    if (last > end + 1e-9 && end - lastInner > 1e-9) {
      const v = at(end);
      const prev = vels.length ? vels[vels.length - 1].v : n.vel;
      if (Math.abs(v - prev) > 1e-6) vels.push({ t: n.length, v, r: 0 });
    }
    if (vels.length) n.vels = vels;
    else delete n.vels;
  }
}

// ---- automation ----
export function normalizePoints(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => Number.isFinite(p?.t) && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: clamp01(p.v), r: clamp01(+p.r || 0) })) // t < 0: trimmed off the start, still shapes the curve
    .sort((a, b) => a.t - b.t);
}

// Index where a point at time t goes (after points at the same time).
export const pointIndex = (points, t) => {
  let i = 0;
  while (i < points.length && points[i].t <= t) i++;
  return i;
};

// Dense polyline [t0, v0, t1, v1, ...] of an automation clip (null without points).
export function autoPolyline(clip) {
  const pts = clip.points ?? [];
  if (!pts.length) return null;
  return curvePolyline(pts.map((p) => ({ x: p.t, y: p.v, r: p.r })));
}

// Automation value (0..1) at time t inside the clip, null when the clip has no points.
export function autoValue(clip, t, poly = autoPolyline(clip)) {
  return poly ? clamp01(sampleAt(poly, t)) : null;
}

// Automation clips covering song time q (start <= q < end) that have points: [{ clip, value }]
export function automationAt(song, q) {
  const out = [];
  for (const clip of song.clips) {
    if (!isAuto(clip) || q < clip.start || q >= clip.start + clip.length) continue;
    const value = autoValue(clip, q - clip.start);
    if (value !== null) out.push({ clip, value });
  }
  return out;
}

// Standalone copy with its own notes (same name: no "copy copy copy" chains).
export function duplicateClip(song, clip) {
  const id = song.nextId++;
  const copy = { ...structuredClone(clip), id };
  delete copy.link;
  song.clips.push(copy);
  return copy;
}

// All clips of a clip's linked group (itself included; just [clip] when it is not linked).
export const linkedClips = (song, clip) => (clip?.link ? song.clips.filter((c) => c.link === clip.link) : clip ? [clip] : []);
export const isLinked = (song, clip) => linkedClips(song, clip).length > 1;
// The source of a linked group (null for a standalone clip) / a clone that is not the source.
export const linkSource = (song, clip) => (isLinked(song, clip) ? getClip(song, clip.link) : null);
export const isClone = (song, clip) => isLinked(song, clip) && clip.link !== clip.id;

// Linked clone: shares the notes (or automation points) of `clip`, see the header.
export function cloneClip(song, clip) {
  if (!clip.link) clip.link = clip.id;
  const id = song.nextId++;
  const copy = { ...clip, id };
  song.clips.push(copy);
  return copy;
}

// After clips left a group: a group of one is no longer linked; a group without its source
// promotes its earliest clip.
function repairLink(song, link) {
  if (!link) return;
  const rest = song.clips.filter((c) => c.link === link);
  if (rest.length === 1) delete rest[0].link;
  if (rest.length < 2 || rest.some((c) => c.id === link)) return;
  const source = [...rest].sort((a, b) => a.start - b.start || a.y - b.y || a.id - b.id)[0];
  for (const c of rest) c.link = source.id;
}

// Turn a linked clone into a standalone clip with its own copy of the notes.
export function detachClip(song, clip) {
  if (!clip?.link) return false;
  const link = clip.link;
  delete clip.link;
  clip.notes = clip.notes.map((n) => ({ ...n }));
  if (clip.points) clip.points = clip.points.map((p) => ({ ...p }));
  repairLink(song, link);
  return true;
}

export function removeClip(song, id) {
  const i = song.clips.findIndex((c) => c.id === id);
  if (i < 0) return false;
  const [clip] = song.clips.splice(i, 1);
  if (song.selected === id) song.selected = null;
  repairLink(song, clip.link);
  return true;
}

// Move the left edge of a clip to `newStart` keeping its end and the notes' song positions.
export function trimClipStart(clip, newStart, original = clip) {
  const end = original.start + original.length;
  const delta = newStart - original.start;
  clip.start = newStart;
  clip.length = clean(end - newStart);
  clip.notes.forEach((n, i) => (n.start = clean(original.notes[i].start - delta)));
  clip.points?.forEach((p, i) => (p.t = clean(original.points[i].t - delta)));
}

export const songEnd = (song) => song.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
// Playback loops at the end of the last clip, rounded up to a whole bar.
export const loopEnd = (song) => {
  const end = songEnd(song);
  return end > 0 ? barCeil(song, end) : 0;
};

// Notes that start in [from, to) in song time. A note plays when it starts inside its clip;
// it is cut at the clip end.
export function notesStarting(song, from, to) {
  const out = [];
  for (const clip of song.clips) {
    if (clip.start >= to || clip.start + clip.length <= from) continue;
    for (const note of clip.notes) {
      if (note.start < 0 || note.start >= clip.length) continue;
      const start = clip.start + note.start;
      if (start < from || start >= to) continue;
      out.push({ clip, note, start, end: clip.start + Math.min(clip.length, note.start + note.length) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Notes already sounding at q (started before q, ending after it): for note chasing when playback
// starts or jumps into the middle of a note. Same clipping to the clip bounds as notesStarting.
export function notesSounding(song, q) {
  const out = [];
  for (const clip of song.clips) {
    if (clip.start >= q || clip.start + clip.length <= q) continue;
    for (const note of clip.notes) {
      if (note.start < 0 || note.start >= clip.length) continue;
      const start = clip.start + note.start;
      const end = clip.start + Math.min(clip.length, note.start + note.length);
      if (start < q && end > q) out.push({ clip, note, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// "bar.beat.cent" position display (1-based bar and beat, beats of the time signature there).
export function formatPos(q, song = null) {
  const seg = segAt(meter(song), q);
  const inSeg = q - seg.at; // negative before time zero: bar 0, -1, ...
  const k = Math.floor(inSeg / seg.len + 1e-9);
  const inBar = Math.max(0, inSeg - k * seg.len);
  const beat = Math.floor(inBar / seg.beat + 1e-9);
  const cent = Math.min(99, Math.floor(((inBar - beat * seg.beat) / seg.beat) * 100 + 1e-6));
  return `${seg.bar + k + 1}.${beat + 1}.${String(cent).padStart(2, '0')}`;
}
