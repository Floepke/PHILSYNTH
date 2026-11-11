// Velocity strip at the left of the piano roll. It shares the roll's vertical time axis;
// velocity runs from 0 (left) to 1 (right).
// Every note shows a stick from the left edge to its start velocity, plus its velocity curve while
// it sounds (velocity can change over time, see note.vels in song.js).
// Editing works on selected notes, keeping each note's start velocity and curve independent.
//   drag a note's handle (start dot)   select that note and set its velocity (Shift: add to selection)
//   drag a selected note's handle      sets every selected start to the dragged velocity;
//                                       each note's curve shifts by its own start-velocity change
//   drag a curve point                 edit points at the same timeline time in selected notes,
//                                       creating missing points in notes sounding at that time
//   Shift + drag (multiple notes)      shift all selected starts and curves together, preserving differences
//   Shift + drag (single note)         fine velocity
//   double-click inside a selected note insert a point for all selected notes (hold to drag it)
//   mouse wheel on a point             round the corner
//   Ctrl/Cmd + drag                    draw a straight dashed line; on release every note start and
//                                       curve point it spans snaps onto it (the selected notes, or
//                                       every note of the clip when nothing is selected)
//   right-drag                         rectangle-select note starts and individual curve points
//   right-click a curve point           menu: Delete point (not the first)
import { pianoTimeStep, snapRound, clean, notePoints, noteVelAt, applyVelLine } from '../song.js';
import { curvePolyline, NEW_NOTE_POINT_ROUND } from '../curve.js';
import { doublePress } from '../doublepress.js';
import { capture, clamp } from './surface.js';
import { registerShortcutMenu } from '../shortcuts.js';

export const VEL_W = 84; // default width; the piano roll's ruler drags it wider (o.width())
const PAD = 7;
const HIT = 7;
const ROUND_STEP = 0.05;
const SELECT = '#65b4ff';
const VEL_SNAP = 16; // velocity snapping levels: 0, 1/16 .. 1

