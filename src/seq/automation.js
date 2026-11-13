// Vertical automation lane editor (shown instead of the piano roll when an automation clip is
// selected). Time runs down like the piano roll; the controller value runs left (min) -> right (max).
//   double-click empty space     insert a point (time snaps to the snap grid); keep the second
//                                press held to drag the new point right away
//   drag a point                 move it (time snaps, within the clip and its neighbours); near / past
//                                the top or bottom edge the lane scrolls along
//   drag the thick end line      change the clip length (wheel / edge scrolling extends the view)
//   drag a selected point        move the whole selection (times stay within the clip)
//   Shift + drag a point         fine value adjustment
//   Cmd / Ctrl + click a point   add it to / remove it from the selection
//   right drag, Shift + drag     rectangle selection (from empty space)
//   mouse wheel on a point       round the corner (same as the WAVESHAPER curve editor)
//   right click on a point       delete it; hold the right button on a point for the menu
//   right click on empty space   menu: Cut / Copy / Paste / Delete / Duplicate / Select all
//   Cmd / Ctrl + X, C, V, D, A   cut, copy, paste (at the pointer's snapped time), duplicate, select all
//   Backspace / Delete           delete the selected points; Escape clears the selection
//   Space                        toggle song playback from the pointer's snapped time
//   wheel / middle drag          scroll, Ctrl + wheel zooms time
//   drag the bar ruler up/down   zoom time around the grab position
import { FONT, WEIGHT } from '../font.js';
import { snapStep, snapRound, snapFloor, clean, clipSilent, isIdea, BAR, meter, beatLines, gridBeatEnabled, autoPolyline, pointIndex } from '../song.js';
import { createSurface, capture, rulerDrag, startPan, onWheel, clamp, snapBands, mutedMark, edgeScroll, RIGHT_HOLD_MS, RIGHT_HOLD_SLOP, SB, SB_TRACK, scrollThumb, scrollValue, paintThumb } from './surface.js';
import { showMenu, shortcut } from './menu.js';
import { registerShortcutMenu } from '../shortcuts.js';
import { NEW_POINT_ROUND } from '../curve.js';
import { doublePress } from '../doublepress.js';
import { TOP_MARGIN } from './pianoroll.js';
import { clipResizeBounds } from './clipplacement.js';
import { TIME_GRID, beatsShown, spacedBars } from './timegrid.js';

const GUTTER = 36;
const VALUE_H = 24; // value scale strip at the bottom
const PAD = 12; // free space left/right of the value range without a Margin Size preference
const MIN_RANGE = 160; // px the value range keeps when the Margin Size does not fit
const HIT = 8;
const ROUND_STEP = 0.05;
const BG = '#45464e';
const PLAYHEAD = '#ff916e';
const SELECT = '#65b4ff';
const BEAT = TIME_GRID.color;
const BAR_LINE = TIME_GRID.color;
const BOUNDARY = TIME_GRID.color;

