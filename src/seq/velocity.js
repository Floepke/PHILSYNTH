// Velocity strip at the left of the piano roll. It shares the roll's vertical time axis;
// velocity runs from 0 (left) to 1 (right).
// Every note shows a stick from the left edge to its start velocity, plus its velocity curve while
// it sounds (velocity can change over time, see note.vels in song.js).
// Editing works on the selected notes: they share ONE curve (a single selected note: its own curve).
// By default that curve is a single value. Edits are written back into every selected note
// (applyVelCurve), so each note follows the shared line during its own time.
//   drag a note's handle (start dot)   select that note and set its velocity (Shift: add to selection)
//   drag a curve point                 change velocity (sideways) and time (snapped, between neighbours)
//                                       the first point stays at the start of the selection
//   Shift + drag                       fine velocity
//   double-click inside the selection  insert a curve point
//   mouse wheel on a point             round the corner
//   right click a point                delete it
import { snapStep, snapRound, clean, notePoints, noteVelAt, groupVelCurve, applyVelCurve } from '../song.js';
import { curvePolyline, NEW_POINT_ROUND } from '../curve.js';
import { capture, clamp } from './surface.js';

export const VEL_W = 84;
const PAD = 7;
const HIT = 7;
const ROUND_STEP = 0.05;
const SELECT = '#65b4ff';