// o: { cv, local(e), clip(), selected() -> Set, setSelected(Set), yOf(t), timeAt(y), bottom(), ppq(), song(),
//      color(clip), changed(), redraw(), menu(opts), snapVelocity(), selectRect(e, x, y, onClick), width()?,
//      rememberVelocity?(value) (committed note-start velocity for new notes),
//      edgeScroll(onScroll)? (an edgeScroll() that scrolls the shared time axis),
//      labelTop()? (top of the label strip, default bottom()) }
export function createVelocityStrip(o) {
  let group = null; // selected notes and their actual point handles at absolute clip times
  let hover = null; // { kind: 'point', i } | { kind: 'note', note }
  let drag = null;
  let line = null; // Ctrl+drag: { a: {t, v}, b: {t, v} } (absolute clip times)
  let selectedPoints = new Set();
  let selectionClip = null;
  const presses = doublePress(); // double-click = down-up-DOWN: the new point drags at once
  const pointMenuItems = (p) => {
    const target = group;
    return [{
      label: 'Delete point', disabled: !p || p.start === true,
      action: () => {
        if (sync() !== target) return;
        const targets = p && !p.start ? targetsFor(p) : [];
        for (const { note, point } of targets) {
          note.vels = note.vels.filter((v) => v !== point);
          if (!note.vels.length) delete note.vels;
        }
        if (!targets.length) return;
        hover = null;
        o.changed();
        o.redraw();
      },
    }];
  };
  registerShortcutMenu('velocity', () => {
    sync();
    return pointMenuItems(hover?.kind === 'point' ? group?.points[hover.i] : null);
  }, { active: () => o.cv.isConnected && document.activeElement === o.cv && !drag && !line, context: 'pianoroll' });

  const W = () => o.width?.() ?? VEL_W;
  const xv = (v) => PAD + v * (W() - 2 * PAD);
  const vx = (x) => clamp((x - PAD) / (W() - 2 * PAD), 0, 1);
  const snapVelocity = (v) => o.snapVelocity() ? Math.round(v * VEL_SNAP) / VEL_SNAP : v;
  const contains = (x, y) => x >= 0 && x < W() && y >= 0 && y < o.bottom();
  const step = () => pianoTimeStep(o.song().snap);
  const sigOf = (notes) => notes.map((n) => `${n.start},${n.length},${n.vel},${JSON.stringify(n.vels ?? [])}`).join(';');

  // Keep actual point identities for hit testing; never average or rewrite independent curves.
  function sync() {
    const clip = o.clip();
    if (selectionClip !== clip) {
      selectionClip = clip;
      selectedPoints.clear();
    }
    if (selectedPoints.size) {
      const livePoints = new Set(clip?.notes.flatMap((n) => n.vels ?? []) ?? []);
      selectedPoints = new Set([...selectedPoints].filter((p) => livePoints.has(p)));
    }
    const sel = o.selected();
    const notes = clip ? clip.notes.filter((n) => sel.has(n) || n.vels?.some((p) => selectedPoints.has(p))).sort((a, b) => a.start - b.start) : [];
    if (!notes.length) { group = null; return null; }
    const sig = sigOf(notes);
    const same = group && group.sig === sig && group.notes.length === notes.length && group.notes.every((n, i) => n === notes[i]);
    if (!same) {
      group = {
        notes,
        points: notes.flatMap((note) => [
          { t: note.start, v: note.vel, r: 0, note, start: true },
          ...(note.vels ?? []).filter((p) => p.t <= note.length).map((point) => ({
            t: clean(note.start + point.t), v: point.v, r: point.r, note, point,
          })),
        ]).sort((a, b) => a.t - b.t),
        sig,
      };
    }
    return group;
  }

  function targetsFor(p, create = false, relative = false) {
    if (!relative && selectedPoints.has(p.point)) {
      return group.notes.flatMap((note) => (note.vels ?? []).filter((point) => selectedPoints.has(point)).map((point) => ({ note, point })));
    }
    const offset = clean(p.t - p.note.start);
    return group.notes.flatMap((note) => {
      const t = relative ? Math.min(offset, note.length) : clean(p.t - note.start);
      if (t <= 1e-9 || t > note.length + 1e-9) return [];
      let point = note.vels?.find((point) => Math.abs(point.t - t) < 1e-9);
      if (!point && create) {
        point = { t, v: noteVelAt(note, t), r: p.r };
        note.vels ??= [];
        note.vels.push(point);
        note.vels.sort((a, b) => a.t - b.t);
      }
      return point ? [{ note, point }] : [];
    });
  }

  function pointAt(x, y) {
    if (!group) return -1;
    let best = -1;
    let bd = HIT;
    group.points.forEach((p, i) => {
      const d = Math.hypot(xv(p.v) - x, o.yOf(p.t) - y);
      if (d <= bd) { bd = d; best = i; }
    });
    return best;
  }

  function noteAt(x, y) {
    const clip = o.clip();
    if (!clip) return null;
    let best = null;
    let bd = HIT;
    for (const n of clip.notes) {
      const d = Math.hypot(xv(n.vel) - x, o.yOf(n.start) - y);
      if (d <= bd) { bd = d; best = n; }
    }
    return best;
  }

  const poly = (pts) => curvePolyline(pts.map((p) => ({ x: p.t, y: p.v, r: p.r })));

  function paint(g, h) {
    const bottom = o.bottom();
    g.fillStyle = '#34353c';
    g.fillRect(0, 0, W(), bottom);
    if (o.snapVelocity()) {
      // alternating light/dark bands between the snap levels (like the roll's snap-step bands)
      g.fillStyle = 'rgba(0, 0, 0, 0.10)';
      for (let k = 1; k < VEL_SNAP; k += 2) {
        const a = Math.round(xv(k / VEL_SNAP));
        g.fillRect(a, 0, Math.round(xv((k + 1) / VEL_SNAP)) - a, bottom);
      }
    }
    g.save();
    g.beginPath();
    g.rect(0, 0, W(), bottom);
    g.clip();
    const clip = o.clip();
    if (clip) {
      sync();
      const sel = o.selected();
      const color = `color-mix(in srgb, ${o.color(clip)} 75%, #fff)`;
      for (const n of clip.notes) {
        const y = o.yOf(n.start);
        const y1 = o.yOf(n.start + n.length);
        if (y > bottom + HIT || y1 < -HIT) continue;
        const on = sel.has(n);
        g.globalAlpha = on ? 0.9 : 0.55;
        g.strokeStyle = on ? SELECT : color;
        // stick: start velocity
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(xv(0), Math.round(y) + 0.5); g.lineTo(xv(n.vel), Math.round(y) + 0.5); g.stroke();
        // the note's curve while it sounds
        g.lineWidth = 1.25;
        g.beginPath();
        const pl = poly(notePoints(n));
        let first = true;
        for (let i = 0; i < pl.length; i += 2) {
          if (pl[i] > n.length) break;
          const px = xv(pl[i + 1]);
          const py = o.yOf(n.start + pl[i]);
          if (first) { g.moveTo(px, py); first = false; } else g.lineTo(px, py);
        }
        g.lineTo(xv(noteVelAt(n, n.length)), y1);
        g.stroke();
        // handle
        g.globalAlpha = 1;
        g.beginPath();
        g.arc(xv(n.vel), y, hover?.note === n || drag?.note === n ? 4 : 3, 0, Math.PI * 2);
        g.fillStyle = on ? SELECT : color;
        g.fill();
      }
      if (group) {
        // Selected notes retain their own curves; show handles at their actual points.
        const pts = group.points;
        pts.forEach((p, i) => {
          const x = xv(p.v);
          const y = o.yOf(p.t);
          const active = (p.point && drag?.point === p.point) || (hover?.kind === 'point' && hover.i === i);
          g.beginPath();
          g.arc(x, y, active ? 5.5 : 4.5, 0, Math.PI * 2);
          g.fillStyle = active ? '#fff' : selectedPoints.has(p.point) || sel.has(p.note) ? SELECT : color;
          g.fill();
          g.lineWidth = 1.5;
          g.strokeStyle = '#111216';
          g.stroke();
          if (p.r) {
            g.beginPath();
            g.arc(x, y, 7 + p.r * 5, -Math.PI / 2, -Math.PI / 2 + p.r * Math.PI * 2);
            g.strokeStyle = SELECT;
            g.stroke();
          }
        });
      }
    }
    // Ctrl+drag: the straight line the velocities snap onto on release
    if (line) {
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(xv(line.a.v), o.yOf(line.a.t));
      g.lineTo(xv(line.b.v), o.yOf(line.b.t));
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();
    // label strip under the velocity area (the keyboard strip of the roll; below the roll's
    // horizontal scrollbar row when that shows)
    const labelTop = Math.max(bottom, o.labelTop?.() ?? bottom);
    g.save();
    g.beginPath();
    g.rect(0, labelTop, W(), h - labelTop);
    g.clip();
    g.fillStyle = '#292b31';
    g.fillRect(0, labelTop, W(), h - labelTop);
    g.fillStyle = '#9a9ea8';
    g.font = '600 9px ui-monospace, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const p = drag?.point ?? (hover?.kind === 'point' ? group?.points[hover.i] : null);
    const v = drag?.note ? drag.note.vel : p ? p.v : hover?.kind === 'note' ? hover.note.vel : null;
    const label = line ? `${Math.round(line.a.v * 127)} → ${Math.round(line.b.v * 127)}` : v === null ? 'VELOCITY' : `VEL ${Math.round(v * 127)}`;
    g.fillText(label, W() / 2, labelTop + (h - labelTop) / 2);
    g.restore();
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(W(), 0); g.lineTo(W(), h); g.stroke();
  }

  function dragPoint(e, i, x, y, inserted = null) {
    const p = group.points[i];
    if (p.start) {
      if (!o.selected().has(p.note)) {
        selectedPoints.clear();
        o.setSelected(new Set([p.note]));
        sync();
      }
      dragNotes(e, p.note, x, y);
      return;
    }
    if (selectedPoints.size && !selectedPoints.has(p.point)) {
      selectedPoints = new Set([p.point]);
      o.setSelected(new Set());
      sync();
    }
    const notes = group.notes;
    const originals = inserted?.originals ?? notes.map((note) => ({ note, vels: structuredClone(note.vels) }));
    const selectedTimes = notes.map((n) => new Set((n.vels ?? []).filter((p) => selectedPoints.has(p)).map((p) => p.t)));
    const targets = inserted?.targets ?? targetsFor(p, true);
    const created = inserted !== null || notes.some((note, index) => (note.vels?.length ?? 0) !== (originals[index].vels?.length ?? 0));
    const t0 = p.t;
    const v0 = p.v;
    const values = targets.map(({ point }) => point.v);
    let minTime = -Infinity;
    let maxTime = Infinity;
    const moving = new Set(targets.map(({ point }) => point));
    const times = targets.map(({ note, point }) => {
      const index = note.vels.indexOf(point);
      const previous = note.vels.slice(0, index).findLast((p) => !moving.has(p));
      const next = note.vels.slice(index + 1).find((p) => !moving.has(p));
      minTime = Math.max(minTime, (previous?.t ?? 0) + 1e-6 - point.t);
      maxTime = Math.min(maxTime, (next ? next.t - 1e-6 : note.length) - point.t);
      return point.t;
    });
    const st = step();
    const tStart = o.timeAt(y);
    let q = null;
    let shift = e.shiftKey;
    drag = { point: p.point, moved: false };
    const state = drag;
    const update = () => {
      if (drag !== state || !q) return;
      const target = snapVelocity(v0 + ((q.x - x) * (shift ? 0.1 : 1)) / (W() - 2 * PAD));
      const delta = target - v0;
      const dt = clamp(snapRound(t0 + o.timeAt(clamp(q.y, 0, o.bottom())) - tStart, st) - t0, minTime, maxTime);
      targets.forEach(({ point }, index) => {
        point.v = clean(clamp(values[index] + delta, 0, 1));
        point.t = clean(times[index] + dt);
      });
      o.redraw();
    };
    // a point's time drags along the roll's time axis: past the top / bottom edge the roll scrolls along
    const auto = o.edgeScroll?.(update);
    o.redraw();
    capture(o.cv, e, (ev) => {
      q = o.local(ev);
      shift = ev.shiftKey;
      if (!drag.moved && Math.hypot(q.x - x, q.y - y) < 2) return;
      drag.moved = true;
      presses.reset();
      update();
      auto?.update(q);
    }, (ev) => {
      auto?.stop();
      if (ev.type === 'pointercancel') {
        originals.forEach(({ note, vels }) => {
          if (vels) note.vels = vels; else delete note.vels;
        });
        selectedPoints = new Set(notes.flatMap((note, i) => (note.vels ?? []).filter((p) => selectedTimes[i].has(p.t))));
      }
      const moved = drag.moved;
      drag = null;
      if ((moved || created) && ev.type !== 'pointercancel') o.changed();
      o.redraw();
    });
  }

  // Ordinary drags share a baseline; Shift group drags share a bounded offset for complete curves.
  function dragNotes(e, note, x, y, relative = false, grabbed = note.vel) {
    const notes = group.notes.filter((n) => o.selected().has(n));
    const originals = notes.map((n) => ({ vel: n.vel, vels: n.vels }));
    const values = relative ? originals.flatMap((n) => [n.vel, ...(n.vels ?? []).map((p) => p.v)]) : [];
    const minDelta = relative ? -values.reduce((min, v) => Math.min(min, v), 1) : 0;
    const maxDelta = relative ? 1 - values.reduce((max, v) => Math.max(max, v), 0) : 0;
    drag = { note, moved: false };
    capture(o.cv, e, (ev) => {
      const q = o.local(ev);
      if (!drag.moved && Math.hypot(q.x - x, q.y - y) < 2) return;
      drag.moved = true;
      presses.reset();
      const target = snapVelocity(clamp(grabbed + ((q.x - x) * (!relative && ev.shiftKey ? 0.1 : 1)) / (W() - 2 * PAD), 0, 1));
      const delta = relative ? clamp(target - grabbed, minDelta, maxDelta) : 0;
      notes.forEach((n, i) => {
        const d = relative ? delta : target - originals[i].vel;
        n.vel = relative ? clean(originals[i].vel + d) : target;
        if (originals[i].vels) n.vels = originals[i].vels.map((p) => ({ ...p, v: clean(clamp(p.v + d, 0, 1)) }));
      });
      o.redraw();
    }, (ev) => {
      if (ev.type === 'pointercancel') notes.forEach((n, i) => {
        n.vel = originals[i].vel;
        if (originals[i].vels) n.vels = originals[i].vels;
      });
      else o.rememberVelocity?.(note.vel);
      const moved = drag.moved;
      drag = null;
      if (moved && ev.type !== 'pointercancel') o.changed();
      o.redraw();
    });
  }
  // A selected start handle always moves that selection's complete curves.
  const groupHandleAt = (x, y) => {
    if (!group) return null;
    const n = noteAt(x, y);
    return n && o.selected().has(n) ? n : null;
  };

  // Ctrl+drag: draw a straight line; on release the velocities under it snap onto it
  function dragLine(e, x, y) {
    const clip = o.clip();
    const sel = o.selected();
    const picked = clip.notes.filter((n) => sel.has(n));
    const notes = picked.length ? picked : clip.notes;
    const at = (q) => ({ t: Math.max(0, o.timeAt(clamp(q.y, 0, o.bottom()))), v: snapVelocity(vx(q.x)) });
    line = { a: at({ x, y }), b: at({ x, y }) };
    const state = line;
    let q = { x, y };
    let moved = false;
    const update = () => {
      if (line !== state) return;
      line.b = at(q);
      o.redraw();
    };
    const auto = o.edgeScroll?.(update);
    o.redraw();
    capture(o.cv, e, (ev) => {
      q = o.local(ev);
      if (!moved && Math.hypot(q.x - x, q.y - y) < 2) return;
      moved = true;
      presses.reset();
      update();
      auto?.update(q);
    }, (ev) => {
      auto?.stop();
      const { a, b } = state;
      line = null;
      if (moved && ev.type !== 'pointercancel') {
        const changed = applyVelLine(notes, a, b);
        const starts = notes.filter((n) => n.start >= Math.min(a.t, b.t) - 1e-9 && n.start <= Math.max(a.t, b.t) + 1e-9);
        const anchor = starts.reduce((best, n) => !best || Math.abs(n.start - b.t) < Math.abs(best.start - b.t) ? n : best, null);
        if (anchor) o.rememberVelocity?.(anchor.vel);
        if (changed) o.changed();
      }
      o.redraw();
    });
  }

  // Insert at the same note-relative offset, retaining a snapshot for cancellation.
  function insert(x, y) {
    const t = clean(snapRound(o.timeAt(y), step()));
    const note = group.notes.find((n) => t > n.start + 1e-9 && t <= n.start + n.length + 1e-9);
    if (!note) return null;
    const originals = group.notes.map((note) => ({ note, vels: structuredClone(note.vels) }));
    const v = snapVelocity(vx(x));
    const p = { t, v, r: NEW_NOTE_POINT_ROUND, note };
    const targets = targetsFor(p, true, true);
    for (const { point } of targets) point.v = v;
    sync();
    const point = targets.find((target) => target.note === note).point;
    return { i: group.points.findIndex((p) => p.note === note && p.point === point), originals, targets };
  }

  return {
    contains,
    paint,
    selection: () => new Set(selectedPoints),
    hasSelection: () => { sync(); return selectedPoints.size > 0; },
    restoreSelection: (points) => { selectedPoints = new Set(points); },
    clearSelection: () => selectedPoints.clear(),
    selectArea(left, right, top, bottom) {
      const clip = o.clip();
      const inside = (v, t) => xv(v) >= left && xv(v) <= right && o.yOf(t) >= top && o.yOf(t) <= bottom;
      selectedPoints.clear();
      o.setSelected(new Set((clip?.notes ?? []).filter((n) => inside(n.vel, n.start))));
      for (const n of clip?.notes ?? []) {
        for (const p of n.vels ?? []) if (p.t <= n.length && inside(p.v, n.start + p.t)) selectedPoints.add(p);
      }
      sync();
    },
    // pointer down inside the strip; returns true when handled
    pointerdown(e, x, y) {
      if (!contains(x, y)) return false;
      if (drag) return true;
      sync();
      if (e.button === 2) {
        if (!o.clip()) return true;
        presses.reset();
        const i = pointAt(x, y);
        const p = group?.points[i];
        const items = pointMenuItems(p);
        e.preventDefault();
        o.selectRect(e, x, y, () => {
          if (i >= 0) o.menu({ x: e.clientX, y: e.clientY, items, shortcutScope: 'velocity' });
          else {
            selectedPoints.clear();
            o.setSelected(new Set());
            o.redraw();
          }
        });
        return true;
      }
      if (e.button !== 0) return true;
      if ((e.ctrlKey || e.metaKey) && o.clip()) { presses.reset(); dragLine(e, x, y); return true; }
      const second = presses.press(e);
      if (e.shiftKey && group?.notes.filter((n) => o.selected().has(n)).length > 1) {
        const i = pointAt(x, y);
        const p = group.points[i];
        if (p && o.selected().has(p.note)) {
          dragNotes(e, p.note, x, y, true, p.v);
          return true;
        }
      }
      const many = groupHandleAt(x, y);
      if (many) { dragNotes(e, many, x, y); return true; }
      const i = pointAt(x, y);
      if (i >= 0) {
        dragPoint(e, i, x, y);
        return true;
      }
      if (second && group) { // down-up-DOWN: insert a point and drag it at once
        const inserted = insert(x, y);
        if (inserted) { dragPoint(e, inserted.i, x, y, inserted); return true; }
      }
      const n = noteAt(x, y);
      if (!n) return true;
      const sel = o.selected();
      if (e.shiftKey) {
        const next = new Set(sel);
        if (next.has(n)) next.delete(n); else next.add(n);
        o.setSelected(next);
        o.redraw();
        return true;
      }
      if (!(sel.size === 1 && sel.has(n))) o.setSelected(new Set([n]));
      selectedPoints.clear();
      sync();
      dragNotes(e, n, x, y);
      return true;
    },
    // wheel on a curve point rounds it; returns true when handled
    wheel(e, x, y) {
      if (!contains(x, y)) return false;
      sync();
      const i = pointAt(x, y);
      if (i < 0 || group.points[i].start) return false;
      const p = group.points[i];
      for (const { point } of targetsFor(p)) {
        point.r = clamp(Math.round((point.r + (e.deltaY < 0 ? ROUND_STEP : -ROUND_STEP)) * 100) / 100, 0, 1);
      }
      o.changed();
      return true;
    },
    // pointer hover; returns { cursor, title } inside the strip, null outside
    hover(x, y) {
      const before = hover;
      if (!contains(x, y)) {
        hover = null;
        if (before) o.redraw();
        return null;
      }
      sync();
      const many = groupHandleAt(x, y);
      if (many) {
        hover = { kind: 'note', note: many };
        o.redraw();
        return { cursor: 'ew-resize', title: `Velocity ${Math.round(many.vel * 127)} — drag to set all ${group.notes.length} selected starts to one velocity; Shift+drag moves selected starts and curves together` };
      }
      const i = pointAt(x, y);
      const n = i < 0 ? noteAt(x, y) : null;
      hover = i >= 0 ? { kind: 'point', i } : n ? { kind: 'note', note: n } : null;
      o.redraw();
      if (i >= 0) {
        const p = group.points[i];
        return { cursor: p.start ? 'ew-resize' : 'move', title: `Velocity ${Math.round(p.v * 127)} (${Math.round(p.v * 100)} %)${p.r ? `  rounding ${Math.round(p.r * 100)} %` : ''} — drag to edit ${selectedPoints.has(p.point) ? 'selected points' : 'corresponding points of selected notes'}; Shift+drag moves selected starts and curves together` };
      }
      if (n) return { cursor: 'pointer', title: `Velocity ${Math.round(n.vel * 127)} — drag to change` };
      return { cursor: 'crosshair', title: `${group ? 'Double-click to add a velocity point' : 'Select notes to edit their velocity'} · Right-drag: select starts / points · Ctrl+drag: draw a velocity line` };
    },
    leave() { if (hover) { hover = null; o.redraw(); } },
  };
}