// ctx: { song(), clip() (an automation clip or null), color(clip), transport, changed(),
//        autoParam(clip) -> { p, format(v) } | null (the controller the clip drives),
//        automationPreferences: { marginSize } (optional) }
export function createAutomationLane(host, ctx) {
  const view = { sy: -TOP_MARGIN, ppq: 48 }; // top margin like the piano roll
  let selected = new Set(); // point objects; replaced, never mutated (a cancelled rectangle restores it)
  let clipboard = []; // copied points, times relative to the earliest
  let selectionClip = null;
  let hover = null; // point under the pointer
  let endHover = false;
  let pointer = null;
  let drag = null;
  let sbHover = false;
  const presses = doublePress(); // double-click = down-up-DOWN: the new point drags at once
  const menu = (opts) => (ctx.menu ?? showMenu)({ shortcutScope: 'automation', consumeOutsideClick: true, ...opts });

  const s = createSurface(host, paint);
  const { cv } = s;
  const laneRight = () => Math.max(GUTTER, s.w - SB);
  // the Margin Size preference, smaller when the lane is too narrow for it
  const margin = () => clamp((laneRight() - GUTTER - MIN_RANGE) / 2, 0, ctx.automationPreferences?.marginSize ?? PAD);
  const left = () => GUTTER + margin();
  const right = () => Math.max(left() + 1, laneRight() - margin());
  const xOf = (v) => left() + v * (right() - left());
  const valueAt = (x) => clamp((x - left()) / (right() - left()), 0, 1);
  const yOf = (t) => t * view.ppq - view.sy;
  const timeAt = (y) => (y + view.sy) / view.ppq;
  const bottom = () => Math.max(0, s.h - VALUE_H);
  const inLane = (x, y) => x >= GUTTER && x < laneRight() && y >= 0 && y < bottom();
  const onScrollbar = (x, y) => x >= laneRight() && y >= 0 && y < bottom();
  const step = () => snapStep(ctx.song().snap);

  function syncSelection() {
    const clip = ctx.clip();
    if (clip !== selectionClip) {
      drag?.stop?.({ type: 'pointercancel' });
      selectionClip = clip; selected = new Set(); hover = null; endHover = false;
    }
    if ([...selected].some((p) => !clip?.points.includes(p))) selected = new Set([...selected].filter((p) => clip?.points.includes(p)));
  }
  const selectedPoints = () => ctx.clip()?.points.filter((p) => selected.has(p)) ?? [];
  const released = (ev, moved) => ev.type === 'pointerup' || (moved && ev.type === 'lostpointercapture');

  function scrollMax() {
    const clip = ctx.clip();
    const end = clip ? Math.max(clip.length, ...clip.points.map((p) => p.t), drag?.kind === 'clipEnd' ? drag.extent : 0) : BAR;
    return Math.max(0, (end + BAR) * view.ppq - bottom());
  }

  function limitScroll() {
    view.sy = clamp(view.sy, -TOP_MARGIN, scrollMax());
  }

  const scrollbar = () => scrollThumb(0, bottom(), bottom(), -TOP_MARGIN, scrollMax(), view.sy);
  function scrollbarDrag(e, p) {
    e.preventDefault();
    presses.reset();
    const b = scrollbar();
    const inside = p.y >= b.pos && p.y <= b.pos + b.thumb;
    const offset = inside ? p.y - b.pos : b.thumb / 2;
    const scrollTo = (q) => {
      view.sy = scrollValue(b, q.y - offset);
      ctx.viewChanged?.();
      s.redraw();
    };
    drag = { kind: 'scrollbar' };
    hover = null;
    scrollTo(p);
    capture(cv, e, (ev) => scrollTo(s.local(ev)), (ev) => {
      drag = null;
      pointer = s.local(ev);
      updateHover(pointer.x, pointer.y);
    });
  }

  const valueText = (clip, v) => {
    const a = ctx.autoParam(clip);
    return a ? a.format(v) : `${Math.round(v * 100)} %`;
  };

  function paint(g, fullW, h) {
    if (!fullW || !h) return;
    const w = laneRight();
    limitScroll();
    syncSelection();
    const clip = ctx.clip();
    const bot = bottom();
    const L = left();
    const R = right();
    g.fillStyle = BG;
    g.fillRect(0, 0, fullW, h);

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
      g.fillStyle = TIME_GRID.band;
      snapBands(step(), view.ppq, t0, t1, (a, b) => {
        const ya = Math.round(yOf(a));
        g.fillRect(L, ya, R - L, Math.round(yOf(b)) - ya);
      });
      // value guides at 25, 50 and 75 %
      g.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      g.lineWidth = 1;
      g.beginPath();
      const guideTop = Math.min(bot, Math.max(0, yOf(0))); // the top margin stays empty, like the piano roll
      for (const v of [0.25, 0.5, 0.75]) { const x = Math.round(xOf(v)) + 0.5; g.moveTo(x, guideTop); g.lineTo(x, bot); }
      g.stroke();
      const line = (t, color, lw = 1) => {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = color;
        g.lineWidth = lw * TIME_GRID.width;
        g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
      };
      const m = meter(ctx.song());
      const off = clip.start;
      if (beatsShown(m, view.ppq)) {
        g.setLineDash(TIME_GRID.beatDash);
        g.lineDashOffset = 0;
        for (const t of beatLines(null, off + t0, off + t1, m)) {
          const local = t - off;
          if (!gridBeatEnabled(m, t) || Math.abs(local) < 1e-7 || Math.abs(local - clip.length) < 1e-7) continue;
          line(local, BEAT);
        }
        g.setLineDash([]);
      }
      for (const b of spacedBars(m, off, off + t0, off + t1, view.ppq)) {
        if (gridBeatEnabled(m, b.t)) line(b.t - off, BAR_LINE);
      }
      line(0, BOUNDARY);
      line(clip.length, endHover || drag?.kind === 'clipEnd' ? '#607c69' : BOUNDARY, 2);
      // controller range boundaries (0 % and 100 %) from clip start to the bottom of the view
      g.strokeStyle = BOUNDARY;
      g.lineWidth = TIME_GRID.width;
      g.beginPath();
      for (const x of [Math.round(L) + 0.5, Math.round(R) - 0.5]) { g.moveTo(x, guideTop); g.lineTo(x, bot); }
      g.stroke();

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
          const sel = selected.has(p);
          const active = sel || p === hover;
          g.globalAlpha = p.t >= 0 && p.t <= clip.length ? 1 : 0.45;
          g.beginPath();
          g.arc(x, y, active ? 6 : 4.5, 0, Math.PI * 2);
          g.fillStyle = sel ? SELECT : active ? '#fff' : color;
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
        g.font = `${WEIGHT} 12px ${FONT}`;
        g.textAlign = 'center';
        g.fillText('Double-click to insert automation points.', GUTTER + (w - GUTTER) / 2, Math.max(40, yOf(0) + 40));
      }
      if (drag?.kind === 'select' && drag.shown) {
        const x = Math.min(drag.x0, drag.x1);
        const y = Math.min(drag.y0, drag.y1);
        const rw = Math.abs(drag.x1 - drag.x0);
        const rh = Math.abs(drag.y1 - drag.y0);
        g.fillStyle = 'rgba(96, 124, 105, 0.14)';
        g.fillRect(x, y, rw, rh);
        g.strokeStyle = SELECT;
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, rw, rh);
      }
      if (!isIdea(clip) && clipSilent(ctx.song(), clip)) mutedMark(g, GUTTER, 0, w - GUTTER, bot);
      const { playing, pos, clipId } = ctx.transport;
      const t = pos - clip.start;
      if (playing && ctx.transport.plays?.(ctx.song()) !== false && (clipId == null || (ctx.transport.loopClip ? ctx.transport.loopClip() === clip : clipId === clip.id)) && t >= 0 && t <= clip.length) {
        const y = Math.round(yOf(t)) + 0.5;
        g.strokeStyle = PLAYHEAD;
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(GUTTER, y); g.lineTo(w, y); g.stroke();
      }
    } else {
      g.fillStyle = '#c3c7d0';
      g.font = `${WEIGHT} 12px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('No clip selected.', GUTTER + (w - GUTTER) / 2, 40);
    }
    g.restore();

    // value scale: controller minimum (left) .. maximum (right), plus the value being pointed at
    g.fillStyle = '#292b31';
    g.fillRect(0, bot, w, VALUE_H);
    if (clip) {
      g.font = `${WEIGHT} 9px ${FONT}`;
      g.textBaseline = 'middle';
      const ym = bot + VALUE_H / 2;
      g.textAlign = 'left';
      const focus = drag?.point ?? hover ?? (selected.size === 1 ? [...selected][0] : null);
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
      if (beatsShown(m, view.ppq)) {
        for (const t of beatLines(null, t0, t1, m)) { const y = Math.round(yOf(t - off)) + 0.5; g.moveTo(GUTTER - 6, y); g.lineTo(GUTTER, y); }
      }
      g.stroke();
      let lastY = -Infinity;
      for (const b of spacedBars(m, off, t0, t1, view.ppq)) {
        const y = Math.round(yOf(b.t - off)) + 0.5;
        g.strokeStyle = BAR_LINE;
        g.beginPath(); g.moveTo(0, y); g.lineTo(GUTTER, y); g.stroke();
        const change = Math.abs(b.t - b.seg.at) < 1e-9;
        if (y - lastY < (change ? 24 : 13)) continue;
        lastY = y;
        g.fillStyle = '#c3c7d0';
        g.font = `${WEIGHT} 10px ${FONT}`;
        g.fillText(String(b.bar + 1), GUTTER - 4, y + 2);
        if (change) {
          g.fillStyle = '#c4b5f2';
          g.font = `${WEIGHT} 9px ${FONT}`;
          g.fillText(`${b.seg.num}/${b.seg.den}`, GUTTER - 4, y + 13);
        }
      }
      g.restore();
    }
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(GUTTER, 0); g.lineTo(GUTTER, h); g.moveTo(0, bot); g.lineTo(w, bot); g.stroke();
    g.fillStyle = SB_TRACK;
    g.fillRect(w, 0, fullW - w, h);
    g.strokeStyle = '#1e1e21';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(w + 0.5, 0); g.lineTo(w + 0.5, bot); g.stroke();
    paintThumb(g, scrollbar(), true, w, drag?.kind === 'scrollbar' ? 2 : sbHover ? 1 : 0);
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
    endHover = !hover && !!clip && inLane(x, y) && Math.abs(y - yOf(clip.length)) <= 6;
    sbHover = onScrollbar(x, y);
    cv.style.cursor = hover ? 'move' : clip && inLane(x, y) ? 'crosshair' : 'default';
    cv.title = hover
      ? `${valueText(clip, hover.v)}  at ${+hover.t.toFixed(4)} quarters${hover.r ? `  rounding ${Math.round(hover.r * 100)} %` : ''}`
      : '';
    if (sbHover) cv.title = 'Drag to scroll the clip, or click the track to jump there';
    if (endHover) {
      cv.style.cursor = 'row-resize';
      cv.title = `Clip end at ${+clip.length.toFixed(4)} quarters — drag to lengthen or shorten the clip`;
    }
    if (x >= 0 && x < GUTTER && y >= 0 && y < bottom()) {
      cv.style.cursor = 'ns-resize';
      cv.title = 'Drag up / down to zoom time around this position';
    }
    s.redraw();
  }

  function resizeClip(e, clip) {
    const orig = clip.length;
    const max = clean(clipResizeBounds(ctx.song().clips, clip).end - clip.start);
    const state = drag = { kind: 'clipEnd', extent: orig };
    let moved = false;
    const apply = () => {
      if (drag !== state || !pointer) return;
      const st = step();
      const length = clamp(clean(snapRound(timeAt(clamp(pointer.y, 0, bottom())), st)), Math.max(st, 1 / view.ppq), max);
      if (length !== clip.length) { clip.length = length; moved = true; ctx.live?.(); }
      state.extent = Math.max(state.extent, length);
      s.redraw();
    };
    const auto = edgeScroll({
      area: () => ({ left: -Infinity, right: Infinity, top: 0, bottom: bottom() }),
      scroll: (_dx, dy) => { view.sy += dy; limitScroll(); ctx.viewChanged?.(); },
      onScroll: apply,
    });
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
      if (ev.type !== 'pointerup' && !(moved && ev.type === 'lostpointercapture')) clip.length = orig;
      drag = null;
      if (clip.length !== orig) ctx.changed();
      else if (moved) ctx.live?.();
      if (pointer) updateHover(pointer.x, pointer.y);
      s.redraw();
    });
    state.stop = stop;
    cv.addEventListener('blur', stop);
    window.addEventListener('blur', stop);
  }

  function remove(p) {
    const clip = ctx.clip();
    const i = clip?.points.indexOf(p) ?? -1;
    if (i < 0) return;
    clip.points.splice(i, 1);
    if (selected.has(p)) selected = new Set([...selected].filter((q) => q !== p));
    if (hover === p) hover = null;
    ctx.changed();
  }

  // Rectangle selection (like the piano roll's); a stationary press clicks or, optionally, opens a
  // menu after a hold. The start corner is kept as a time, so the rectangle stays anchored in the
  // clip while the view scrolls (wheel or dragging near / past the top or bottom edge).
  function selectRect(e, x, y, onClick, onHold = null) {
    const clip = ctx.clip();
    const before = selected;
    const state = drag = { kind: 'select', t0: timeAt(y), x0: x, y0: y, x1: x, y1: y, shown: false, stop: null, refresh: null };
    let timer = null;
    let held = false;
    hover = null;
    const hold = () => {
      if (drag !== state || ctx.clip() !== clip || state.shown || held) return;
      held = true;
      clearTimeout(timer);
      onHold();
    };
    const apply = () => {
      if (held || !pointer || drag !== state) return;
      state.shown = true;
      clearTimeout(timer);
      state.y0 = yOf(state.t0);
      state.x1 = clamp(pointer.x, GUTTER, laneRight());
      state.y1 = clamp(pointer.y, 0, bottom());
      const lo = Math.min(state.x0, state.x1) - 4;
      const hi = Math.max(state.x0, state.x1) + 4;
      const top = Math.min(state.y0, state.y1) - 4;
      const bot = Math.max(state.y0, state.y1) + 4;
      selected = new Set(clip.points.filter((p) => {
        const px = xOf(p.v);
        const py = yOf(p.t);
        return px >= lo && px <= hi && py >= top && py <= bot;
      }));
      s.redraw();
    };
    const auto = edgeScroll({
      area: () => ({ left: -Infinity, right: Infinity, top: 0, bottom: bottom() }),
      scroll: (_dx, dy) => { view.sy += dy; limitScroll(); ctx.viewChanged?.(); },
      onScroll: apply,
    });
    const update = (ev) => {
      if (held) return;
      pointer = s.local(ev);
      if (!state.shown && Math.hypot(pointer.x - x, pointer.y - y) < (onHold ? RIGHT_HOLD_SLOP : 3)) return;
      apply();
      auto.update(pointer);
    };
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
        if (onHold && !state.shown && ev.timeStamp - e.timeStamp >= RIGHT_HOLD_MS) hold();
      }
      auto.stop();
      clearTimeout(timer);
      cv.removeEventListener('blur', stop);
      window.removeEventListener('blur', stop);
      if (cancelled && !held && ctx.clip() === clip) selected = before;
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

  // drag a point of a multi-point selection: the whole selection moves by the same time / value,
  // within the clip and the value range; the points are re-sorted as they pass other points
  function moveGroup(e, clip, anchor, x, y) {
    const group = selectedPoints();
    const origs = group.map((p) => ({ t: p.t, v: p.v }));
    const order = clip.points.slice();
    const a = origs[group.indexOf(anchor)];
    const tMin = Math.min(...origs.map((o) => o.t));
    const tMax = Math.max(...origs.map((o) => o.t));
    const vMin = Math.min(...origs.map((o) => o.v));
    const vMax = Math.max(...origs.map((o) => o.v));
    const st = step();
    const tStart = timeAt(y);
    const state = drag = { kind: 'move', point: anchor, moved: false, stop: null, refresh: null };
    let shift = e.shiftKey;
    const apply = () => {
      if (drag !== state || !pointer) return;
      const q = pointer;
      const dv = clamp(((q.x - x) * (shift ? 0.1 : 1)) / (right() - left()), -vMin, 1 - vMax);
      const dt = clamp(snapRound(a.t + timeAt(clamp(q.y, 0, bottom())) - tStart, st) - a.t,
        Math.min(0, -tMin), Math.max(0, clip.length - tMax));
      group.forEach((p, i) => { p.t = clean(origs[i].t + dt); p.v = clamp(origs[i].v + dv, 0, 1); });
      clip.points.splice(0, clip.points.length, ...order.slice().sort((p, r) => p.t - r.t));
      s.redraw();
    };
    const auto = edgeScroll({
      area: () => ({ left: -Infinity, right: Infinity, top: 0, bottom: bottom() }),
      scroll: (_dx, dy) => { view.sy += dy; limitScroll(); ctx.viewChanged?.(); },
      onScroll: apply,
    });
    state.stop = capture(cv, e, (ev) => {
      const q = s.local(ev);
      pointer = q;
      shift = ev.shiftKey;
      if (!state.moved && Math.hypot(q.x - x, q.y - y) < 3) return;
      state.moved = true;
      presses.reset();
      apply();
      auto.update(q);
      state.refresh = () => { apply(); auto.update(pointer); };
    }, (ev) => {
      auto.stop();
      const cancelled = !released(ev, state.moved);
      if (cancelled) {
        group.forEach((p, i) => { p.t = origs[i].t; p.v = origs[i].v; });
        clip.points.splice(0, clip.points.length, ...order);
      }
      drag = null;
      if (state.moved && !cancelled) ctx.changed();
      else if (!state.moved && !cancelled) selected = new Set([anchor]); // a click picks the point alone
      const q = s.local(ev);
      updateHover(q.x, q.y);
    });
  }

  cv.addEventListener('pointerdown', (e) => {
    if (drag) return;
    cv.focus();
    pointer = s.local(e);
    syncSelection();
    if (pointer.x >= laneRight()) {
      if (e.button === 0 && onScrollbar(pointer.x, pointer.y)) scrollbarDrag(e, pointer);
      return;
    }
    if (e.button === 1) {
      drag = { kind: 'pan' };
      startPan(s, e, (dx, dy) => { view.sy -= dy; limitScroll(); ctx.viewChanged?.(); s.redraw(); }, () => { drag = null; });
      return;
    }
    const clip = ctx.clip();
    const { x, y } = pointer;
    if (e.button === 0 && x >= 0 && x < GUTTER && y >= 0 && y < bottom()) {
      e.preventDefault();
      presses.reset();
      const { sy, ppq } = view;
      const anchorTime = timeAt(y);
      drag = { kind: 'ruler' };
      drag.stop = rulerDrag(cv, e, (_dx, dy) => {
        view.ppq = clamp(ppq * Math.pow(1.15, -dy / 48), 6, 600);
        view.sy = anchorTime * view.ppq - y;
        limitScroll();
        s.redraw();
      }, (ev) => {
        if (ev.type === 'pointercancel') { view.sy = sy; view.ppq = ppq; }
        drag = null;
        s.redraw();
        if (ev.type !== 'pointercancel' && (view.sy !== sy || view.ppq !== ppq)) ctx.viewChanged?.();
      });
      return;
    }
    if (!clip || !inLane(x, y)) return;
    const p = hit(x, y);
    if (e.button === 2) {
      e.preventDefault();
      presses.reset();
      // short click: delete the point / menu on empty space; hold on a point: menu; drag: rectangle
      selectRect(e, x, y, () => {
        if (!p) openMenu(x, y, e.clientX, e.clientY);
        else if (clip.points.includes(p)) remove(p);
      }, p ? () => openMenu(x, y, e.clientX, e.clientY) : null);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if (p && (e.ctrlKey || e.metaKey) && !e.altKey) {
      presses.reset();
      selected = new Set(selected);
      if (selected.has(p)) selected.delete(p); else selected.add(p);
      s.redraw();
      return;
    }
    if (!p && e.shiftKey) { presses.reset(); selectRect(e, x, y, () => s.redraw()); return; }
    if (!p && Math.abs(y - yOf(clip.length)) <= 6) { presses.reset(); resizeClip(e, clip); return; }
    if (p && selected.has(p) && selected.size > 1) { moveGroup(e, clip, p, x, y); return; }
    let p2 = p;
    if (presses.press(e) && !p2) { // down-up-DOWN on empty space: insert a point and drag it at once
      p2 = { t: clamp(snapRound(timeAt(y), step()), 0, clip.length), v: valueAt(x), r: NEW_POINT_ROUND };
      clip.points.splice(pointIndex(clip.points, p2.t), 0, p2);
      ctx.changed();
    }
    selected = new Set(p2 ? [p2] : []);
    s.redraw();
    if (!p2) return;
    const inserted = p2 !== p;
    const point = p2;
    const i = clip.points.indexOf(point);
    const lo = i > 0 ? clip.points[i - 1].t : -Infinity;
    const hi = i < clip.points.length - 1 ? clip.points[i + 1].t : Infinity;
    const st = step();
    const tStart = timeAt(y);
    const state = drag = { kind: 'move', point, t0: point.t, v0: point.v, y0: y, x0: x, moved: false };
    let shift = e.shiftKey;
    const apply = () => {
      if (drag !== state || !pointer) return;
      const q = pointer;
      const fine = shift ? 0.1 : 1;
      point.v = clamp(drag.v0 + ((q.x - x) * fine) / (right() - left()), 0, 1);
      point.t = clamp(snapRound(drag.t0 + timeAt(clamp(q.y, 0, bottom())) - tStart, st),
        clamp(lo, 0, clip.length), clamp(hi, 0, clip.length));
      s.redraw();
    };
    // near / past the top or bottom edge the lane scrolls along, so a point can travel the whole clip
    const auto = edgeScroll({
      area: () => ({ left: -Infinity, right: Infinity, top: 0, bottom: bottom() }),
      scroll: (_dx, dy) => { view.sy += dy; limitScroll(); ctx.viewChanged?.(); },
      onScroll: apply,
    });
    capture(cv, e, (ev) => {
      const q = s.local(ev);
      pointer = q;
      shift = ev.shiftKey;
      if (!drag.moved && Math.hypot(q.x - x, q.y - y) < 3) return;
      drag.moved = true;
      presses.reset();
      apply();
      auto.update(q);
      state.refresh = () => { apply(); auto.update(pointer); };
    }, (ev) => {
      auto.stop();
      if (ev.type === 'pointercancel' && !inserted) { point.t = drag.t0; point.v = drag.v0; }
      const moved = drag.moved;
      drag = null;
      if (moved) ctx.changed();
      const q = s.local(ev);
      updateHover(q.x, q.y);
    });
  });

  cv.addEventListener('pointermove', (e) => {
    pointer = s.local(e);
    if (drag || e.buttons) return;
    updateHover(pointer.x, pointer.y);
  });
  cv.addEventListener('pointerleave', () => { pointer = null; if (!drag) { hover = null; endHover = false; sbHover = false; s.redraw(); } });

  // ---- commands (keyboard and context menu), as in the piano roll ----
  function copy() {
    const points = selectedPoints();
    if (!points.length) return false;
    const start = points[0].t;
    clipboard = points.map((p) => ({ ...p, t: clean(p.t - start) }));
    return true;
  }
  function deleteSelected() {
    const clip = ctx.clip();
    if (!clip || !selected.size) return;
    clip.points.splice(0, clip.points.length, ...clip.points.filter((p) => !selected.has(p)));
    selected = new Set();
    hover = null;
    ctx.changed();
  }
  const insert = (clip, copies) => {
    clip.points.push(...copies);
    clip.points.sort((p, q) => p.t - q.t); // stable: copies follow existing points at the same time
    selected = new Set(copies);
    hover = null;
    ctx.changed();
  };
  // paste with the earliest point at the snapped time at local point p
  function paste(p) {
    const clip = ctx.clip();
    if (!clip || !clipboard.length || !p || !inLane(p.x, p.y)) return;
    const start = Math.max(0, snapFloor(timeAt(p.y), step()));
    insert(clip, clipboard.map((q) => ({ ...q, t: clean(start + q.t) })));
  }
  // copies of the selection one grid step after it (its span rounded up to the grid)
  function duplicate() {
    const clip = ctx.clip();
    const points = selectedPoints();
    if (!clip || !points.length) return;
    const st = step();
    const span = points.at(-1).t - points[0].t;
    const offset = (st ? Math.ceil(span / st - 1e-9) * st : span) + (st || 1 / 4);
    insert(clip, points.map((p) => ({ ...p, t: clean(p.t + offset) })));
  }
  function selectAll() {
    selected = new Set(ctx.clip()?.points ?? []);
    s.redraw();
  }
  function openMenu(x, y, cx, cy) {
    syncSelection();
    const p = hit(x, y);
    if (p && !selected.has(p)) selected = new Set([p]);
    s.redraw();
    menu({ x: cx, y: cy, items: laneMenuItems({ x, y }) });
  }
  function laneMenuItems(p) {
    syncSelection();
    const has = selected.size > 0;
    return [
      { label: 'Cut', shortcut: shortcut('X'), disabled: !has, action: () => { if (copy()) deleteSelected(); } },
      { label: 'Copy', shortcut: shortcut('C'), disabled: !has, action: copy },
      { label: 'Paste', shortcut: shortcut('V'), disabled: !clipboard.length, action: () => paste(p) },
      { label: 'Delete', shortcut: '⌫', shortcuts: ['Backspace', 'Delete'], disabled: !has, action: deleteSelected },
      '-',
      { label: 'Duplicate', shortcut: shortcut('D'), disabled: !has, action: duplicate },
      '-',
      { label: 'Select all', shortcut: shortcut('A'), disabled: !ctx.clip()?.points.length, action: selectAll },
    ];
  }
  registerShortcutMenu('automation', () => laneMenuItems(pointer), { active: () => document.activeElement === cv && !drag && cv.isConnected });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const deleting = key === 'backspace' || key === 'delete';
    if (!deleting && !(command && ['a', 'x', 'c', 'v', 'd'].includes(key)) && key !== 'escape') return;
    if (key === 'escape' && !drag) {
      syncSelection();
      if (!selected.size) return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (drag) {
      if (key === 'escape') drag.stop?.({ type: 'pointercancel' });
      return;
    }
    syncSelection();
    if (!ctx.clip()) return;
    if (key === 'escape') selected = new Set();
    else if (key === 'a') selectAll();
    else if (key === 'v') paste(pointer);
    else if (key === 'd') duplicate();
    else if (key === 'c') copy();
    else if (key === 'x') { if (copy()) deleteSelected(); }
    else deleteSelected();
    s.redraw();
  });

  // wheel on a point rounds its corner; elsewhere it scrolls (Ctrl zooms)
  cv.addEventListener('wheel', (e) => {
    pointer = s.local(e);
    const { x, y } = pointer;
    const p = hit(x, y);
    if (drag || !p || e.ctrlKey || e.metaKey) return;
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
      limitScroll();
      if (drag?.refresh) drag.refresh(); // a dragged point follows the view
      ctx.viewChanged?.();
      s.redraw();
    },
    scroll(dx, dy) {
      view.sy += dy;
      limitScroll();
      if (drag?.refresh) drag.refresh();
      ctx.viewChanged?.();
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    getPointerTime() {
      const clip = ctx.clip();
      if (!clip || !pointer || !inLane(pointer.x, pointer.y)) return null;
      return clean(clip.start + Math.max(0, snapFloor(timeAt(pointer.y), step())));
    },
    reveal() { view.sy = -TOP_MARGIN; s.redraw(); },
    getView: () => ({ sy: view.sy, ppq: view.ppq }),
    setView(v) {
      if (!v) return;
      for (const k of ['sy', 'ppq']) if (Number.isFinite(v[k])) view[k] = v[k];
      view.ppq = clamp(view.ppq, 6, 600);
      s.redraw();
    },
  };
}
