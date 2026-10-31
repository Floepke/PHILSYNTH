// Vertical piano roll. Time runs down; pitch runs left -> right, one column per MIDI note (0..127).
// Inside the 88-key piano range (A0..C8) every black key is drawn as a black stave line through
// the middle of its column, ON TOP of the notes, so black-key notes sit under a line and
// white-key notes sit between the lines (2- and 3-line groups like a keyboard). Outside the
// piano range there are no lines, notes just float.
// The keyboard sits below the stave. Noteheads are left-tilted ovals, white/black by key.
// All 128 MIDI pitches fit the available width; only time can be scrolled / zoomed.
//   click / drag the keyboard  audition pitches on the clip's target without editing notes
//   click / drag on empty space  insert a note (last used length), dragging sets its duration
//   drag a note's coloured body  set the duration: the end jumps to the pointer, snapped to the grid
//                                (all selected notes change by the same amount when it is selected)
//   drag a note's circle         change pitch (sideways) and start time (moves the whole selection)
//   Shift + drag / right drag    select notes with a rectangle
//   Shift + click a note         add it to / remove it from the selection
//   Alt + drag a note           clone it (or the selection) and move the clones
//   right click                 delete the note under the pointer on release
//   hold right button 500 ms    open the menu instead (release never deletes)
//   Backspace / Delete          delete selected notes
//   Left / Right                transpose selected notes by a semitone (Shift: an octave)
//   Up / Down                   move selected notes by one snap step (Shift: a bar)
//   Ctrl/Cmd + X / C / V        cut / copy / paste notes at the pointer's snapped time
//   Ctrl/Cmd + D                duplicate the selection right after itself
//   Ctrl/Cmd + A, Escape        select all / clear the selection
//   Q                           quantize note starts to the grid (selection, else all notes)
// The velocity strip on the left edits the velocity (curves) of the selected notes, see velocity.js.
// Everything snaps to the snap grid (base note ÷ divider).
import { isBlack, inPiano, snapStep, snapFloor, snapRound, noteName, PIANO_LOW, PIANO_HIGH, PITCH_MAX, BAR, DEFAULT_VEL, clean, meter, barLines, beatLines, barLength } from '../song.js';
import { createSurface, capture, startPan, onWheel, clamp, snapBands, RIGHT_HOLD_MS, RIGHT_HOLD_SLOP } from './surface.js';
import { createVelocityStrip, VEL_W } from './velocity.js';
import { showMenu, shortcut } from './menu.js';

const CENTRAL = [61, 63]; // C#4 and D#4, the black keys next to middle C
const GRID_LOW = 22; // A#0 (American notation)
const GRID_HIGH = 106; // A#7

const KEYBOARD = 24;
const TOP_MARGIN = 32;
const TILT = -Math.PI / 9;
const GUTTER = 36; // bar / beat ruler (right of the velocity strip)
const LEFT = VEL_W + GUTTER; // left edge of the note grid
const BG = '#45464e';
const PLAYHEAD = '#ff916e';
const SELECT = '#65b4ff';
const STAVE = '#111216';
const BEAT = '#5d606a';
const BAR_LINE = '#797d88';
const BOUNDARY = '#a1a7b3';

