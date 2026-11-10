// Vertical piano roll. Time runs down; pitch runs left -> right, one column per MIDI note (0..127).
// Inside the 88-key piano range (A0..C8) every black key is drawn as a black stave line through
// the middle of its column, ON TOP of the notes, so black-key notes sit under a line and
// white-key notes sit between the lines (2- and 3-line groups like a keyboard). Outside the
// piano range there are no lines, notes just float.
// The keyboard sits below the stave. Noteheads are left-tilted ovals, white/black by key.
// Keys held on the MIDI device or computer keyboard (ctx.heldKeys) light up blue (the selection colour).
// During playback the keys of the clip's notes under the playhead light up in the clip's note colour.
// Unzoomed, all 128 MIDI pitches fit the available width. Ctrl/Cmd + wheel zooms time, Shift + wheel
// zooms pitch (the stave and the keyboard together, around the pointer) for finer micropitch work;
// zoomed in, a horizontal scrollbar shows between the stave and the keyboard and middle-drag pans
// both ways. Noteheads and bodies grow with the pitch zoom only up to NOTE_MAX_W. A vertical
// scrollbar right of the note grid (the TimeLine's look) spans the clip; the keyboard ends beside it.
//   click / drag the keyboard  play pitches on the live MIDI module (red MIDI in the patcher) without editing notes
//   click / drag on empty space  insert a note (last used length and velocity), dragging beyond 10 px sets its duration
//   drag a note's coloured body  set the duration: one note's end jumps to the snapped pointer;
//                                a selection's durations change by the same snapped drag delta
//                                (all selected notes change by the same amount when it is selected;
//                                 duration drags scroll along past the top / bottom edge, as the clip end)
//   drag a note's circle         change pitch (sideways) and start time (moves the whole selection)
//   Shift + drag a note's circle sideways  micropitch: tune the note (or the selection it is in) up /
//                                in 0.1 cent steps, slowly (MICRO_PX px per cent); a slider shows the
//                                cents. A note stays in its key's column (halves round up, see
//                                song.js basePitch); its circle leans sideways by the tuning
//                                (±50 cents = half a column); the whole note (circle and coloured
//                                body) shifts along. Esc / pointer cancel restores it.
//   double-click a selected note's coloured body  pitch bend: inserts a bend point there (hold the
//                                second press to drag it at once). The body becomes a thick line through
//                                its bend points (bendPolyline in song.js), it is heard as noteMod glides.
//   drag a bend point            sideways snaps to whole pitches (Shift: continuous pitch);
//                                up / down snaps to the time grid unless Free timing is on,
//                                between its neighbours, inside the note. Bend points
//                                show on selected notes; wheel on one rounds its corner, right-click
//                                deletes it, holding right opens the menu (Delete bend point, Reset bend).
//   drag the thick end line      change the clip length (wheel-scroll or drag past the top / bottom edge to go further)
//   Shift + drag / right drag    select notes with a rectangle (Shift: starting off a note's circle) (wheel-scroll or drag past the top / bottom edge to extend it across the clip)
//   Shift + click a note         add it to / remove it from the selection
//   Ctrl/Cmd + click a note      add it to / remove it from the selection without editing it
//   Alt + drag a note           clone it (or the selection) and move the clones
//   right click                 delete the note under the pointer on release
//   hold right button 250 ms    open the menu instead (release never deletes)
//   Backspace / Delete          delete selected notes
//   Left / Right                transpose selected notes by a semitone (Shift: an octave)
//   Up / Down                   move selected notes by one snap step (Shift: a bar)
//   Ctrl/Cmd + X / C / V        cut / copy / paste notes at the pointer's snapped time
//   Ctrl/Cmd + D                duplicate the selection right after itself
//   Ctrl/Cmd + A, Escape        select all / clear the selection
//   Q                           quantize note starts to the grid (selection, else all notes)
//   Space                       toggle song playback from the pointer's snapped time
// The velocity strip on the left edits the velocity (curves) of the selected notes, see velocity.js.
// Drag the bar ruler sideways to resize the velocity strip, vertically to zoom time.
// Both axes act together; double-click resets the width.
// Free timing bypasses time snapping; the visual grid (base note ÷ divider) stays visible.
import { basePitch, centsOf, bendPolyline, notePitchAt, BEND_MAX, withCents, centsLabel, isBlack, inPiano, clipSilent, isIdea, snapStep, pianoTimeStep, snapFloor, snapRound, noteName, PIANO_LOW, PIANO_HIGH, PITCH_MAX, BAR, DEFAULT_VEL, withVelEnd, velsForLength, clean, meter, barLines, beatLines, barLength, gridBeatEnabled } from '../song.js';
import {
  createSurface, capture, rulerDrag, startPan, onWheel, clamp, snapBands, mutedMark, edgeScroll, RIGHT_HOLD_MS, RIGHT_HOLD_SLOP,
  SB, SB_TRACK, scrollThumb, scrollValue, paintThumb,
} from './surface.js';
import { createVelocityStrip, VEL_W } from './velocity.js';
import { clipResizeBounds } from './clipplacement.js';
import { showMenu, shortcut } from './menu.js';
import { doublePress } from '../doublepress.js';
import { NEW_NOTE_POINT_ROUND } from '../curve.js';
import { wheelNotches } from '../params.js';

const CENTRAL = [61, 63]; // C#4 and D#4, the black keys next to middle C
const GRID_LOW = 22; // A#0 (American notation)
const GRID_HIGH = 106; // A#7

const KEYBOARD = 24;
// free space above time 0 (keeps the first notes clear of the PHILSYNTH menu button); the
// automation lane uses the same
export const TOP_MARGIN = 128;
const TILT = -Math.PI / 6;
const HEAD_STRETCH = 1.25; // noteheads are stretched along the time (y) axis
const GUTTER = 36; // bar / beat ruler (right of the velocity strip)
const VEL_MIN = 0; // the ruler drags the velocity strip between these widths; the grid scales
const VEL_MAX_SHARE = 0.5; // of the roll width
const BG = '#45464e';
const PLAYHEAD = '#ff916e';
const SELECT = '#65b4ff';
const STAVE = '#111216';
const BEAT = STAVE;
const BAR_LINE = STAVE;
const BOUNDARY = STAVE;
const TIME_EPSILON = 1e-7;
const MICRO_PX = 4; // px of sideways Shift-drag per cent of micropitch
const SLIDER_W = 160; // px, the micropitch slider (±50 cents)
const BEND_HIT = 8; // px, grab radius of a bend point
const DURATION_DRAG_THRESHOLD = 10; // px, minimum drag distance to resize a note's duration
const HZ_MAX = 24; // pitch (x) zoom: 1 = all 128 keys fit
const HZ_STEP = 1.15; // per wheel notch
const NOTE_MAX_W = 48; // px, notes stop growing with the pitch zoom (unless unzoomed keys are wider)
const ROUND_STEP = 0.05; // rounding change per wheel step on a bend point
// px, zooming out (time axis): grid lines closer together than this disappear. Beat lines go as a
// whole, bar lines are thinned so the ones left stay at least this far apart (snap bands unaffected).
export const GRID_MIN_PX = 30;