// o: { cv, local(e), clip(), selected() -> Set, setSelected(Set), yOf(t), timeAt(y), bottom(), ppq(), song(),
//      color(clip), changed(), redraw() }
export function createVelocityStrip(o) {
  let group = null; // { notes, points (absolute clip times), start, end, sig }
  let hover = null; // { kind: 'point', i } | { kind: 'note', note }
  let drag = null;

  const xv = (v) => PAD + v * (VEL_W - 2 * PAD);
  const vx = (x) => clamp((x - PAD) / (VEL_W - 2 * PAD), 0, 1);
  const contains = (x, y) => x >= 0 && x < VEL_W && y >= 0 && y < o.bottom();
  const step = () => snapStep(o.song().snap);
  const sigOf = (notes) => notes.map((n) => `${n.start},${n.length},${n.vel},${JSON.stringify(n.vels ?? [])}`).join(';');

  // The shared curve follows the selection; it is rebuilt when the selection or the selected
  // notes change elsewhere (moved, resized, other clip), otherwise kept so edits stay exact.
  function sync() {
    const clip = o.clip();
    const sel = o.selected();
    const notes = clip ? clip.notes.filter((n) => sel.has(n)).sort((a, b) => a.start - b.start) : [];
    if (!notes.length) { group = null; return null; }
    const sig = sigOf(notes);
    const same = group && group.sig === sig && group.notes.length === notes.length && group.notes.every((n, i) => n === notes[i]);
    if (!same) {
      group = {
        notes,
        points: groupVelCurve(notes),
        start: notes[0].start,
        end: Math.max(...notes.map((n) => n.start + n.length)),
        sig,
      };
    }
    return group;
  }

  function apply() {
    applyVelCurve(group.notes, group.points);
    group.sig = sigOf(group.notes);
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
    g.fillRect(0, 0, VEL_W, bottom);
    g.save();
    g.beginPath();
    g.rect(0, 0, VEL_W, bottom);
    g.clip();
    g.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    g.lineWidth = 1;
    g.beginPath();
    for (const v of [0, 0.5, 1]) { const x = Math.round(xv(v)) + 0.5; g.moveTo(x, 0); g.lineTo(x, bottom); }
    g.stroke();
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
        g.arc(xv(n.vel), y, hover?.note === n ? 4 : 3, 0, Math.PI * 2);
        g.fillStyle = on ? SELECT : color;
        g.fill();
      }
      if (group) {
        // the shared curve of the selection
        const pts = group.points;
        const pl = poly(pts);
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.beginPath();
        for (let i = 0; i < pl.length; i += 2) {
          const px = xv(pl[i + 1]);
          const py = o.yOf(pl[i]);
          if (i) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.stroke();
        const last = pts[pts.length - 1];
        if (last.t < group.end) {
          g.setLineDash([3, 3]);
          g.beginPath(); g.moveTo(xv(last.v), o.yOf(last.t)); g.lineTo(xv(last.v), o.yOf(group.end)); g.stroke();
          g.setLineDash([]);
        }
        pts.forEach((p, i) => {
          const x = xv(p.v);
          const y = o.yOf(p.t);
          const active = drag?.i === i || (hover?.kind === 'point' && hover.i === i);
          g.beginPath();
          g.arc(x, y, active ? 5.5 : 4.5, 0, Math.PI * 2);
          g.fillStyle = active ? '#fff' : SELECT;
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
    g.restore();
    // label strip under the velocity area (the keyboard strip of the roll)
    g.fillStyle = '#292b31';
    g.fillRect(0, bottom, VEL_W, h - bottom);
    g.fillStyle = '#9a9ea8';
    g.font = '600 9px ui-monospace, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    const p = drag ? group?.points[drag.i] : hover?.kind === 'point' ? group?.points[hover.i] : null;
    const v = p ? p.v : hover?.kind === 'note' ? hover.note.vel : null;
    g.fillText(v === null ? 'VELOCITY' : `VEL ${Math.round(v * 127)}`, VEL_W / 2, bottom + (h - bottom) / 2);
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(VEL_W, 0); g.lineTo(VEL_W, h); g.stroke();
  }

  function dragPoint(e, i, x, y) {
    const pts = group.points;
    const p = pts[i];
    const t0 = p.t;
    const v0 = p.v;
    const st = step();
    drag = { i, moved: false };
    capture(o.cv, e, (ev) => {
      const q = o.local(ev);
      if (!drag.moved && Math.hypot(q.x - x, q.y - y) < 2) return;
      drag.moved = true;
      p.v = clamp(v0 + ((q.x - x) * (ev.shiftKey ? 0.1 : 1)) / (VEL_W - 2 * PAD), 0, 1);
      if (i > 0) {
        const lo = pts[i - 1].t;
        const hi = i < pts.length - 1 ? pts[i + 1].t : group.end;
        p.t = clean(clamp(snapRound(t0 + (q.y - y) / o.ppq(), st), lo, hi));
      }
      apply();
      o.redraw();
    }, (ev) => {
      if (ev.type === 'pointercancel') { p.t = t0; p.v = v0; apply(); }
      const moved = drag.moved;
      drag = null;
      if (moved) o.changed();
      o.redraw();
    });
  }

  return {
    contains,
    paint,
    // pointer down inside the strip; returns true when handled
    pointerdown(e, x, y) {
      if (!contains(x, y)) return false;
      sync();
      if (e.button === 2) {
        const i = pointAt(x, y);
        if (i > 0) { group.points.splice(i, 1); apply(); hover = null; o.changed(); }
        return true;
      }
      if (e.button !== 0) return true;
      const i = pointAt(x, y);
      if (i >= 0) { dragPoint(e, i, x, y); return true; }
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
      sync();
      dragPoint(e, 0, x, y);
      return true;
    },
    dblclick(x, y) {
      if (!contains(x, y)) return false;
      if (!sync() || pointAt(x, y) >= 0) return true;
      const t = clean(snapRound(o.timeAt(y), step()));
      if (t <= group.start + 1e-9 || t > group.end + 1e-9) return true;
      const pts = group.points;
      let i = 0;
      while (i < pts.length && pts[i].t <= t) i++;
      if (pts[i - 1]?.t === t) pts[i - 1].v = vx(x);
      else pts.splice(i, 0, { t, v: vx(x), r: NEW_POINT_ROUND });
      apply();
      o.changed();
      return true;
    },
    // wheel on a curve point rounds it; returns true when handled
    wheel(e, x, y) {
      if (!contains(x, y)) return false;
      sync();
      const i = pointAt(x, y);
      if (i <= 0) return false;
      const p = group.points[i];
      p.r = clamp(Math.round((p.r + (e.deltaY < 0 ? ROUND_STEP : -ROUND_STEP)) * 100) / 100, 0, 1);
      apply();
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
      const i = pointAt(x, y);
      const n = i < 0 ? noteAt(x, y) : null;
      hover = i >= 0 ? { kind: 'point', i } : n ? { kind: 'note', note: n } : null;
      o.redraw();
      if (i >= 0) {
        const p = group.points[i];
        return { cursor: i ? 'move' : 'ew-resize', title: `Velocity ${Math.round(p.v * 127)} (${Math.round(p.v * 100)} %)${p.r ? `  rounding ${Math.round(p.r * 100)} %` : ''}` };
      }
      if (n) return { cursor: 'pointer', title: `Velocity ${Math.round(n.vel * 127)} — drag to change` };
      return { cursor: group ? 'crosshair' : 'default', title: group ? 'Double-click to add a velocity point' : 'Select notes to edit their velocity' };
    },
    leave() { if (hover) { hover = null; o.redraw(); } },
  };
}