// ctx: { song(), clip(), color(clip), preview: { on(clip, pitch) -> handle, off(handle) }, changed(), transport,
//        menu?(opts) (context menu, default showMenu) }
export function createPianoRoll(host, ctx) {
  const view = { sy: -TOP_MARGIN, ppq: 48, snapVelocity: true };
  let hover = null; // { pitch, t } where a click would insert a note
  let hoverPitch = null;
  let drag = null;
  let pointer = null;
  let selectionClip = null;
  let selected = new Set();
  let clipboard = [];
  let lastLength = null; // length of the last drawn / resized note: new notes get it
  const menu = (opts) => (ctx.menu ?? showMenu)(opts);

  const s = createSurface(host, paint);
  const { cv } = s;
  const keyWidth = () => Math.max(0, s.w - LEFT) / (PITCH_MAX + 1);
  const overlap = () => Math.min(0.5, keyWidth() * 0.05);
  const dragThreshold = () => Math.min(3, keyWidth() * 0.4);
  const xOf = (p) => LEFT + p * keyWidth();
  const yOf = (t) => t * view.ppq - view.sy;
  const pitchAt = (x) => keyWidth() > 0 ? clamp(Math.floor((x - LEFT) / keyWidth()), 0, PITCH_MAX) : 0;
  const timeAt = (y) => (y + view.sy) / view.ppq;
  const gridBottom = () => Math.max(0, s.h - KEYBOARD);
  const inGrid = (x, y) => x >= LEFT && x < s.w && y >= 0 && y < gridBottom();
  const inKeyboard = (x, y) => x >= LEFT && x < s.w && y >= gridBottom() && y < s.h;
  const headSize = () => {
    const rx = (keyWidth() - overlap()) / (2 * Math.hypot(Math.cos(TILT), 0.72 * Math.sin(TILT)));
    const ry = rx * 0.72;
    return { rx, ry, height: Math.hypot(rx * Math.sin(TILT), ry * Math.cos(TILT)) + 0.75 };
  };
  const headY = (y) => y + headSize().height;
  const step = () => snapStep(ctx.song().snap);
  const vel = createVelocityStrip({
    cv,
    local: s.local,
    clip: () => ctx.clip(),
    selected: () => { syncSelection(); return selected; },
    setSelected: (set) => { selected = set; },
    yOf,
    timeAt,
    bottom: gridBottom,
    ppq: () => view.ppq,
    song: ctx.song,
    color: ctx.color,
    changed: () => ctx.changed(),
    redraw: s.redraw,
    menu,
    snapVelocity: () => view.snapVelocity,
    toggleSnapVelocity() {
      view.snapVelocity = !view.snapVelocity;
      ctx.changed();
      s.redraw();
    },
  });

  const minBeat = (m) => Math.min(...m.map((x) => x.beat));

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
    const end = clip ? Math.max(clip.length, ...clip.notes.map((n) => n.start + n.length)) : BAR;
    view.sy = clamp(view.sy, -TOP_MARGIN, Math.max(0, (end + BAR) * view.ppq - gridBottom()));
  }

  function head(g, x, y, black, alpha = 1) {
    g.globalAlpha = alpha;
    g.beginPath();
    const { rx, ry } = headSize();
    g.ellipse(x, headY(y), rx, ry, TILT, 0, Math.PI * 2);
    g.fillStyle = black ? STAVE : '#e0e1dc';
    g.fill();
    g.lineWidth = Math.min(1.5, keyWidth() * 0.15);
    g.strokeStyle = STAVE;
    g.stroke();
    g.globalAlpha = 1;
  }

  function paint(g, w, h) {
    if (!w || !h) return;
    limitScroll();
    syncSelection();
    const clip = ctx.clip();
    const kw = keyWidth();
    const bottom = gridBottom();
    const gridLeft = xOf(GRID_LOW) + kw / 2;
    const gridRight = xOf(GRID_HIGH) + kw / 2;
    g.fillStyle = BG;
    g.fillRect(0, 0, w, h);

    g.save();
    g.beginPath();
    g.rect(LEFT, 0, Math.max(0, w - LEFT), bottom);
    g.clip();
    if (clip) {
      // past the clip end: shaded, notes there do not play
      const yEnd = yOf(clip.length);
      if (yEnd < bottom) {
        g.fillStyle = 'rgba(0, 0, 0, 0.22)';
        g.fillRect(LEFT, Math.max(0, yEnd), w, bottom);
      }
      // grid: alternating light/dark snap-step bands, dashed beat lines and solid bar lines
      // of the time signature (taken from the TimeLine at the clip's position)
      const t0 = Math.max(0, timeAt(0));
      const t1 = timeAt(bottom);
      const st = step();
      g.fillStyle = 'rgba(0, 0, 0, 0.06)';
      snapBands(st, view.ppq, t0, t1, (a, b) => {
        const ya = Math.round(yOf(a));
        g.fillRect(gridLeft, ya, gridRight - gridLeft, Math.round(yOf(b)) - ya);
      });
      const line = (t, color, lw = 1) => {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = color;
        g.lineWidth = lw * 2;
        g.beginPath(); g.moveTo(gridLeft, y); g.lineTo(gridRight, y); g.stroke();
      };
      const m = meter(ctx.song());
      const off = clip.start;
      if (minBeat(m) * view.ppq >= 5) {
        g.setLineDash([3, 3]);
        g.lineDashOffset = 0; // dashes travel with their A#0 anchor
        for (const t of beatLines(null, off + t0, off + t1, m)) line(t - off, BEAT);
        g.setLineDash([]);
        g.lineDashOffset = 0;
      }
      for (const b of barLines(null, off + t0, off + t1, m)) line(b.t - off, BAR_LINE);
      line(0, BOUNDARY, 2);
      line(clip.length, BOUNDARY, 2);

      // note bodies
      // Lift the module hue off the charcoal background without changing its identity.
      const color = `color-mix(in srgb, ${ctx.color(clip)} 75%, #fff)`;
      const blackColor = `color-mix(in srgb, ${color} 86%, #000)`;
      const blackSelected = `color-mix(in srgb, ${SELECT} 86%, #000)`;
      for (const n of clip.notes) {
        const y = yOf(n.start);
        const hh = n.length * view.ppq;
        if (y > bottom || y + hh < 0) continue;
        const x = xOf(n.pitch);
        if (x > w || x + kw < LEFT) continue;
        g.globalAlpha = n.start >= 0 && n.start < clip.length ? 1 : 0.35;
        g.fillStyle = selected.has(n)
          ? (isBlack(n.pitch) ? blackSelected : SELECT)
          : (isBlack(n.pitch) ? blackColor : color);
        g.beginPath();
        const edge = overlap();
        g.roundRect(x - edge, y, kw + 2 * edge, hh, Math.min((kw + 2 * edge) / 2, hh / 2));
        g.fill();
        g.globalAlpha = 1;
      }
    }

    // stave lines (black keys of the 88-key piano), on top of the note bodies
    g.strokeStyle = STAVE;
    const thin = kw * 0.22;
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

    if (clip) {
      for (const n of clip.notes) {
        const y = yOf(n.start);
        if (y < -2 * headSize().height || y > bottom) continue;
        head(g, xOf(n.pitch) + kw / 2, y, isBlack(n.pitch), n.start >= 0 && n.start < clip.length ? 1 : 0.4);
      }
      if (hover && !drag) head(g, xOf(hover.pitch) + kw / 2, yOf(hover.t), isBlack(hover.pitch), 0.55);
      // play position
      const { playing, pos, clipId } = ctx.transport;
      const t = pos - clip.start;
      if ((playing || pos > 0) && (clipId == null || clipId === clip.id) && t >= 0 && t <= clip.length) {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = PLAYHEAD;
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(LEFT, y); g.lineTo(w, y); g.stroke();
      }
    } else {
      g.fillStyle = '#c3c7d0';
      g.font = '500 12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('No clip selected. Double-click in the TimeLine below to create one.', LEFT + (w - LEFT) / 2, 40);
    }
    if (drag?.kind === 'select' && drag.shown) {
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
    g.fillRect(0, bottom, w, KEYBOARD);
    g.save();
    g.beginPath();
    g.rect(LEFT, bottom, Math.max(0, w - LEFT), KEYBOARD);
    g.clip();
    g.font = '600 8px system-ui, sans-serif';
    g.textAlign = 'center';
    const keyGap = Math.min(1, kw * 0.1);
    for (let p = 0; p <= PITCH_MAX; p++) {
      const x = xOf(p);
      g.fillStyle = drag?.kind === 'keyboard' && drag.pitch === p ? PLAYHEAD
        : inPiano(p) ? (isBlack(p) ? '#191a20' : '#bfc1c7') : (isBlack(p) ? '#24262c' : '#777a84');
      g.fillRect(x + keyGap / 2, bottom + 1, kw - keyGap, KEYBOARD - 2);
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
    g.fillRect(VEL_W, 0, GUTTER, bottom);
    if (clip) {
      g.save();
      g.beginPath();
      g.rect(VEL_W, 0, GUTTER, bottom);
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
      if (minBeat(m) * view.ppq >= 5) {
        for (const t of beatLines(null, t0, t1, m)) { const y = Math.round(yOf(t - off)) + 0.5; g.moveTo(LEFT - 6, y); g.lineTo(LEFT, y); }
      }
      g.stroke();
      let lastY = -Infinity;
      for (const b of barLines(null, t0, t1, m)) {
        const y = Math.round(yOf(b.t - off)) + 0.5;
        g.strokeStyle = BAR_LINE;
        g.beginPath(); g.moveTo(VEL_W, y); g.lineTo(LEFT, y); g.stroke();
        const change = Math.abs(b.t - b.seg.at) < 1e-9;
        if (y - lastY < (change ? 24 : 13)) continue; // no overlapping labels when zoomed out
        lastY = y;
        g.fillStyle = '#c3c7d0';
        g.font = '600 10px ui-monospace, monospace';
        g.fillText(String(b.bar + 1), LEFT - 4, y + 2);
        if (change) { // time signature starts here
          g.fillStyle = '#c4b5f2';
          g.font = '600 9px ui-monospace, monospace';
          g.fillText(`${b.seg.num}/${b.seg.den}`, LEFT - 4, y + 13);
        }
      }
      g.restore();
    }
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(LEFT, 0); g.lineTo(LEFT, h); g.moveTo(0, bottom); g.lineTo(w, bottom); g.stroke();
    vel.paint(g, h);
  }

  // ---- hit testing: circles first (they sit on top), then bodies ----
  function hit(x, y) {
    const clip = ctx.clip();
    if (!clip || !inGrid(x, y)) return null;
    const { rx, ry } = headSize();
    const tolerance = Math.min(1, keyWidth() * 0.1);
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      const dx = x - (xOf(n.pitch) + keyWidth() / 2);
      const dy = y - headY(yOf(n.start));
      const u = dx * Math.cos(TILT) + dy * Math.sin(TILT);
      const v = -dx * Math.sin(TILT) + dy * Math.cos(TILT);
      if ((u / (rx + tolerance)) ** 2 + (v / (ry + tolerance)) ** 2 <= 1) return { note: n, part: 'head' };
    }
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      const nx = xOf(n.pitch);
      const ny = yOf(n.start);
      if (x >= nx - overlap() && x < nx + keyWidth() + overlap() && y >= ny && y <= ny + n.length * view.ppq) return { note: n, part: 'body' };
    }
    return null;
  }

  function updateHover(x, y) {
    const inside = ctx.clip() && inGrid(x, y) && timeAt(y) >= 0;
    const h = inside ? hit(x, y) : null;
    hoverPitch = x >= LEFT ? pitchAt(x) : null;
    hover = inside && !h ? { pitch: pitchAt(x), t: Math.max(0, snapFloor(timeAt(y), step())) } : null;
    const keyboard = ctx.clip() && inKeyboard(x, y);
    cv.style.cursor = keyboard ? 'pointer' : h?.part === 'head' ? 'move' : h ? 'ns-resize' : inside ? 'crosshair' : 'default';
    cv.title = keyboard ? `${noteName(pitchAt(x))} - click to audition` : h ? `${noteName(h.note.pitch)}  start ${+h.note.start.toFixed(4)}  length ${+h.note.length.toFixed(4)} (quarters)` : '';
    const v = ctx.clip() ? vel.hover(x, y) : null;
    if (v) { cv.style.cursor = v.cursor; cv.title = v.title; }
    s.redraw();
  }

  function remove(note) {
    const clip = ctx.clip();
    const i = clip?.notes.indexOf(note) ?? -1;
    if (i >= 0) clip.notes.splice(i, 1);
    selected.delete(note);
  }

  const selectedNotes = () => { syncSelection(); return ctx.clip()?.notes.filter((n) => selected.has(n)) ?? []; };

  // Rectangle selection; a stationary press clicks or, optionally, opens a menu after a hold.
  function selectRect(e, x, y, onClick, onHold = null) {
    const clip = ctx.clip();
    const before = selected;
    const state = drag = { kind: 'select', x0: x, y0: y, x1: x, y1: y, shown: false, stop: null };
    let timer = null;
    let held = false;
    hover = null;
    const hold = () => {
      if (drag !== state || ctx.clip() !== clip || state.shown || held) return;
      held = true;
      clearTimeout(timer);
      onHold();
    };
    const update = (ev) => {
      if (held) return;
      pointer = s.local(ev);
      if (!state.shown && Math.hypot(pointer.x - x, pointer.y - y) < (onHold ? RIGHT_HOLD_SLOP : dragThreshold())) return;
      clearTimeout(timer);
      state.shown = true;
      state.x1 = clamp(pointer.x, LEFT, s.w);
      state.y1 = clamp(pointer.y, 0, gridBottom());
      const left = Math.min(x, state.x1);
      const right = Math.max(x, state.x1);
      const top = Math.min(y, state.y1);
      const bottom = Math.max(y, state.y1);
      selected = new Set(clip.notes.filter((n) => {
        const nx = xOf(n.pitch);
        const ny = yOf(n.start);
        const height = Math.max(n.length * view.ppq, 2 * headSize().height);
        return nx + keyWidth() + overlap() >= left && nx - overlap() <= right && ny + height >= top && ny <= bottom;
      }));
      s.redraw();
    };
    s.redraw();
    const stop = capture(cv, e, update, (ev) => {
      const cancelled = ev.type !== 'pointerup' || ctx.clip() !== clip;
      if (!cancelled && !held) {
        update(ev);
        // A busy event loop can deliver release before the overdue timer callback.
        if (onHold && ev.timeStamp - e.timeStamp >= RIGHT_HOLD_MS) hold();
      }
      clearTimeout(timer);
      cv.removeEventListener('blur', stop);
      cv.removeEventListener('wheel', stop, true);
      window.removeEventListener('blur', stop);
      if (cancelled && !held && ctx.clip() === clip) selected = before;
      drag = null;
      if (!cancelled && !held && !state.shown) onClick(ev);
      if (pointer) updateHover(pointer.x, pointer.y);
      s.redraw();
    });
    state.stop = stop;
    cv.addEventListener('blur', stop);
    cv.addEventListener('wheel', stop, true);
    window.addEventListener('blur', stop);
    if (onHold) timer = setTimeout(hold, RIGHT_HOLD_MS);
  }

  cv.addEventListener('pointerdown', (e) => {
    if (drag) return;
    cv.focus();
    pointer = s.local(e);
    syncSelection();
    if (e.button === 1) {
      drag = { kind: 'pan' };
      startPan(s, e, (_dx, dy) => { view.sy -= dy; s.redraw(); }, () => { drag = null; });
      return;
    }
    const clip = ctx.clip();
    const { x, y } = s.local(e);
    if (clip && e.button === 0 && inKeyboard(x, y)) {
      e.preventDefault();
      drag = { kind: 'keyboard', pitch: null, stop: null };
      let pv = null;
      const play = (ev) => {
        const p = s.local(ev);
        pointer = p;
        const pitch = inKeyboard(p.x, p.y) ? pitchAt(p.x) : null;
        if (pitch === drag.pitch) return;
        ctx.preview.off(pv);
        pv = pitch === null ? null : ctx.preview.on(clip, pitch);
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
      const note = hit(x, y)?.note;
      selectRect(e, x, y, () => {
        if (!note || !clip.notes.includes(note)) return;
        remove(note);
        ctx.changed();
      }, () => openMenu(x, y, e.clientX, e.clientY));
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
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
    if (timeAt(y) < 0) return;
    const st = step();
    const h = hit(x, y);
    const dup = !!h && e.altKey;
    // dragging a selected note edits the whole selection
    const inSelection = !!h && selected.has(h.note) && selected.size > 1;
    let group = inSelection ? selectedNotes() : h ? [h.note] : [];
    const anchor = h ? group.indexOf(h.note) : 0;
    const origs = group.map((n) => ({ pitch: n.pitch, start: n.start, length: n.length }));
    let cloned = false;
    let moved = false;
    let pv = null;
    if (h?.part === 'body' && !dup) {
      drag = { kind: 'length' };
    } else if (h) {
      drag = { kind: 'move', t0: timeAt(y), p0: pitchAt(x) };
      pv = ctx.preview.on(clip, h.note.pitch);
    } else {
      const note = { pitch: pitchAt(x), start: Math.max(0, snapFloor(timeAt(y), st)), length: lastLength ?? st, vel: DEFAULT_VEL };
      clip.notes.push(note);
      group = [note];
      drag = { kind: 'new' };
      pv = ctx.preview.on(clip, note.pitch);
    }
    if (!inSelection) selected = new Set(group);
    const sources = group;
    hover = null;
    s.redraw();
    capture(cv, e, (ev) => {
      const p = s.local(ev);
      pointer = p;
      if (h && !moved && Math.hypot(p.x - x, p.y - y) < dragThreshold()) return;
      moved = true;
      if (dup && !cloned) {
        group = group.map((n) => ({ ...n }));
        clip.notes.push(...group);
        selected = new Set(group);
        cloned = true;
      }
      const a = origs[anchor];
      if (drag.kind === 'new') {
        group[0].length = Math.max(st, clean(snapRound(timeAt(p.y), st) - group[0].start));
      } else if (drag.kind === 'length') {
        // the end jumps to the snapped pointer position; the rest of the selection changes by the same amount
        const dl = Math.max(st, snapRound(timeAt(p.y), st) - a.start) - a.length;
        group.forEach((n, i) => { n.length = Math.max(st, clean(origs[i].length + dl)); });
      } else {
        const dp = clamp(pitchAt(p.x) - drag.p0, -Math.min(...origs.map((o) => o.pitch)), PITCH_MAX - Math.max(...origs.map((o) => o.pitch)));
        const dt = Math.max(snapRound(a.start + timeAt(p.y) - drag.t0, st) - a.start, -Math.min(...origs.map((o) => o.start)));
        const before = group[anchor].pitch;
        group.forEach((n, i) => { n.pitch = clean(origs[i].pitch + dp); n.start = clean(origs[i].start + dt); });
        if (group[anchor].pitch !== before) {
          ctx.preview.off(pv);
          pv = ctx.preview.on(clip, group[anchor].pitch);
        }
      }
      hoverPitch = group[anchor].pitch;
      s.redraw();
    }, (ev) => {
      ctx.preview.off(pv);
      if (cloned && ev.type === 'pointercancel') {
        group.forEach(remove);
        selected = new Set(sources);
      }
      if (drag.kind !== 'move' && ev.type !== 'pointercancel') lastLength = group[anchor].length;
      if (!moved && inSelection) selected = new Set([h.note]); // click inside a selection: just this note
      drag = null;
      if (moved || !h) ctx.changed();
      const p = s.local(ev);
      updateHover(p.x, p.y);
    });
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
    const span = Math.ceil((Math.max(...notes.map((n) => n.start + n.length)) - Math.min(...notes.map((n) => n.start))) / st - 1e-9) * st;
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
    const st = step();
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
  function selectAll() {
    selected = new Set(ctx.clip()?.notes ?? []);
    s.redraw();
  }

  function openMenu(x, y, cx, cy) {
    syncSelection();
    const h = hit(x, y);
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
  cv.addEventListener('pointerleave', () => { pointer = null; vel.leave(); if (!drag) { hover = null; hoverPitch = null; s.redraw(); } });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const deleting = key === 'backspace' || key === 'delete';
    const arrow = plain && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key);
    const quant = plain && !e.shiftKey && key === 'q';
    if (!deleting && !arrow && !quant && !(command && ['a', 'x', 'c', 'v', 'd'].includes(key)) && key !== 'escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (drag) {
      if (key === 'escape') drag.stop?.({ type: 'pointercancel' });
      return;
    }
    syncSelection();
    const clip = ctx.clip();
    if (!clip) return;
    if (key === 'escape') { selected.clear(); s.redraw(); }
    else if (quant) quantize();
    else if (arrow) {
      // Shift: by an octave / a bar
      const oct = e.shiftKey ? 12 : 1;
      const dt = e.shiftKey ? barLength(ctx.song(), clip.start) : step();
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

  // wheel on a velocity point rounds it (before the scroll / zoom handler)
  cv.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    const { x, y } = s.local(e);
    if (!vel.wheel(e, x, y)) return;
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
      s.redraw();
    },
    scroll(_dx, dy, e) {
      pointer = s.local(e);
      view.sy += dy;
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    // scroll so the clip start is visible (called when another clip gets selected)
    reveal() { view.sy = -TOP_MARGIN; s.redraw(); },
    getView: () => ({ ...view }),
    setView(v) {
      view.snapVelocity = typeof v?.snapVelocity === 'boolean' ? v.snapVelocity : true;
      if (!v) return;
      for (const k of ['sy', 'ppq']) if (Number.isFinite(v[k])) view[k] = v[k];
      view.ppq = clamp(view.ppq, 6, 600);
      s.redraw();
    },
  };
}