// ctx: { song(), clip(), color(clip), preview: { on(clip, pitch) -> handle, key(pitch) -> handle,
//        bend?(handle, pitch) (micropitch drag), off(handle) }, changed(), transport,
//        menu?(opts) (context menu, default showMenu), heldKeys?() -> Set of pitches held on the live
//        inputs (shown blue on the keyboard; call redraw() when it changes) }
export function createPianoRoll(host, ctx) {
  const view = { sy: -TOP_MARGIN, ppq: 48, velW: VEL_W, hz: 1, hx: 0 }; // hz / hx: pitch zoom, px scrolled sideways
  let hover = null; // { pitch, t } where a click would insert a note
  let endHover = false; // the pointer is on the clip's end line
  let hoverPitch = null;
  let drag = null;
  let pointer = null;
  let selectionClip = null;
  let selected = new Set();
  let clipboard = [];
  let lastLength = null; // length of the last drawn / resized note: new notes get it
  let lastVelocity = null;
  let hoverBend = null; // { note, i }: the bend point under the pointer
  let sbHover = false; // the pointer is on the scrollbar (right of the note grid)
  let sbActive = false; // its thumb is being dragged
  let hbHover = false; // the same for the horizontal scrollbar (zoomed in)
  let hbActive = false;
  const presses = doublePress(); // double-click a note body = down-up-DOWN: the new bend point drags at once
  const menu = (opts) => (ctx.menu ?? showMenu)(opts);

  const s = createSurface(host, paint);
  const { cv } = s;
  const velW = () => clamp(view.velW, VEL_MIN, Math.max(VEL_MIN, s.w * VEL_MAX_SHARE));
  const gridX = () => velW() + GUTTER; // left edge of the note grid
  const inRuler = (x, y) => x >= velW() && x < gridX() && y >= 0 && y < s.h;
  const rollRight = () => Math.max(gridX(), s.w - SB); // the note grid and keyboard end at the scrollbar
  const visW = () => Math.max(0, rollRight() - gridX());
  const baseKeyWidth = () => visW() / (PITCH_MAX + 1); // unzoomed: all keys fit
  const keyWidth = () => baseKeyWidth() * view.hz; // a pitch column
  const zoomedX = () => view.hz > 1 + 1e-9;
  const noteW = () => Math.min(keyWidth(), Math.max(baseKeyWidth(), NOTE_MAX_W)); // notehead / body width
  const overlap = () => Math.min(0.5, noteW() * 0.05);
  const dragThreshold = () => Math.min(3, keyWidth() * 0.4);
  const xOf = (p) => gridX() + p * keyWidth() - view.hx;
  const yOf = (t) => t * view.ppq - view.sy;
  const keyX = (n) => xOf(basePitch(n.pitch)); // a note's column: the key its pitch belongs to
  // x of a (fractional) pitch: whole pitches sit in the middle of their column, cents lean sideways
  const centerX = (p) => xOf(p) + keyWidth() / 2;
  const headX = (n) => centerX(n.pitch); // leans by the tuning
  const bodyX = (n, t) => centerX(notePitchAt(n, t)); // middle of the note body t quarters after its start
  const pitchAt = (x) => keyWidth() > 0 ? clamp(Math.floor((x - gridX() + view.hx) / keyWidth()), 0, PITCH_MAX) : 0;
  const pitchFromX = (x) => keyWidth() > 0 ? clamp((x - gridX() + view.hx) / keyWidth() - 0.5, 0, PITCH_MAX) : 0; // continuous
  const clampX = (x) => clamp(x, gridX(), Math.max(gridX(), rollRight() - 1)); // drags past the side edges stay at the edge
  const bendXY = (n, b) => ({ x: centerX(clamp(n.pitch + b.d, 0, PITCH_MAX)), y: yOf(n.start + b.t) });
  const timeAt = (y) => (y + view.sy) / view.ppq;
  const keyTop = () => Math.max(0, s.h - KEYBOARD);
  const gridBottom = () => Math.max(0, keyTop() - (zoomedX() ? SB : 0)); // zoomed: the horizontal scrollbar sits above the keys
  const inGrid = (x, y) => x >= gridX() && x < rollRight() && y >= 0 && y < gridBottom();
  const inKeyboard = (x, y) => x >= gridX() && x < rollRight() && y >= keyTop() && y < s.h;
  const onScrollbar = (x, y) => x >= rollRight() && y >= 0 && y < gridBottom();
  const onHScrollbar = (x, y) => zoomedX() && x >= gridX() && x < rollRight() && y >= gridBottom() && y < keyTop();
  // the keys play the live MIDI module (preview.key) even without a clip; else the clip's target
  const keysPlay = () => !!(ctx.preview.key || ctx.clip());
  const headSize = () => {
    const rx = (noteW() - overlap()) / (2 * Math.hypot(Math.cos(TILT), 0.72 * Math.sin(TILT)));
    const ry = rx * 0.72;
    return { rx, ry, height: Math.hypot(rx * Math.sin(TILT), ry * Math.cos(TILT)) * HEAD_STRETCH + 0.75 };
  };
  const headY = (y) => y + headSize().height;
  const gridStep = () => snapStep(ctx.song().snap);
  const step = () => pianoTimeStep(ctx.song().snap);
  const vel = createVelocityStrip({
    cv,
    width: velW,
    local: s.local,
    clip: () => ctx.clip(),
    selected: () => { syncSelection(); return selected; },
    setSelected: (set) => { selected = set; },
    yOf,
    timeAt,
    bottom: gridBottom,
    labelTop: keyTop,
    ppq: () => view.ppq,
    edgeScroll: (onScroll) => gridScroll(onScroll),
    song: ctx.song,
    color: ctx.color,
    changed: () => ctx.changed(),
    rememberVelocity: (value) => { lastVelocity = value; },
    redraw: s.redraw,
    menu,
    snapVelocity: () => ctx.pianorollPreferences?.snapVelocity !== false,
    selectRect: (e, x, y, onClick) => selectRect(e, x, y, onClick, null, true),
  });

  const minBeat = (m) => Math.min(...m.map((x) => x.beat));
  const beatsShown = (m) => minBeat(m) * view.ppq >= GRID_MIN_PX;
  // the bar lines (song time) drawn between t0 and t1: zoomed out, a bar closer than GRID_MIN_PX to
  // the previous drawn one is skipped; counted from `from` (the clip start) so scrolling keeps the choice
  function spacedBars(m, from, t0, t1) {
    const out = [];
    let last = -Infinity;
    for (const b of barLines(null, Math.min(from, t0), t1, m)) {
      if ((b.t - last) * view.ppq < GRID_MIN_PX - 1e-9) continue;
      last = b.t;
      if (b.t >= t0 - TIME_EPSILON) out.push(b);
    }
    return out;
  }

  function syncSelection() {
    const clip = ctx.clip();
    if (clip !== selectionClip) {
      drag?.stop?.({ type: 'pointercancel' });
      selectionClip = clip;
      selected.clear();
    } else {
      selected = new Set(clip?.notes.filter((n) => selected.has(n)) ?? []);
    }
  }

  function limitScroll() {
    const clip = ctx.clip();
    // while the clip end is dragged the scroll range never shrinks: a shortened clip would pull the
    // view up under the pointer, which would shorten it again on the next move
    const end = clip ? Math.max(clip.length, ...clip.notes.map((n) => n.start + n.length), drag?.kind === 'clipEnd' ? drag.extent : 0) : BAR;
    view.sy = clamp(view.sy, -TOP_MARGIN, scrollMax(end));
    limitX();
  }
  function limitX() {
    view.hz = clamp(Number.isFinite(view.hz) ? view.hz : 1, 1, HZ_MAX);
    view.hx = clamp(Number.isFinite(view.hx) ? view.hx : 0, 0, (view.hz - 1) * visW());
  }
  // Shift + wheel: zoom pitch around local x (+ notches = in)
  function zoomX(notches, x) {
    limitX();
    const p = (clamp(x, gridX(), rollRight()) - gridX() + view.hx) / keyWidth(); // pitch columns under the pointer
    const px = clamp(x, gridX(), rollRight()) - gridX();
    view.hz = clamp(view.hz * Math.pow(HZ_STEP, notches), 1, HZ_MAX);
    if (Math.abs(view.hz - 1) < 0.02) view.hz = 1;
    view.hx = Number.isFinite(p) ? p * keyWidth() - px : 0;
    limitX();
    limitScroll();
  }
  // the horizontal scrollbar between the stave and the keyboard (zoomed in only)
  const hScrollbar = () => scrollThumb(gridX(), visW(), visW(), 0, (view.hz - 1) * visW(), view.hx);
  function hScrollbarDrag(e, p) {
    e.preventDefault();
    const b = hScrollbar();
    const inside = p.x >= b.pos && p.x <= b.pos + b.thumb;
    const offset = inside ? p.x - b.pos : b.thumb / 2;
    const scrollTo = (q) => {
      view.hx = scrollValue(b, q.x - offset);
      ctx.viewChanged?.();
      s.redraw();
    };
    hbActive = true;
    drag = { kind: 'scrollbar' };
    scrollTo(p);
    drag.stop = capture(cv, e, (ev) => scrollTo(s.local(ev)), () => { hbActive = false; drag = null; s.redraw(); });
  }
  // the lowest scroll: one bar of room past the clip end / the last note end (end, quarters)
  const scrollMax = (end) => Math.max(0, (end + BAR) * view.ppq - gridBottom());

  // the vertical scrollbar right of the note grid (the TimeLine's look): spans the clip from the
  // margin above its start to a bar past its end
  function scrollbar() {
    const clip = ctx.clip();
    const end = clip ? Math.max(clip.length, ...clip.notes.map((n) => n.start + n.length), drag?.kind === 'clipEnd' ? drag.extent : 0) : BAR;
    return scrollThumb(0, gridBottom(), gridBottom(), -TOP_MARGIN, scrollMax(end), view.sy);
  }
  // drag the thumb (grabbed where pressed), or press the track: the thumb centres there and follows
  function scrollbarDrag(e, p) {
    e.preventDefault();
    const b = scrollbar();
    const inside = p.y >= b.pos && p.y <= b.pos + b.thumb;
    const offset = inside ? p.y - b.pos : b.thumb / 2;
    const scrollTo = (q) => {
      view.sy = scrollValue(b, q.y - offset);
      ctx.viewChanged?.();
      s.redraw();
    };
    sbActive = true;
    drag = { kind: 'scrollbar' };
    scrollTo(p);
    drag.stop = capture(cv, e, (ev) => scrollTo(s.local(ev)), () => { sbActive = false; drag = null; s.redraw(); });
  }

  // Any drag along the time axis: holding the pointer near / past the top or bottom of the note grid
  // scrolls the view along (faster further out); onScroll re-applies the drag at the new view.
  // horizontal: also sideways past the left / right edge while zoomed in (drags that change pitch)
  const gridScroll = (onScroll, { horizontal = false } = {}) => edgeScroll({
    area: () => (horizontal && zoomedX()
      ? { left: gridX(), right: rollRight(), top: 0, bottom: gridBottom() }
      : { left: -Infinity, right: Infinity, top: 0, bottom: gridBottom() }),
    scroll: (dx, dy) => { view.sy += dy; view.hx += dx; limitScroll(); ctx.viewChanged?.(); },
    onScroll,
  });

  function head(g, x, y, black, alpha = 1) {
    g.globalAlpha = alpha;
    g.beginPath();
    const { rx, ry } = headSize();
    g.save(); // stretch the path only: the outline keeps an even width
    g.translate(x, headY(y));
    g.scale(1, HEAD_STRETCH);
    g.ellipse(0, 0, rx, ry, TILT, 0, Math.PI * 2);
    g.restore();
    g.fillStyle = black ? STAVE : '#e0e1dc';
    g.fill();
    g.lineWidth = Math.min(3, noteW() * 0.3);
    g.strokeStyle = STAVE;
    g.stroke();
    g.globalAlpha = 1;
  }

  // clip time of the play position when the transport is on this clip (playing or paused), else null
  function playheadTime(clip) {
    const { playing, pos, clipId } = ctx.transport;
    const t = pos - clip.start;
    const onClip = clipId == null || (ctx.transport.loopClip ? ctx.transport.loopClip() === clip : clipId === clip.id);
    return (playing || pos > 0) && ctx.transport.plays?.(ctx.song()) !== false && onClip && t >= 0 && t <= clip.length ? t : null;
  }

  // pitches of the clip's notes sounding at the playhead during playback (keyboard highlight)
  function soundingPitches(clip) {
    const out = new Set();
    if (!clip || !ctx.transport.playing) return out;
    const t = playheadTime(clip);
    if (t === null) return out;
    for (const n of clip.notes) {
      if (n.start >= 0 && n.start < clip.length && n.start <= t && t < n.start + n.length) out.add(basePitch(notePitchAt(n, t - n.start)));
    }
    return out;
  }

  // a bent note body: a thick line through its pitch curve, round ends inside the note's time
  function bentBody(g, n, poly, bw) {
    const hh = n.length * view.ppq;
    const r = Math.min(bw / 2, hh / 2);
    const t0 = r / view.ppq;
    const t1 = n.length - t0;
    g.lineWidth = Math.min(bw, hh);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.moveTo(bodyX(n, t0), yOf(n.start + t0));
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i] > t0 && poly[i] < t1) g.lineTo(bodyX(n, poly[i]), yOf(n.start + poly[i]));
    }
    g.lineTo(bodyX(n, Math.max(t0, t1)), yOf(n.start + Math.max(t0, t1)));
    g.stroke();
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
  }

  // bend points of the selected notes (velocity editor style), with a thin guide through them
  function paintBends(g, clip) {
    for (const n of clip.notes) {
      if (!n.bends?.length || !selected.has(n)) continue;
      g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(headX(n), yOf(n.start));
      for (const b of n.bends) { const p = bendXY(n, b); g.lineTo(p.x, p.y); }
      g.stroke();
      g.setLineDash([]);
      n.bends.forEach((b, i) => {
        const { x, y } = bendXY(n, b);
        const active = (drag?.kind === 'bend' && drag.note === n && drag.i === i) || (hoverBend?.note === n && hoverBend.i === i);
        g.beginPath();
        g.arc(x, y, active ? 5.5 : 4.5, 0, Math.PI * 2);
        g.fillStyle = active ? '#fff' : SELECT;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = STAVE;
        g.stroke();
        if (b.r) {
          g.beginPath();
          g.arc(x, y, 7 + b.r * 5, -Math.PI / 2, -Math.PI / 2 + b.r * Math.PI * 2);
          g.strokeStyle = SELECT;
          g.stroke();
        }
      });
    }
  }

  function paint(g, w, h) {
    if (!w || !h) return;
    limitScroll();
    syncSelection();
    const clip = ctx.clip();
    const kw = keyWidth();
    const nw = noteW();
    const bottom = gridBottom();
    const keysY = keyTop();
    const gridLeft = xOf(GRID_LOW) + kw / 2;
    const gridRight = xOf(GRID_HIGH) + kw / 2;
    g.fillStyle = BG;
    g.fillRect(0, 0, w, h);
    const fullW = w;
    w = rollRight();

    g.save();
    g.beginPath();
    g.rect(gridX(), 0, Math.max(0, w - gridX()), bottom);
    g.clip();
    if (clip) {
      // past the clip end: shaded, notes there do not play
      const yEnd = yOf(clip.length);
      if (yEnd < bottom) {
        g.fillStyle = 'rgba(0, 0, 0, 0.22)';
        g.fillRect(gridX(), Math.max(0, yEnd), w, bottom);
      }
      // grid: alternating light/dark snap-step bands, dashed beat lines and solid bar lines
      // of the time signature (taken from the TimeLine at the clip's position)
      const t0 = Math.max(0, timeAt(0));
      const t1 = timeAt(bottom);
      const st = gridStep();
      g.fillStyle = 'rgba(0, 0, 0, 0.10)';
      snapBands(st, view.ppq, t0, t1, (a, b) => {
        const ya = Math.round(yOf(a));
        g.fillRect(gridLeft, ya, gridRight - gridLeft, Math.round(yOf(b)) - ya);
      });
      const line = (t, color, lw = 1, cutNotes = false) => {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = color;
        g.lineWidth = lw * 4;
        g.beginPath();
        let left = gridLeft;
        if (cutNotes) {
          // Compare musical time, not rounded pixels; starts and ends can drift at triplet boundaries.
          const gaps = clip.notes
            .filter((n) => n.start <= t + TIME_EPSILON && n.start + n.length >= t - TIME_EPSILON)
            .map((n) => { const cx = bodyX(n, t - n.start); return [cx - nw - overlap(), cx + nw + overlap()]; })
            .sort((a, b) => a[0] - b[0]);
          for (const [start, end] of gaps) {
            if (end <= left || start >= gridRight) continue;
            if (start > left) { g.moveTo(left, y); g.lineTo(Math.min(start, gridRight), y); }
            left = Math.min(gridRight, Math.max(left, end));
          }
        }
        if (left < gridRight) { g.moveTo(left, y); g.lineTo(gridRight, y); }
        g.stroke();
      };
      const m = meter(ctx.song());
      const off = clip.start;
      const bars = [...barLines(null, off + t0, off + t1, m)].map((b) => b.t - off);
      const drawnBars = spacedBars(m, off, off + t0, off + t1).map((b) => b.t - off);
      if (beatsShown(m)) {
        g.setLineDash([12, 12]);
        g.lineDashOffset = 0; // dashes travel with their A#0 anchor
        for (const t of beatLines(null, off + t0, off + t1, m)) {
          if (!gridBeatEnabled(m, t)) continue;
          const local = t - off;
          if (bars.some((b) => Math.abs(b - local) <= TIME_EPSILON)
            || Math.abs(local) <= TIME_EPSILON || Math.abs(local - clip.length) <= TIME_EPSILON) continue;
          line(local, BEAT);
        }
        g.setLineDash([]);
        g.lineDashOffset = 0;
      }
      for (const t of drawnBars) if (gridBeatEnabled(m, t + off)) line(t, BAR_LINE, 1, true);
      line(0, BOUNDARY, 1, true);
      line(clip.length, endHover || drag?.kind === 'clipEnd' ? SELECT : BOUNDARY, 2, true);

      // note bodies
      // Lift the module hue off the charcoal background without changing its identity.
      const color = `color-mix(in srgb, ${ctx.color(clip)} 75%, #fff)`;
      const blackColor = `color-mix(in srgb, ${color} 86%, #000)`;
      const blackSelected = `color-mix(in srgb, ${SELECT} 86%, #000)`;
      for (const n of clip.notes) {
        const y = yOf(n.start);
        const hh = n.length * view.ppq;
        if (y > bottom || y + hh < 0) continue;
        const poly = bendPolyline(n);
        const x = headX(n) - nw / 2;
        if (!poly && (x > w || x + nw < gridX())) continue;
        g.globalAlpha = n.start >= 0 && n.start < clip.length ? 1 : 0.35;
        g.fillStyle = g.strokeStyle = selected.has(n)
          ? (isBlack(n.pitch) ? blackSelected : SELECT)
          : (isBlack(n.pitch) ? blackColor : color);
        g.beginPath();
        const edge = overlap();
        const bw = nw + 2 * edge;
        if (poly) bentBody(g, n, poly, bw);
        else {
          g.roundRect(x - edge, y, bw, hh, Math.min(bw / 2, hh / 2));
          g.fill();
        }
        g.globalAlpha = 1;
      }
    }

    // stave lines (black keys of the 88-key piano), on top of the note bodies; none without a clip
    if (clip) {
      g.strokeStyle = STAVE;
      const thin = Math.min(kw, nw) * 0.22;
      const staveTop = Math.min(bottom, Math.max(0, yOf(0)));
      // the group of three (F# G# A#) is twice as thick as the group of two (C# D#)
      const isThree = (p) => [6, 8, 10].includes(p % 12);
      const stave = (dashed, three) => {
        g.lineWidth = three ? thin * 2 : thin;
        g.beginPath();
        for (let p = PIANO_LOW; p <= PIANO_HIGH; p++) {
          if (!isBlack(p) || CENTRAL.includes(p) !== dashed || isThree(p) !== three) continue;
          const x = xOf(p) + kw / 2;
          g.moveTo(x, staveTop); g.lineTo(x, bottom);
        }
        g.stroke();
      };
      stave(false, false);
      stave(false, true);
      // C#4 + D#4 dashed: marks the central octave; the dashes scroll with the notes
      g.setLineDash([7, 5]);
      g.lineDashOffset = Math.max(0, view.sy);
      stave(true, false);
      g.setLineDash([]);
      g.lineDashOffset = 0;
    }

    if (clip) {
      for (const n of clip.notes) {
        const y = yOf(n.start);
        if (y < -2 * headSize().height || y > bottom) continue;
        head(g, headX(n), y, isBlack(n.pitch), n.start >= 0 && n.start < clip.length ? 1 : 0.4);
      }
      if (hover && !drag) head(g, xOf(hover.pitch) + kw / 2, yOf(hover.t), isBlack(hover.pitch), 0.55);
      paintBends(g, clip);
      if (!isIdea(clip) && clipSilent(ctx.song(), clip)) mutedMark(g, gridX(), 0, w - gridX(), bottom);
      // play position
      const t = playheadTime(clip);
      if (t !== null) {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = PLAYHEAD;
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(gridX(), y); g.lineTo(w, y); g.stroke();
      }
    } else {
      g.fillStyle = '#c3c7d0';
      g.font = '500 12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('No clip selected. Double-click in the TimeLine below to create one.', gridX() + (w - gridX()) / 2, 40);
    }
    if (drag?.kind === 'micro' && drag.moved && clip?.notes.includes(drag.note)) paintSlider(g);
    if (drag?.kind === 'select' && drag.shown && !drag.velocity) {
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const w = Math.abs(drag.x1 - drag.x0);
      const h = Math.abs(drag.y1 - drag.y0);
      g.fillStyle = 'rgba(101, 180, 255, 0.14)';
      g.fillRect(x, y, w, h);
      g.strokeStyle = SELECT;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    g.restore();

    // keyboard strip
    g.fillStyle = '#292b31';
    g.fillRect(0, keysY, fullW, KEYBOARD);
    g.save();
    g.beginPath();
    g.rect(gridX(), keysY, Math.max(0, w - gridX()), KEYBOARD);
    g.clip();
    g.font = '600 8px system-ui, sans-serif';
    g.textAlign = 'center';
    const keyGap = Math.min(1, kw * 0.1);
    // keys held on the MIDI device / computer keyboard (a tuned pitch lights its base key)
    const live = new Set([...(ctx.heldKeys?.() ?? [])].map(basePitch));
    const blackLive = `color-mix(in srgb, ${SELECT} 70%, #000)`;
    const sounding = soundingPitches(clip); // notes of this clip under the playhead while it plays
    const noteColor = clip ? `color-mix(in srgb, ${ctx.color(clip)} 75%, #fff)` : null;
    const blackNote = `color-mix(in srgb, ${noteColor} 70%, #000)`;
    for (let p = 0; p <= PITCH_MAX; p++) {
      const x = xOf(p);
      g.fillStyle = drag?.kind === 'keyboard' && drag.pitch === p ? PLAYHEAD
        : live.has(p) ? (isBlack(p) ? blackLive : SELECT)
        : sounding.has(p) ? (isBlack(p) ? blackNote : noteColor)
        : inPiano(p) ? (isBlack(p) ? '#191a20' : '#bfc1c7') : (isBlack(p) ? '#24262c' : '#777a84');
      g.fillRect(x + keyGap / 2, keysY + 1, kw - keyGap, KEYBOARD - 2);
      if (p === hoverPitch) {
        g.fillStyle = PLAYHEAD;
        g.fillRect(x + keyGap / 2, h - 5, kw - keyGap, 4);
      }
      if (p % 12 === 0 && kw * 12 >= 24) {
        g.fillStyle = inPiano(p) ? '#33343b' : '#c3c7d0';
        g.fillText(noteName(p), x + kw / 2, h - 7);
      }
    }
    g.restore();

    // bar / beat ruler, right of the velocity strip
    g.fillStyle = '#292b31';
    g.fillRect(velW(), 0, GUTTER, bottom);
    if (clip) {
      g.save();
      g.beginPath();
      g.rect(velW(), 0, GUTTER, bottom);
      g.clip();
      g.font = '600 10px ui-monospace, monospace';
      g.textAlign = 'right';
      g.textBaseline = 'top';
      const m = meter(ctx.song());
      const off = clip.start;
      const t0 = off + Math.max(0, timeAt(0));
      const t1 = off + timeAt(bottom);
      g.strokeStyle = BEAT;
      g.lineWidth = 2;
      g.beginPath();
      if (beatsShown(m)) {
        for (const t of beatLines(null, t0, t1, m)) { const y = Math.round(yOf(t - off)) + 0.5; g.moveTo(gridX() - 6, y); g.lineTo(gridX(), y); }
      }
      g.stroke();
      let lastY = -Infinity;
      for (const b of spacedBars(m, off, t0, t1)) {
        const y = Math.round(yOf(b.t - off)) + 0.5;
        g.strokeStyle = BAR_LINE;
        g.beginPath(); g.moveTo(velW(), y); g.lineTo(gridX(), y); g.stroke();
        const change = Math.abs(b.t - b.seg.at) < 1e-9;
        if (y - lastY < (change ? 24 : 13)) continue; // no overlapping labels when zoomed out
        lastY = y;
        g.fillStyle = '#c3c7d0';
        g.font = '600 10px ui-monospace, monospace';
        g.fillText(String(b.bar + 1), gridX() - 4, y + 2);
        if (change) { // time signature starts here
          g.fillStyle = '#c4b5f2';
          g.font = '600 9px ui-monospace, monospace';
          g.fillText(`${b.seg.num}/${b.seg.den}`, gridX() - 4, y + 13);
        }
      }
      g.restore();
    }
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(gridX(), 0); g.lineTo(gridX(), h); g.moveTo(0, keysY); g.lineTo(fullW, keysY); g.stroke();
    if (bottom < keysY) { // zoomed in: horizontal scrollbar between the stave and the keys
      g.fillStyle = SB_TRACK;
      g.fillRect(0, bottom, fullW, keysY - bottom);
      g.strokeStyle = '#1e1e21';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, bottom + 0.5); g.lineTo(fullW, bottom + 0.5); g.stroke();
      paintThumb(g, hScrollbar(), false, bottom, hbActive ? 2 : hbHover ? 1 : 0);
    }
    // vertical scrollbar right of the note grid
    g.fillStyle = SB_TRACK;
    g.fillRect(w, 0, fullW - w, bottom);
    g.strokeStyle = '#1e1e21';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(w + 0.5, 0); g.lineTo(w + 0.5, bottom); g.stroke();
    paintThumb(g, scrollbar(), true, w, sbActive ? 2 : sbHover ? 1 : 0);
    vel.paint(g, h);
    if (drag?.kind === 'select' && drag.shown && drag.velocity) {
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.max(0, Math.min(drag.y0, drag.y1));
      const w = Math.abs(drag.x1 - drag.x0);
      const height = Math.min(gridBottom(), Math.max(drag.y0, drag.y1)) - y;
      g.fillStyle = 'rgba(101, 180, 255, 0.14)';
      g.fillRect(x, y, w, height);
      g.strokeStyle = SELECT;
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w, height);
    }
  }

  // ---- hit testing: circles first (they sit on top), then bodies ----
  function hit(x, y) {
    const clip = ctx.clip();
    if (!clip || !inGrid(x, y)) return null;
    const { rx, ry } = headSize();
    const tolerance = Math.min(1, noteW() * 0.1);
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      const dx = x - headX(n);
      const dy = (y - headY(yOf(n.start))) / HEAD_STRETCH;
      const u = dx * Math.cos(TILT) + dy * Math.sin(TILT);
      const v = -dx * Math.sin(TILT) + dy * Math.cos(TILT);
      if ((u / (rx + tolerance)) ** 2 + (v / (ry + tolerance)) ** 2 <= 1) return { note: n, part: 'head' };
    }
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      const ny = yOf(n.start);
      if (y < ny || y > ny + n.length * view.ppq) continue;
      if (Math.abs(x - bodyX(n, timeAt(y) - n.start)) <= noteW() / 2 + overlap()) return { note: n, part: 'body' };
    }
    return null;
  }

  // the bend point of a selected note under (x, y): { note, i } or null (the nearest wins)
  function bendAt(x, y) {
    const clip = ctx.clip();
    if (!clip || !inGrid(x, y)) return null;
    let best = null;
    let bd = BEND_HIT;
    for (const n of clip.notes) {
      if (!n.bends?.length || !selected.has(n)) continue;
      n.bends.forEach((b, i) => {
        const p = bendXY(n, b);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d <= bd) { bd = d; best = { note: n, i }; }
      });
    }
    return best;
  }

  function updateHover(x, y) {
    const inside = ctx.clip() && inGrid(x, y) && timeAt(y) >= 0;
    syncSelection();
    hoverBend = ctx.clip() ? bendAt(x, y) : null;
    const h = inside && !hoverBend ? hit(x, y) : null;
    endHover = !h && onClipEnd(x, y);
    hoverPitch = x >= gridX() && x < rollRight() ? pitchAt(x) : null;
    hover = inside && !h && !hoverBend ? { pitch: pitchAt(x), t: Math.max(0, snapFloor(timeAt(y), step())) } : null;
    const keyboard = keysPlay() && inKeyboard(x, y);
    cv.style.cursor = keyboard ? 'pointer' : h?.part === 'head' ? 'move' : h ? 'ns-resize' : inside ? 'crosshair' : 'default';
    const menuTip = 'hold the right mouse button 250 ms for the menu';
    cv.title = keyboard ? `${noteName(pitchAt(x))} - click to audition`
      : hoverBend ? `Bend point: ${pitchLabel(hoverBend.note.pitch + hoverBend.note.bends[hoverBend.i].d)} (${bendLabel(hoverBend.note.bends[hoverBend.i].d)}) — drag to move it (Shift: whole semitones), wheel rounds it, right-click deletes, ${menuTip}`
      : h ? `${pitchLabel(h.note.pitch)}  start ${+h.note.start.toFixed(4)}  length ${+h.note.length.toFixed(4)} (quarters) — Shift + drag sideways tunes it (micropitch), double-click the body of a selected note to bend it, right-click deletes, ${menuTip}`
        : inside ? `Click to add a note — ${menuTip}` : '';
    const v = ctx.clip() ? vel.hover(x, y) : null;
    if (hoverBend) cv.style.cursor = 'move';
    if (endHover) { cv.style.cursor = 'row-resize'; cv.title = `Clip end at ${+ctx.clip().length.toFixed(4)} quarters — drag to lengthen or shorten the clip`; }
    if (v) { cv.style.cursor = v.cursor; cv.title = `${v.title} — right-click for the menu`; }
    const bar = onScrollbar(x, y);
    sbHover = bar;
    hbHover = onHScrollbar(x, y);
    if (bar) { cv.style.cursor = 'default'; cv.title = 'Drag to scroll the clip, or click the track to jump there'; }
    if (hbHover) { cv.style.cursor = 'default'; cv.title = 'Drag to scroll the zoomed keys sideways, or click the track to jump there (Shift + wheel zooms)'; }
    if (inRuler(x, y)) { cv.style.cursor = 'move'; cv.title = 'Drag sideways to resize the velocity editor, up to zoom time in, down to zoom out — double-click resets width'; }
    s.redraw();
  }

  const pitchLabel = (p) => `${noteName(p)}${centsOf(p) ? ` ${centsLabel(centsOf(p))}` : ''}`;
  const bendLabel = (d) => `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100)) / 100} st`;

  function remove(note) {
    const clip = ctx.clip();
    const i = clip?.notes.indexOf(note) ?? -1;
    if (i >= 0) clip.notes.splice(i, 1);
    selected.delete(note);
  }

  const selectedNotes = () => { syncSelection(); return ctx.clip()?.notes.filter((n) => selected.has(n)) ?? []; };

  // the thick clip end line (where no note covers it) can be dragged
  const END_GRAB = 6;
  const onClipEnd = (x, y) => {
    const clip = ctx.clip();
    return !!clip && inGrid(x, y) && Math.abs(y - yOf(clip.length)) <= END_GRAB;
  };

  // Whether a drag ended as a release: Firefox (macOS) can end a capture with lostpointercapture
  // before / instead of the pointerup when the mouse still moves while released; once the drag
  // moved that counts as a release. pointercancel, blur and Escape still cancel.
  const released = (ev, moved) => ev.type === 'pointerup' || (moved && ev.type === 'lostpointercapture');

  // Drag the clip end: the length follows the pointer (snapped), never into the next clip on the
  // same TimeLine lane. The wheel or dragging past the top / bottom edge scrolls the view along.
  function resizeClip(e, clip) {
    const orig = clip.length;
    const { end } = clipResizeBounds(ctx.song().clips, clip);
    const max = clean(end - clip.start);
    const state = drag = { kind: 'clipEnd', extent: orig, stop: null, refresh: null };
    let moved = false;
    const apply = () => {
      if (drag !== state || !pointer) return;
      const st = step();
      const t = timeAt(clamp(pointer.y, 0, gridBottom()));
      const length = clamp(clean(snapRound(t, st)), Math.max(st, 1 / view.ppq), max);
      if (length !== clip.length) { clip.length = length; moved = true; ctx.live?.(); }
      state.extent = Math.max(state.extent, length);
      s.redraw();
    };
    const auto = gridScroll(apply);
    state.refresh = () => { apply(); auto.update(pointer); };
    hover = null;
    endHover = false;
    const stop = capture(cv, e, (ev) => {
      pointer = s.local(ev);
      state.refresh();
    }, (ev) => {
      auto.stop();
      cv.removeEventListener('blur', stop);
      window.removeEventListener('blur', stop);
      if (!released(ev, moved)) clip.length = orig;
      drag = null;
      if (clip.length !== orig) ctx.changed();
      else if (moved) ctx.live?.();
      if (pointer) updateHover(pointer.x, pointer.y);
      s.redraw();
    });
    state.stop = stop;
    cv.addEventListener('blur', stop);
    window.addEventListener('blur', stop);
    s.redraw();
  }

  // Rectangle selection; a stationary press clicks or, optionally, opens a menu after a hold.
  // The start corner is kept as a time, so the rectangle stays anchored in the clip while the view
  // scrolls: by the mouse wheel (which also starts the rectangle) or by dragging near / past the
  // top or bottom of the note grid (auto-scroll). Selection can so span the whole clip.
  function selectRect(e, x, y, onClick, onHold = null, velocity = false) {
    const clip = ctx.clip();
    const before = selected;
    const beforePoints = vel.selection();
    const state = drag = { kind: 'select', velocity, t0: timeAt(y), c0: x + (velocity ? 0 : view.hx), x0: x, y0: y, x1: x, y1: y, shown: false, stop: null, refresh: null };
    let timer = null;
    let held = false;
    hover = null;
    const hold = () => {
      if (drag !== state || ctx.clip() !== clip || state.shown || held) return;
      held = true;
      clearTimeout(timer);
      onHold();
    };
    const auto = gridScroll(() => apply(), { horizontal: !velocity });
    // the rectangle from the anchored start corner to the pointer, at the current view
    const apply = () => {
      if (held || !pointer || drag !== state) return;
      state.shown = true;
      clearTimeout(timer);
      state.y0 = yOf(state.t0);
      state.x0 = state.c0 - (velocity ? 0 : view.hx); // anchored in pitch, so the rectangle grows while the view pans
      state.x1 = velocity ? clamp(pointer.x, 0, velW()) : clamp(pointer.x, gridX(), rollRight());
      state.y1 = clamp(pointer.y, 0, gridBottom());
      const left = Math.min(state.x0, state.x1);
      const right = Math.max(state.x0, state.x1);
      const top = Math.min(state.y0, state.y1);
      const bottom = Math.max(state.y0, state.y1);
      if (velocity) vel.selectArea(left, right, top, bottom);
      else {
        vel.clearSelection();
        selected = new Set(clip.notes.filter((n) => {
          const nx = headX(n) - noteW() / 2;
          const ny = yOf(n.start);
          const height = Math.max(n.length * view.ppq, 2 * headSize().height);
          return nx + noteW() + overlap() >= left && nx - overlap() <= right && ny + height >= top && ny <= bottom;
        }));
      }
      s.redraw();
    };
    const update = (ev) => {
      if (held) return;
      pointer = s.local(ev);
      if (!state.shown && Math.hypot(pointer.x - x, pointer.y - y) < (onHold ? RIGHT_HOLD_SLOP : dragThreshold())) return;
      apply();
      auto.update(pointer);
    };
    // after the wheel scrolled or zoomed the view: follow it (a wheel turn also starts the rectangle)
    state.refresh = () => {
      if (held || ctx.clip() !== clip) return;
      apply();
      auto.update(pointer);
    };
    s.redraw();
    const stop = capture(cv, e, update, (ev) => {
      const cancelled = !released(ev, state.shown) || ctx.clip() !== clip;
      if (!cancelled && !held && ev.type === 'pointerup') {
        update(ev);
        // A busy event loop can deliver release before the overdue timer callback.
        if (onHold && !state.shown && ev.timeStamp - e.timeStamp >= RIGHT_HOLD_MS) hold();
      }
      auto.stop();
      clearTimeout(timer);
      cv.removeEventListener('blur', stop);
      window.removeEventListener('blur', stop);
      if (cancelled && !held && ctx.clip() === clip) {
        selected = before;
        vel.restoreSelection(beforePoints);
      }
      drag = null;
      if (!cancelled && !held && !state.shown) onClick(ev);
      if (pointer) updateHover(pointer.x, pointer.y);
      s.redraw();
    });
    state.stop = stop;
    cv.addEventListener('blur', stop);
    window.addEventListener('blur', stop);
    if (onHold) timer = setTimeout(hold, RIGHT_HOLD_MS);
  }

  // Shift + drag a note's circle sideways: micropitch (the selection it is in tunes along, each
  // note by the same number of cents, and stays on its key); Shift + click toggles it in the
  // selection as before
  function tune(e, clip, note, x0) {
    const base = selected;
    const group = selected.has(note) && selected.size > 1 ? selectedNotes() : [note];
    const origs = group.map((n) => ({ key: basePitch(n.pitch), cents: centsOf(n.pitch), pitch: n.pitch }));
    let pv = null;
    const state = { kind: 'micro', note, moved: false, stop: null };
    drag = state;
    hover = null;
    const apply = (p) => {
      // 0.1 cent steps, MICRO_PX px per cent
      const delta = Math.round(((p.x - x0) / MICRO_PX) * 10) / 10;
      group.forEach((n, i) => { n.pitch = withCents(origs[i].key, origs[i].cents + delta); });
      if (pv) ctx.preview.bend?.(pv, note.pitch);
      s.redraw();
    };
    const stop = capture(cv, e, (ev) => {
      const p = s.local(ev);
      pointer = p;
      if (!state.moved) {
        if (Math.abs(p.x - x0) < dragThreshold()) return;
        state.moved = true;
        selected = new Set(group);
        pv = ctx.preview.on(clip, note.pitch);
      }
      apply(p);
    }, (ev) => {
      ctx.preview.off(pv);
      cv.removeEventListener('blur', stop);
      window.removeEventListener('blur', stop);
      drag = null;
      const cancelled = !released(ev, state.moved) || ctx.clip() !== clip;
      if (state.moved && cancelled) {
        group.forEach((n, i) => { n.pitch = origs[i].pitch; });
        selected = base;
      } else if (state.moved) {
        if (group.some((n, i) => n.pitch !== origs[i].pitch)) ctx.changed();
      } else if (!cancelled) { // Shift + click: toggle the note in the selection
        selected = new Set(base);
        if (selected.has(note)) selected.delete(note); else selected.add(note);
      }
      const p = s.local(ev);
      updateHover(p.x, p.y);
      s.redraw();
    });
    state.stop = stop;
    cv.addEventListener('blur', stop);
    window.addEventListener('blur', stop);
    s.redraw();
  }

  const bendTime = (note, time, lo, hi) => clean(clamp(snapRound(time, step()) - note.start, lo, hi));
  const bendPitch = (note, pitch, free) => clamp((free ? pitch : Math.round(pitch)) - note.pitch,
    Math.max(-BEND_MAX, -note.pitch), Math.min(BEND_MAX, PITCH_MAX - note.pitch));

  // Insert at the snapped pointer; an existing point at that time takes it. Drag immediately.
  function insertBend(e, clip, note, x, y) {
    const before = note.bends;
    const t = bendTime(note, timeAt(y), 0, note.length);
    if (t <= 1e-9) return false;
    const d = bendPitch(note, pitchFromX(x), e.shiftKey);
    const pts = [...(before ?? [])];
    let i = 0;
    while (i < pts.length && pts[i].t < t - 1e-9) i++;
    if (pts[i] && Math.abs(pts[i].t - t) <= 1e-9) pts[i] = { ...pts[i], d };
    else pts.splice(i, 0, { t, d, r: NEW_NOTE_POINT_ROUND });
    note.bends = pts;
    dragBend(e, clip, note, i, x, y, before);
    return true;
  }

  // Shift frees only pitch; time follows Free timing. Stay between neighbours inside the note.
  // before = the bends to
  // restore on cancel (when the point was just inserted), changed() on release
  function dragBend(e, clip, note, i, x, y, before = note.bends) {
    const orig = note.bends;
    const p0 = orig[i];
    const x0 = bendXY(note, p0).x + view.hx; // content x: stays put while the view pans sideways
    const lo = i > 0 ? orig[i - 1].t : 0;
    const hi = i < orig.length - 1 ? orig[i + 1].t : Math.max(note.length, p0.t);
    const inserted = before !== orig;
    const state = { kind: 'bend', note, i, moved: false, stop: null, refresh: null };
    const tStart = timeAt(y);
    let pv = null;
    let shift = e.shiftKey;
    drag = state;
    hover = null;
    const apply = () => {
      if (drag !== state || !pointer) return;
      const q = pointer;
      const d = bendPitch(note, pitchFromX(x0 - view.hx + clampX(q.x) - x), shift);
      let t = bendTime(note, note.start + p0.t + timeAt(clamp(q.y, 0, gridBottom())) - tStart, lo, hi);
      if (t <= 1e-9) t = Math.min(hi, 1 / view.ppq); // just after the note's start
      note.bends = orig.map((b, j) => (j === i ? { t, d, r: b.r } : b));
      const pitch = clamp(note.pitch + d, 0, PITCH_MAX);
      if (!pv) pv = ctx.preview.on(clip, pitch);
      else ctx.preview.bend?.(pv, pitch);
      hoverPitch = basePitch(pitch);
      s.redraw();
    };
    const auto = gridScroll(apply, { horizontal: true });
    const stop = capture(cv, e, (ev) => {
      const q = s.local(ev);
      pointer = q;
      shift = ev.shiftKey;
      if (!state.moved && Math.hypot(q.x - x, q.y - y) < 2) return;
      state.moved = true;
      presses.reset();
      apply();
      auto.update(q);
      state.refresh = () => { apply(); auto.update(pointer); };
    }, (ev) => {
      auto.stop();
      ctx.preview.off(pv);
      cv.removeEventListener('blur', stop);
      window.removeEventListener('blur', stop);
      drag = null;
      const cancelled = !released(ev, state.moved) || ctx.clip() !== clip;
      if (cancelled) {
        if (inserted || state.moved) note.bends = before;
        if (!note.bends?.length) delete note.bends;
      } else if (inserted || state.moved) ctx.changed();
      const p = s.local(ev);
      updateHover(p.x, p.y);
      s.redraw();
    });
    state.stop = stop;
    cv.addEventListener('blur', stop);
    window.addEventListener('blur', stop);
    s.redraw();
  }

  function deleteBend(note, i) {
    if (!note.bends?.[i]) return;
    const bends = note.bends.filter((_, j) => j !== i);
    if (bends.length) note.bends = bends; else delete note.bends;
    hoverBend = null;
    ctx.changed();
    s.redraw();
  }
  // straight notes again: the bends of the selected notes are removed
  function resetBends() {
    const notes = selectedNotes().filter((n) => n.bends);
    if (!notes.length) return;
    for (const n of notes) delete n.bends;
    ctx.changed();
    s.redraw();
  }

  // the micropitch slider above the note being tuned: ±50 cents, the tuning filled from the centre
  function paintSlider(g) {
    const n = drag.note;
    const kw = noteW();
    const W = Math.min(SLIDER_W, Math.max(60, rollRight() - gridX() - 8));
    const H = 34;
    const hx = headX(n);
    const left = clamp(hx - W / 2, gridX() + 4, rollRight() - W - 4);
    const hy = headY(yOf(n.start));
    const hh = headSize().height;
    const above = hy - hh - H - 10;
    // above the circle; flip below it when there is no room at the top of the view
    const top = above >= 4 ? above : clamp(hy + hh + 10, 4, Math.max(4, gridBottom() - H - 4));
    const below = top > hy;
    const cents = centsOf(n.pitch);
    const pad = 10;
    const tx0 = left + pad;
    const tx1 = left + W - pad;
    const cx = (tx0 + tx1) / 2;
    const xAt = (c) => cx + (c / 50) * (tx1 - cx);
    const ty = top + H - 10;
    g.save();
    g.fillStyle = 'rgba(20, 21, 26, 0.92)';
    g.strokeStyle = SELECT;
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(left, top, W, H, 6);
    g.fill();
    g.stroke();
    // track, ticks at -50 / -25 / 0 / +25 / +50
    g.fillStyle = '#3a3c44';
    g.fillRect(tx0, ty - 2, tx1 - tx0, 4);
    g.fillStyle = '#8a8d96';
    for (const c of [-50, -25, 0, 25, 50]) g.fillRect(Math.round(xAt(c)) - 0.5, ty - (c ? 4 : 6), 1, c ? 8 : 12);
    g.fillStyle = SELECT;
    const xv = xAt(cents);
    g.fillRect(Math.min(cx, xv), ty - 2, Math.abs(xv - cx), 4);
    g.beginPath();
    g.arc(xv, ty, 5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.stroke();
    // label: key + cents
    g.fillStyle = '#e8e9ee';
    g.font = '600 11px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(`${noteName(n.pitch)} ${centsLabel(cents)}`, cx, top + 13);
    // a thin line down to the note's circle
    g.strokeStyle = 'rgba(101, 180, 255, 0.6)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(clamp(hx, left + 4, left + W - 4), below ? top : top + H);
    g.lineTo(hx, below ? hy + hh - Math.min(2, kw * 0.1) : hy - hh + Math.min(2, kw * 0.1));
    g.stroke();
    g.restore();
  }

  cv.addEventListener('pointerdown', (e) => {
    if (drag) return;
    cv.focus();
    pointer = s.local(e);
    syncSelection();
    if (e.button === 1) {
      drag = { kind: 'pan' };
      startPan(s, e, (dx, dy) => { view.sy -= dy; view.hx -= dx; limitScroll(); ctx.viewChanged?.(); s.redraw(); }, () => { drag = null; });
      return;
    }
    const clip = ctx.clip();
    const { x, y } = s.local(e);
    if (onScrollbar(x, y) || (x >= rollRight() && y >= gridBottom())) { // the scrollbar, and the dead corner below it
      e.preventDefault();
      if (e.button === 0 && y < gridBottom()) scrollbarDrag(e, { x, y });
      return;
    }
    if (y >= gridBottom() && y < keyTop()) { // zoomed in: the horizontal scrollbar (dead left of it)
      e.preventDefault();
      if (e.button === 0 && onHScrollbar(x, y)) hScrollbarDrag(e, { x, y });
      return;
    }
    if (e.button === 0 && inRuler(x, y)) { // the bar ruler is a divider: velocity strip | note grid
      e.preventDefault();
      if (e.detail >= 2) {
        view.velW = VEL_W;
        s.redraw();
        ctx.viewChanged?.();
        return;
      }
      const w0 = velW();
      const sy0 = view.sy;
      const ppq0 = view.ppq;
      const anchorTime = timeAt(y);
      drag = { kind: 'ruler' };
      drag.stop = rulerDrag(cv, e, (dx, dy) => {
        view.velW = clamp(w0 + dx, VEL_MIN, Math.max(VEL_MIN, s.w * VEL_MAX_SHARE));
        view.ppq = clamp(ppq0 * Math.pow(1.15, -dy / 48), 6, 600);
        view.sy = anchorTime * view.ppq - y;
        limitScroll();
        s.redraw();
      }, (ev) => {
        if (ev.type === 'pointercancel') { view.velW = w0; view.sy = sy0; view.ppq = ppq0; }
        drag = null;
        s.redraw();
        if (ev.type !== 'pointercancel' && (view.velW !== w0 || view.sy !== sy0 || view.ppq !== ppq0)) ctx.viewChanged?.();
      });
      return;
    }
    if (keysPlay() && e.button === 0 && inKeyboard(x, y)) {
      e.preventDefault();
      drag = { kind: 'keyboard', pitch: null, stop: null };
      let pv = null;
      const play = (ev) => {
        const p = s.local(ev);
        pointer = p;
        const pitch = inKeyboard(p.x, p.y) ? pitchAt(p.x) : null;
        if (pitch === drag.pitch) return;
        ctx.preview.off(pv);
        pv = pitch === null ? null : ctx.preview.key ? ctx.preview.key(pitch) : ctx.preview.on(clip, pitch);
        drag.pitch = hoverPitch = pitch;
        s.redraw();
      };
      const stop = capture(cv, e, play, () => {
        cv.removeEventListener('blur', stop);
        window.removeEventListener('blur', stop);
        ctx.preview.off(pv);
        drag = null;
        hoverPitch = null;
        s.redraw();
      });
      drag.stop = stop;
      cv.addEventListener('blur', stop);
      window.addEventListener('blur', stop);
      hover = null;
      play(e);
      return;
    }
    if (vel.pointerdown(e, x, y)) { e.preventDefault(); hover = null; return; }
    if (!clip || !inGrid(x, y)) return;
    if (e.button === 2) {
      e.preventDefault();
      presses.reset();
      const bend = bendAt(x, y);
      const note = bend ? null : hit(x, y)?.note;
      selectRect(e, x, y, () => {
        if (bend) { // short right-click on a bend point deletes the point
          if (clip.notes.includes(bend.note)) deleteBend(bend.note, bend.i);
          return;
        }
        if (!note) { // short right-click on empty space: deselect all
          if (selected.size) { selected = new Set(); s.redraw(); }
          return;
        }
        if (!clip.notes.includes(note)) return;
        remove(note);
        ctx.changed();
      }, () => openMenu(x, y, e.clientX, e.clientY));
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const h = hit(x, y);
      if (h) {
        presses.reset();
        selected = new Set(selected);
        if (selected.has(h.note)) selected.delete(h.note); else selected.add(h.note);
        s.redraw();
        return;
      }
    }
    const second = !e.shiftKey && !e.altKey && presses.press(e);
    const bend = !e.altKey && bendAt(x, y);
    if (bend) { presses.reset(); dragBend(e, clip, bend.note, bend.i, x, y); return; }
    if (second) { // double-click a selected note's body: a new bend point, dragged at once
      const b = hit(x, y);
      if (b?.part === 'body' && selected.has(b.note)) {
        presses.reset();
        if (insertBend(e, clip, b.note, x, y)) return;
      }
    }
    if (e.shiftKey && hit(x, y)?.part === 'head') { tune(e, clip, hit(x, y).note, x); return; }
    if (e.shiftKey) { // Shift + drag: rectangle; Shift + click: toggle a note in the selection
      const base = selected;
      selectRect(e, x, y, () => {
        const h = hit(x, y);
        selected = new Set(base);
        if (h && selected.has(h.note)) selected.delete(h.note);
        else if (h) selected.add(h.note);
        else selected.clear();
      });
      return;
    }
    if (!hit(x, y) && onClipEnd(x, y)) { resizeClip(e, clip); return; }
    if (timeAt(y) < 0) return;
    const st = step();
    const minLength = st || 1 / view.ppq;
    const h = hit(x, y);
    const dup = !!h && e.altKey;
    // dragging a selected note edits the whole selection
    const inSelection = !!h && selected.has(h.note) && selected.size > 1;
    let group = inSelection ? selectedNotes() : h ? [h.note] : [];
    const anchor = h ? group.indexOf(h.note) : 0;
    const origs = group.map((n) => ({ pitch: n.pitch, start: n.start, length: n.length, vels: n.vels }));
    let cloned = false;
    let moved = false;
    let pv = null;
    if (h?.part === 'body' && !dup) {
      drag = { kind: 'length', t0: timeAt(y) };
    } else if (h) {
      drag = { kind: 'move', t0: timeAt(y), p0: pitchAt(x) };
      pv = ctx.preview.on(clip, h.note.pitch);
    } else {
      const note = withVelEnd({ pitch: pitchAt(x), start: Math.max(0, snapFloor(timeAt(y), st)), length: lastLength ?? gridStep(), vel: lastVelocity ?? DEFAULT_VEL });
      clip.notes.push(note);
      group = [note];
      drag = { kind: 'new' };
      pv = ctx.preview.on(clip, note.pitch);
    }
    if (!inSelection) selected = new Set(group);
    const sources = group;
    hover = null;
    s.redraw();
    const state = drag;
    const sizing = state.kind === 'new' || state.kind === 'length';
    const auto = gridScroll(() => apply(), { horizontal: state.kind === 'move' });
    capture(cv, e, (ev) => {
      const p = s.local(ev);
      pointer = p;
      if (!moved) {
        const distance = Math.hypot(p.x - x, p.y - y);
        if (sizing) {
          if (distance <= DURATION_DRAG_THRESHOLD) return;
        } else if (distance < dragThreshold()) return;
      }
      moved = true;
      presses.reset();
      apply();
      auto.update(p);
      state.refresh = () => { apply(); auto.update(pointer); };
    }, (ev) => {
      auto.stop();
      ctx.preview.off(pv);
      if (cloned && ev.type === 'pointercancel') {
        group.forEach(remove);
        selected = new Set(sources);
      }
      if (drag.kind !== 'move' && ev.type !== 'pointercancel') lastLength = group[anchor].length;
      if (drag.kind === 'new' && ev.type !== 'pointercancel') lastVelocity = group[anchor].vel;
      if (!moved && inSelection) selected = new Set([h.note]); // click inside a selection: just this note
      drag = null;
      if (moved || !h) ctx.changed();
      const p = s.local(ev);
      updateHover(p.x, p.y);
    });
    function apply() {
      if (drag !== state || !pointer) return;
      const p = pointer;
      if (dup && !cloned) {
        group = group.map((n) => ({ ...n }));
        clip.notes.push(...group);
        selected = new Set(group);
        cloned = true;
      }
      const a = origs[anchor];
      const end = timeAt(clamp(p.y, 0, gridBottom())); // past the grid edge the time stays at the edge while it scrolls
      if (drag.kind === 'new') {
        const n = group[0];
        const length = Math.max(minLength, clean(snapRound(end, st) - n.start));
        n.vels = velsForLength(n.vels, n.length, length);
        n.length = length;
      } else if (drag.kind === 'length') {
        const delta = group.length > 1
          ? Math.max(snapRound(end - state.t0, st), Math.min(0, minLength - Math.min(...origs.map((o) => o.length))))
          : Math.max(minLength, clean(snapRound(end, st) - a.start)) - a.length;
        // a velocity point at a note's end follows it (from the original, so swallowed points come back)
        group.forEach((n, i) => {
          n.length = clean(origs[i].length + delta);
          if (origs[i].vels) n.vels = velsForLength(origs[i].vels, origs[i].length, n.length);
        });
      } else {
        // whole semitones that keep every (tuned) pitch inside 0..PITCH_MAX
        const dp = clamp(pitchAt(clampX(p.x)) - drag.p0, Math.ceil(-Math.min(...origs.map((o) => o.pitch)) - 1e-9), Math.floor(PITCH_MAX - Math.max(...origs.map((o) => o.pitch)) + 1e-9));
        const dt = Math.max(snapRound(a.start + end - drag.t0, st) - a.start, -Math.min(...origs.map((o) => o.start)));
        const before = group[anchor].pitch;
        group.forEach((n, i) => { n.pitch = clean(origs[i].pitch + dp); n.start = clean(origs[i].start + dt); });
        if (group[anchor].pitch !== before) {
          ctx.preview.off(pv);
          pv = ctx.preview.on(clip, group[anchor].pitch);
        }
      }
      hoverPitch = group[anchor].pitch;
      s.redraw();
    }
  });

  // ---- commands (keyboard and context menu) ----
  function copy() {
    const notes = selectedNotes();
    if (!notes.length) return false;
    const start = Math.min(...notes.map((n) => n.start));
    clipboard = notes.map((n) => ({ ...n, start: clean(n.start - start) }));
    return true;
  }
  function deleteSelected() {
    const notes = selectedNotes();
    if (!notes.length) return;
    notes.forEach(remove);
    ctx.changed();
  }
  // paste with the earliest note at the snapped time at local point p
  function paste(p) {
    const clip = ctx.clip();
    if (!clip || !clipboard.length || !p || !inGrid(p.x, p.y)) return;
    const start = Math.max(0, snapFloor(timeAt(p.y), step()));
    const copies = clipboard.map((n) => ({ ...n, start: clean(start + n.start) }));
    clip.notes.push(...copies);
    selected = new Set(copies);
    hover = null;
    ctx.changed();
  }
  // copies of the selection right after it (its length rounded up to the snap grid)
  function duplicate() {
    const clip = ctx.clip();
    const notes = selectedNotes();
    if (!clip || !notes.length) return;
    const st = step();
    const length = Math.max(...notes.map((n) => n.start + n.length)) - Math.min(...notes.map((n) => n.start));
    const span = st ? Math.ceil(length / st - 1e-9) * st : length;
    const copies = notes.map((n) => ({ ...n, start: clean(n.start + span) }));
    clip.notes.push(...copies);
    selected = new Set(copies);
    ctx.changed();
  }
  // snap the starts of the selected notes (all notes without a selection) to the grid
  function quantize() {
    const clip = ctx.clip();
    if (!clip) return;
    const notes = selected.size ? selectedNotes() : clip.notes;
    const st = gridStep();
    let changed = false;
    for (const n of notes) {
      const t = Math.max(0, snapRound(n.start, st));
      if (t !== n.start) { n.start = t; changed = true; }
    }
    if (changed) ctx.changed();
    s.redraw();
  }
  // move the selected notes by dp semitones and dt quarters (nothing moves past the limits)
  function shift(dp, dt) {
    const notes = selectedNotes();
    if (!notes.length) return;
    if (dp && notes.some((n) => n.pitch + dp < 0 || n.pitch + dp > PITCH_MAX)) return;
    if (dt < 0 && notes.some((n) => clean(n.start + dt) < 0)) return;
    for (const note of notes) {
      note.pitch = clean(note.pitch + dp);
      note.start = clean(note.start + dt);
    }
    hover = null;
    ctx.changed();
    s.redraw();
  }
  // micropitch back to 0 cents: every selected note snaps to its key
  function resetTuning() {
    const notes = selectedNotes().filter((n) => centsOf(n.pitch));
    if (!notes.length) return;
    for (const n of notes) n.pitch = basePitch(n.pitch);
    ctx.changed();
    s.redraw();
  }
  function selectAll() {
    selected = new Set(ctx.clip()?.notes ?? []);
    s.redraw();
  }

  function openMenu(x, y, cx, cy) {
    syncSelection();
    const bend = bendAt(x, y);
    const h = bend ? { note: bend.note } : hit(x, y);
    if (h && !selected.has(h.note)) selected = new Set([h.note]);
    s.redraw();
    const has = selected.size > 0;
    const p = { x, y };
    menu({
      x: cx,
      y: cy,
      items: [
        { label: 'Cut', shortcut: shortcut('X'), disabled: !has, action: () => { if (copy()) deleteSelected(); } },
        { label: 'Copy', shortcut: shortcut('C'), disabled: !has, action: copy },
        { label: 'Paste', shortcut: shortcut('V'), disabled: !clipboard.length, action: () => paste(p) },
        { label: 'Delete', shortcut: '⌫', disabled: !has, action: deleteSelected },
        '-',
        { label: 'Duplicate', shortcut: shortcut('D'), disabled: !has, action: duplicate },
        { label: has ? 'Quantize selection' : 'Quantize all notes', shortcut: 'Q', disabled: !ctx.clip()?.notes.length, action: quantize },
        { label: 'Octave up', shortcut: '⇧→', disabled: !has, action: () => shift(12, 0) },
        { label: 'Octave down', shortcut: '⇧←', disabled: !has, action: () => shift(-12, 0) },
        { label: 'Reset tuning', disabled: !selectedNotes().some((n) => centsOf(n.pitch)), action: resetTuning },
        { label: 'Reset bend', disabled: !selectedNotes().some((n) => n.bends), action: resetBends },
        ...(bend ? [{ label: 'Delete bend point', action: () => deleteBend(bend.note, bend.i) }] : []),
        '-',
        { label: 'Select all', shortcut: shortcut('A'), disabled: !ctx.clip()?.notes.length, action: selectAll },
      ],
    });
  }

  cv.addEventListener('pointermove', (e) => {
    pointer = s.local(e);
    if (drag || e.buttons) return;
    const { x, y } = s.local(e);
    updateHover(x, y);
  });
  cv.addEventListener('pointerleave', () => { pointer = null; vel.leave(); if (!drag) { hover = null; hoverPitch = null; sbHover = false; hbHover = false; s.redraw(); } });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const deleting = key === 'backspace' || key === 'delete';
    const arrow = plain && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key);
    const quant = plain && !e.shiftKey && key === 'q';
    if (!deleting && !arrow && !quant && !(command && ['a', 'x', 'c', 'v', 'd'].includes(key)) && key !== 'escape') return;
    if (key === 'escape' && !drag) {
      syncSelection();
      if (selected.size === 0 && !vel.hasSelection()) return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (drag) {
      if (key === 'escape') drag.stop?.({ type: 'pointercancel' });
      return;
    }
    syncSelection();
    const clip = ctx.clip();
    if (!clip) return;
    if (key === 'escape') { selected.clear(); vel.clearSelection(); s.redraw(); }
    else if (quant) quantize();
    else if (arrow) {
      // Shift: by an octave / a bar
      const oct = e.shiftKey ? 12 : 1;
      const dt = e.shiftKey ? barLength(ctx.song(), clip.start) : gridStep();
      if (key === 'arrowleft') shift(-oct, 0);
      else if (key === 'arrowright') shift(oct, 0);
      else shift(0, key === 'arrowup' ? -dt : dt);
    } else if (key === 'a') selectAll();
    else if (key === 'v') paste(pointer);
    else if (key === 'd') duplicate();
    else if (key === 'c') copy();
    else if (key === 'x') { if (copy()) deleteSelected(); }
    else deleteSelected();
  });

  // wheel on a bend point rounds its corner; true when handled
  function bendWheel(e, x, y) {
    if (drag) return false;
    syncSelection();
    const b = bendAt(x, y);
    if (!b) return false;
    const n = b.note;
    const r = clamp(Math.round((n.bends[b.i].r + (e.deltaY < 0 ? ROUND_STEP : -ROUND_STEP)) * 100) / 100, 0, 1);
    if (r !== n.bends[b.i].r) {
      n.bends = n.bends.map((p, j) => (j === b.i ? { ...p, r } : p));
      ctx.changed();
    }
    s.redraw();
    return true;
  }

  // Shift + wheel zooms pitch around the pointer; a wheel on a velocity / bend point rounds it
  // (both before the scroll / zoom handler)
  cv.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    if (e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = e.deltaY || e.deltaX; // some systems turn Shift + wheel into a sideways wheel
      if (!d) return;
      pointer = s.local(e);
      zoomX(wheelNotches(d, e.deltaMode), pointer.x);
      ctx.viewChanged?.();
      drag?.refresh?.();
      s.redraw();
      return;
    }
    const { x, y } = s.local(e);
    if (!vel.wheel(e, x, y) && !bendWheel(e, x, y)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { passive: false });
  onWheel(cv, {
    zoom(notches, e) { // Ctrl + wheel: zoom time around the pointer
      pointer = s.local(e);
      const { y } = s.local(e);
      const t = timeAt(y);
      view.ppq = clamp(view.ppq * Math.pow(1.15, notches), 6, 600);
      view.sy = t * view.ppq - y;
      limitScroll();
      if (drag?.refresh) drag.refresh();
      ctx.viewChanged?.();
      s.redraw();
    },
    scroll(dx, dy, e) { // pixel deltas as the wheel / trackpad sends them (smooth on trackpads)
      pointer = s.local(e);
      if (!dx && !dy) return;
      if (zoomedX()) { view.hx += dx; limitX(); } // sideways (trackpad): pan the zoomed keys
      view.sy += dy;
      limitScroll();
      if (drag?.refresh) drag.refresh(); // the rectangle follows the scroll
      ctx.viewChanged?.();
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    getPointerTime() {
      const clip = ctx.clip();
      if (!clip || !pointer || !inGrid(pointer.x, pointer.y)) return null;
      return clean(clip.start + Math.max(0, snapFloor(timeAt(pointer.y), step())));
    },
    // scroll so the clip start is visible (called when another clip gets selected)
    reveal() { view.sy = -TOP_MARGIN; s.redraw(); },
    getView: () => ({ ...view }),
    setView(v) {
      view.velW = Number.isFinite(v?.velW) ? Math.max(VEL_MIN, v.velW) : VEL_W;
      view.hz = Number.isFinite(v?.hz) ? clamp(v.hz, 1, HZ_MAX) : 1;
      view.hx = Number.isFinite(v?.hx) ? Math.max(0, v.hx) : 0;
      if (!v) { s.redraw(); return; }
      for (const k of ['sy', 'ppq']) if (Number.isFinite(v[k])) view[k] = v[k];
      view.ppq = clamp(view.ppq, 6, 600);
      s.redraw();
    },
  };
}
