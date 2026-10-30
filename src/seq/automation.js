// Vertical automation lane editor (shown instead of the piano roll when an automation clip is
// selected). Time runs down like the piano roll; the controller value runs left (min) -> right (max).
//   double-click empty space     insert a point (time snaps to the snap grid)
//   drag a point                 move it (time snaps and stays between its neighbours)
//   Shift + drag a point         fine value adjustment
//   mouse wheel on a point       round the corner (same as the WAVESHAPER curve editor)
//   right click on a point       delete it
//   Backspace / Delete           delete the selected point
//   wheel / middle drag          scroll, Ctrl + wheel zooms time
import { snapStep, snapRound, BAR, meter, barLines, beatLines, autoPolyline, pointIndex } from '../song.js';
import { createSurface, capture, startPan, onWheel, clamp, snapBands } from './surface.js';

const GUTTER = 36;
const VALUE_H = 24; // value scale strip at the bottom
const PAD = 12; // free space left/right of the value range
const HIT = 8;
const ROUND_STEP = 0.05;
const BG = '#45464e';
const PLAYHEAD = '#ff916e';
const SELECT = '#65b4ff';
const BEAT = '#5d606a';
const BAR_LINE = '#797d88';
const BOUNDARY = '#a1a7b3';

// ctx: { song(), clip() (an automation clip or null), color(clip), transport, changed(),
//        autoParam(clip) -> { p, format(v) } | null (the controller the clip drives) }
export function createAutomationLane(host, ctx) {
  const view = { sy: 0, ppq: 48 };
  let selected = null; // point object
  let selectionClip = null;
  let hover = null; // point under the pointer
  let pointer = null;
  let drag = null;

  const s = createSurface(host, paint);
  const { cv } = s;
  const left = () => GUTTER + PAD;
  const right = () => Math.max(left() + 1, s.w - PAD);
  const xOf = (v) => left() + v * (right() - left());
  const valueAt = (x) => clamp((x - left()) / (right() - left()), 0, 1);
  const yOf = (t) => t * view.ppq - view.sy;
  const timeAt = (y) => (y + view.sy) / view.ppq;
  const bottom = () => Math.max(0, s.h - VALUE_H);
  const inLane = (x, y) => x >= GUTTER && x <= s.w && y >= 0 && y < bottom();
  const step = () => snapStep(ctx.song().snap);
  const minBeat = (m) => Math.min(...m.map((x) => x.beat));

  function syncSelection() {
    const clip = ctx.clip();
    if (clip !== selectionClip) { selectionClip = clip; selected = null; hover = null; }
    if (selected && !clip?.points.includes(selected)) selected = null;
  }

  function limitScroll() {
    const clip = ctx.clip();
    const end = clip ? Math.max(clip.length, ...clip.points.map((p) => p.t)) : BAR;
    view.sy = clamp(view.sy, 0, Math.max(0, (end + BAR) * view.ppq - bottom()));
  }

  const valueText = (clip, v) => {
    const a = ctx.autoParam(clip);
    return a ? a.format(v) : `${Math.round(v * 100)} %`;
  };

  function paint(g, w, h) {
    if (!w || !h) return;
    limitScroll();
    syncSelection();
    const clip = ctx.clip();
    const bot = bottom();
    const L = left();
    const R = right();
    g.fillStyle = BG;
    g.fillRect(0, 0, w, h);

    g.save();
    g.beginPath();
    g.rect(GUTTER, 0, Math.max(0, w - GUTTER), bot);
    g.clip();
    if (clip) {
      const yEnd = yOf(clip.length);
      if (yEnd < bot) {
        g.fillStyle = 'rgba(0, 0, 0, 0.22)';
        g.fillRect(GUTTER, Math.max(0, yEnd), w, bot);
      }
      const t0 = Math.max(0, timeAt(0));
      const t1 = timeAt(bot);
      g.fillStyle = 'rgba(0, 0, 0, 0.06)';
      snapBands(step(), view.ppq, t0, t1, (a, b) => {
        const ya = Math.round(yOf(a));
        g.fillRect(L, ya, R - L, Math.round(yOf(b)) - ya);
      });
      // value guides at 0, 25, 50, 75 and 100 %
      g.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      g.lineWidth = 1;
      g.beginPath();
      for (const v of [0, 0.25, 0.5, 0.75, 1]) { const x = Math.round(xOf(v)) + 0.5; g.moveTo(x, 0); g.lineTo(x, bot); }
      g.stroke();
      const line = (t, color, lw = 1) => {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = color;
        g.lineWidth = lw * 2;
        g.beginPath(); g.moveTo(GUTTER, y); g.lineTo(w, y); g.stroke();
      };
      const m = meter(ctx.song());
      const off = clip.start;
      if (minBeat(m) * view.ppq >= 5) {
        g.setLineDash([3, 3]);
        for (const t of beatLines(null, off + t0, off + t1, m)) line(t - off, BEAT);
        g.setLineDash([]);
      }
      for (const b of barLines(null, off + t0, off + t1, m)) line(b.t - off, BAR_LINE);
      line(0, BOUNDARY, 2);
      line(clip.length, BOUNDARY, 2);

      const color = `color-mix(in srgb, ${ctx.color(clip)} 75%, #fff)`;
      const poly = autoPolyline(clip);
      if (poly) {
        const pts = clip.points;
        const first = pts[0];
        const last = pts[pts.length - 1];
        const tEnd = Math.max(clip.length, last.t);
        // filled area from the minimum to the curve, holding the end values
        g.beginPath();
        g.moveTo(L, yOf(Math.min(0, first.t)));
        g.lineTo(xOf(first.v), yOf(Math.min(0, first.t)));
        for (let i = 0; i < poly.length; i += 2) g.lineTo(xOf(poly[i + 1]), yOf(poly[i]));
        g.lineTo(xOf(last.v), yOf(tEnd));
        g.lineTo(L, yOf(tEnd));
        g.closePath();
        g.globalAlpha = 0.16;
        g.fillStyle = color;
        g.fill();
        g.globalAlpha = 1;
        // held values before the first / after the last point: dashed
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.setLineDash([4, 4]);
        g.beginPath();
        if (first.t > 0) { g.moveTo(xOf(first.v), yOf(0)); g.lineTo(xOf(first.v), yOf(first.t)); }
        if (last.t < tEnd) { g.moveTo(xOf(last.v), yOf(last.t)); g.lineTo(xOf(last.v), yOf(tEnd)); }
        g.stroke();
        g.setLineDash([]);
        g.beginPath();
        for (let i = 0; i < poly.length; i += 2) {
          const x = xOf(poly[i + 1]);
          const y = yOf(poly[i]);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
        for (const p of pts) {
          const x = xOf(p.v);
          const y = yOf(p.t);
          if (y < -20 || y > bot + 20) continue;
          const active = p === selected || p === hover;
          g.globalAlpha = p.t >= 0 && p.t <= clip.length ? 1 : 0.45;
          g.beginPath();
          g.arc(x, y, active ? 6 : 4.5, 0, Math.PI * 2);
          g.fillStyle = p === selected ? SELECT : active ? '#fff' : color;
          g.fill();
          g.lineWidth = 1.5;
          g.strokeStyle = '#111216';
          g.stroke();
          if (p.r) { // rounding ring
            g.beginPath();
            g.arc(x, y, 8 + p.r * 6, -Math.PI / 2, -Math.PI / 2 + p.r * Math.PI * 2);
            g.strokeStyle = SELECT;
            g.lineWidth = 1.5;
            g.stroke();
          }
          g.globalAlpha = 1;
        }
      } else {
        g.fillStyle = '#c3c7d0';
        g.font = '500 12px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText('Double-click to insert automation points.', GUTTER + (w - GUTTER) / 2, Math.max(40, yOf(0) + 40));
      }
      const { playing, pos, clipId } = ctx.transport;
      const t = pos - clip.start;
      if ((playing || pos > 0) && (clipId == null || clipId === clip.id) && t >= 0 && t <= clip.length) {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = PLAYHEAD;
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(GUTTER, y); g.lineTo(w, y); g.stroke();
      }
    } else {
      g.fillStyle = '#c3c7d0';
      g.font = '500 12px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('No clip selected.', GUTTER + (w - GUTTER) / 2, 40);
    }
    g.restore();

    // value scale: controller minimum (left) .. maximum (right), plus the value being pointed at
    g.fillStyle = '#292b31';
    g.fillRect(0, bot, w, VALUE_H);
    if (clip) {
      g.font = '600 9px ui-monospace, monospace';
      g.textBaseline = 'middle';
      const ym = bot + VALUE_H / 2;
      g.textAlign = 'left';
      const focus = drag?.point ?? hover ?? selected;
      const v = focus ? focus.v : pointer && inLane(pointer.x, pointer.y) ? valueAt(pointer.x) : null;
      let cur = null; // [x0, x1] of the current value label
      if (v !== null) {
        const text = valueText(clip, v);
        const tw = g.measureText(text).width;
        const x = clamp(xOf(v) - tw / 2, L, R - tw);
        cur = [x - 8, x + tw + 8];
        g.fillStyle = focus ? '#fff' : '#c3c7d0';
        g.fillText(text, x, ym);
        g.fillStyle = PLAYHEAD;
        g.fillRect(Math.round(xOf(v)) - 1, h - 4, 2, 4);
      }
      // controller minimum / maximum at the ends, unless the current value covers them
      g.fillStyle = '#9a9ea8';
      const lo = valueText(clip, 0);
      const hi = valueText(clip, 1);
      const hw = g.measureText(hi).width;
      if (!cur || cur[0] > L + g.measureText(lo).width) g.fillText(lo, L, ym);
      if (!cur || cur[1] < R - hw) g.fillText(hi, R - hw, ym);
    }

    // bar / beat ruler
    g.fillStyle = '#292b31';
    g.fillRect(0, 0, GUTTER, bot);
    if (clip) {
      g.save();
      g.beginPath();
      g.rect(0, 0, GUTTER, bot);
      g.clip();
      g.textAlign = 'right';
      g.textBaseline = 'top';
      const m = meter(ctx.song());
      const off = clip.start;
      const t0 = off + Math.max(0, timeAt(0));
      const t1 = off + timeAt(bot);
      g.strokeStyle = BEAT;
      g.lineWidth = 2;
      g.beginPath();
      if (minBeat(m) * view.ppq >= 5) {
        for (const t of beatLines(null, t0, t1, m)) { const y = Math.round(yOf(t - off)) + 0.5; g.moveTo(GUTTER - 6, y); g.lineTo(GUTTER, y); }
      }
      g.stroke();
      let lastY = -Infinity;
      for (const b of barLines(null, t0, t1, m)) {
        const y = Math.round(yOf(b.t - off)) + 0.5;
        g.strokeStyle = BAR_LINE;
        g.beginPath(); g.moveTo(0, y); g.lineTo(GUTTER, y); g.stroke();
        const change = Math.abs(b.t - b.seg.at) < 1e-9;
        if (y - lastY < (change ? 24 : 13)) continue;
        lastY = y;
        g.fillStyle = '#c3c7d0';
        g.font = '600 10px ui-monospace, monospace';
        g.fillText(String(b.bar + 1), GUTTER - 4, y + 2);
        if (change) {
          g.fillStyle = '#c4b5f2';
          g.font = '600 9px ui-monospace, monospace';
          g.fillText(`${b.seg.num}/${b.seg.den}`, GUTTER - 4, y + 13);
        }
      }
      g.restore();
    }
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(GUTTER, 0); g.lineTo(GUTTER, h); g.moveTo(0, bot); g.lineTo(w, bot); g.stroke();
  }

  function hit(x, y) {
    const clip = ctx.clip();
    if (!clip || !inLane(x, y)) return null;
    let best = null;
    let bd = HIT;
    for (const p of clip.points) {
      const d = Math.hypot(xOf(p.v) - x, yOf(p.t) - y);
      if (d <= bd) { bd = d; best = p; }
    }
    return best;
  }

  function updateHover(x, y) {
    const clip = ctx.clip();
    hover = hit(x, y);
    cv.style.cursor = hover ? 'move' : clip && inLane(x, y) ? 'crosshair' : 'default';
    cv.title = hover
      ? `${valueText(clip, hover.v)}  at ${+hover.t.toFixed(4)} quarters${hover.r ? `  rounding ${Math.round(hover.r * 100)} %` : ''}`
      : '';
    s.redraw();
  }

  function remove(p) {
    const clip = ctx.clip();
    const i = clip?.points.indexOf(p) ?? -1;
    if (i < 0) return;
    clip.points.splice(i, 1);
    if (selected === p) selected = null;
    if (hover === p) hover = null;
    ctx.changed();
  }

  cv.addEventListener('pointerdown', (e) => {
    if (drag) return;
    cv.focus();
    pointer = s.local(e);
    syncSelection();
    if (e.button === 1) {
      drag = { kind: 'pan' };
      startPan(s, e, (dx, dy) => { view.sy -= dy; s.redraw(); }, () => { drag = null; });
      return;
    }
    const clip = ctx.clip();
    const { x, y } = pointer;
    if (!clip || !inLane(x, y)) return;
    const p = hit(x, y);
    if (e.button === 2) {
      e.preventDefault();
      if (p) remove(p);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    selected = p;
    s.redraw();
    if (!p) return;
    const i = clip.points.indexOf(p);
    const lo = i > 0 ? clip.points[i - 1].t : -Infinity;
    const hi = i < clip.points.length - 1 ? clip.points[i + 1].t : Infinity;
    const st = step();
    drag = { kind: 'move', point: p, t0: p.t, v0: p.v, y0: y, x0: x, moved: false };
    capture(cv, e, (ev) => {
      const q = s.local(ev);
      pointer = q;
      if (!drag.moved && Math.hypot(q.x - x, q.y - y) < 3) return;
      drag.moved = true;
      const fine = ev.shiftKey ? 0.1 : 1;
      p.v = clamp(drag.v0 + ((q.x - x) * fine) / (right() - left()), 0, 1);
      p.t = clamp(snapRound(drag.t0 + (q.y - y) / view.ppq, st), Math.max(lo, drag.t0 < 0 ? -Infinity : 0), hi);
      s.redraw();
    }, (ev) => {
      if (ev.type === 'pointercancel') { p.t = drag.t0; p.v = drag.v0; }
      const moved = drag.moved;
      drag = null;
      if (moved) ctx.changed();
      const q = s.local(ev);
      updateHover(q.x, q.y);
    });
  });

  cv.addEventListener('dblclick', (e) => {
    const clip = ctx.clip();
    const { x, y } = s.local(e);
    if (!clip || !inLane(x, y) || e.button !== 0 || hit(x, y)) return;
    const point = { t: Math.max(0, snapRound(timeAt(y), step())), v: valueAt(x), r: 0 };
    clip.points.splice(pointIndex(clip.points, point.t), 0, point);
    selected = point;
    ctx.changed();
    updateHover(x, y);
  });

  cv.addEventListener('pointermove', (e) => {
    pointer = s.local(e);
    if (drag || e.buttons) return;
    updateHover(pointer.x, pointer.y);
  });
  cv.addEventListener('pointerleave', () => { pointer = null; if (!drag) { hover = null; s.redraw(); } });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (!['backspace', 'delete', 'escape'].includes(key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (drag) return;
    syncSelection();
    if (key === 'escape') selected = null;
    else if (selected) remove(selected);
    s.redraw();
  });

  // wheel on a point rounds its corner; elsewhere it scrolls (Ctrl zooms)
  cv.addEventListener('wheel', (e) => {
    const { x, y } = s.local(e);
    const p = hit(x, y);
    if (!p || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    p.r = clamp(Math.round((p.r + (e.deltaY < 0 ? ROUND_STEP : -ROUND_STEP)) * 100) / 100, 0, 1);
    updateHover(x, y);
    ctx.changed();
  }, { passive: false });
  onWheel(cv, {
    zoom(notches, e) {
      const { y } = s.local(e);
      const t = timeAt(y);
      view.ppq = clamp(view.ppq * Math.pow(1.15, notches), 6, 600);
      view.sy = t * view.ppq - y;
      s.redraw();
    },
    scroll(dx, dy) {
      view.sy += dy;
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    reveal() { view.sy = 0; s.redraw(); },
    getView: () => ({ sy: view.sy, ppq: view.ppq }),
    setView(v) {
      if (!v) return;
      for (const k of ['sy', 'ppq']) if (Number.isFinite(v[k])) view[k] = v[k];
      view.ppq = clamp(view.ppq, 6, 600);
      s.redraw();
    },
  };
}
