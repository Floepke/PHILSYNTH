// TimeLine arranger: time runs left -> right (quarter notes), clips can be placed anywhere
// vertically. "TimeLine:" is written in the ruler; time zero is the vertical line right after it.
//   double-click empty space   insert a clip (one bar)
//   double right-click empty   insert an automation clip (one bar, drives one controller)
//   click a clip               select it (the piano roll shows it)
//   drag a clip                move it (time snaps, vertical is free)
//   clips snap out of overlaps to the nearest free position; resizing stops at neighbours
//   drag a clip's left/right edge  trim the start / set the length (snaps)
//   Alt + drag                 duplicate
//   Backspace / Delete         delete the selected clip
//   Ctrl/Cmd + X / C / V       cut / copy / paste a clip at the snapped pointer position
//   click / drag the ruler     set the play position
//   double-click the ruler     insert a time signature change at the nearest bar line (or edit it)
//   right-click a signature    remove that change (the first one can only be edited)
import {
  snapStep, snapFloor, snapRound, loopEnd, getClip, addClip, addAutoClip, isAuto, autoPolyline, duplicateClip, removeClip, trimClipStart, BAR, clean,
  meter, barLines, barRound, barLength, removeSig,
} from '../song.js';
import { createSurface, capture, startPan, onWheel, clamp, snapBands } from './surface.js';
import { CLIP_H, findClipPosition, clipResizeBounds } from './clipplacement.js';

const SIG_H = 16; // time signature row on top of the ruler
const RULER = 38; // signature row + bar numbers
const LABEL = 'TimeLine:';
const EDGE = 6;
const PLAYHEAD = '#ff5a36';
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

const DOUBLE_MS = 400; // double right-click detection
const DOUBLE_PX = 6;

// ctx: { song(), color(clip), targetLabel(clip), select(id), changed(), defaultTarget(), defaultAutoTarget(), transport,
//        editSig(at) (asks for the signature starting at `at`) }
export function createArranger(host, ctx) {
  const view = { sx: 0, sy: 0, ppq: 16 };
  let x0 = 70; // x of time zero, measured from the label
  let hoverId = null;
  let sigBoxes = []; // painted signature labels: { at, x0, x1 }
  let pointer = null;
  let clipboard = null;
  let dragging = false;
  let lastRight = null; // { time, x, y } of the last right-button press on empty space

  const s = createSurface(host, paint);
  const { cv } = s;
  const xOf = (t) => x0 + t * view.ppq - view.sx;
  const yOf = (y) => RULER + y - view.sy;
  const timeAt = (x) => (x - x0 + view.sx) / view.ppq;
  const step = () => snapStep(ctx.song().snap);

  function place(clip, position) {
    Object.assign(clip, findClipPosition(ctx.song().clips, clip, position, view.ppq));
  }

  function setLength(clip, length) {
    const { end } = clipResizeBounds(ctx.song().clips, clip);
    clip.length = Math.min(length, clean(end - clip.start));
    place(clip);
  }

  function limitScroll() {
    const song = ctx.song();
    const end = Math.max(loopEnd(song), BAR, song.sigs.at(-1).at) + 4 * BAR;
    view.sx = clamp(view.sx, 0, Math.max(0, end * view.ppq - (s.w - x0)));
    const bottom = song.clips.reduce((m, c) => Math.max(m, c.y + CLIP_H), 0);
    view.sy = clamp(view.sy, 0, Math.max(0, bottom + 2 * CLIP_H - (s.h - RULER)));
  }

  function paint(g, w, h) {
    if (!w || !h) return;
    g.font = `600 11px ${FONT}`;
    x0 = Math.round(10 + g.measureText(LABEL).width + 4);
    limitScroll();
    const song = ctx.song();
    g.fillStyle = '#0b0b0c';
    g.fillRect(0, 0, w, h);

    // time area (right of the zero line)
    g.save();
    g.beginPath();
    g.rect(x0, 0, w - x0, h);
    g.clip();
    const t0 = Math.max(0, timeAt(x0));
    const t1 = timeAt(w);
    g.fillStyle = 'rgba(255, 255, 255, 0.022)';
    snapBands(step(), view.ppq, t0, t1, (a, b) => {
      const xa = Math.round(xOf(a));
      g.fillRect(xa, RULER, Math.round(xOf(b)) - xa, h);
    });
    const m = meter(song);
    const bars = barLines(null, t0, t1, m);
    g.strokeStyle = '#2a2a2f';
    g.lineWidth = 2;
    g.beginPath();
    let lastX = -Infinity;
    for (const b of bars) {
      const x = Math.round(xOf(b.t)) + 0.5;
      if (x - lastX < 3) continue;
      lastX = x;
      g.moveTo(x, RULER); g.lineTo(x, h);
    }
    g.stroke();
    // time signature changes: a brighter line from the ruler down
    g.strokeStyle = '#4b3a78';
    g.beginPath();
    for (const seg of m) if (seg.at > 0 && seg.at >= t0 && seg.at <= t1) { const x = Math.round(xOf(seg.at)) + 0.5; g.moveTo(x, RULER); g.lineTo(x, h); }
    g.stroke();

    // Playback loops over the whole song or just the auditioned clip.
    const looping = getClip(song, ctx.transport.clipId);
    const bounds = looping ? [looping.start, looping.start + looping.length] : [loopEnd(song)];
    for (const t of bounds) if (t > 0) {
      const x = Math.round(xOf(t)) + 0.5;
      g.setLineDash([4, 4]);
      g.strokeStyle = '#4a4a52';
      g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, h); g.stroke();
      g.setLineDash([]);
    }

    // clips
    g.save();
    g.beginPath();
    g.rect(x0, RULER, w - x0, h - RULER);
    g.clip();
    for (const clip of song.clips) {
      const x = xOf(clip.start);
      const cw = clip.length * view.ppq;
      const y = yOf(clip.y);
      if (x > w || x + cw < x0 || y > h || y + CLIP_H < RULER) continue;
      const color = ctx.color(clip);
      const selected = clip.id === song.selected;
      g.globalAlpha = selected ? 0.95 : clip.id === hoverId ? 0.8 : 0.68;
      g.fillStyle = color;
      roundRect(g, x + 0.5, y + 0.5, Math.max(2, cw - 1), CLIP_H - 1, 4);
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = selected ? '#f2f2f4' : 'rgba(0, 0, 0, 0.6)';
      g.lineWidth = selected ? 2 : 1;
      g.stroke();
      if (isAuto(clip)) miniCurve(g, clip, x, y);
      // mini notes
      const ns = clip.notes.filter((n) => n.start >= 0 && n.start < clip.length);
      if (ns.length) {
        let lo = Math.min(...ns.map((n) => n.pitch));
        let hi = Math.max(...ns.map((n) => n.pitch));
        if (hi - lo < 12) { const m = (lo + hi) / 2; lo = m - 6; hi = m + 6; }
        const top = y + 15;
        const span = CLIP_H - 19;
        g.fillStyle = 'rgba(0, 0, 0, 0.55)';
        for (const n of ns) {
          const nx = x + n.start * view.ppq;
          const nw = Math.max(1.5, Math.min(n.length, clip.length - n.start) * view.ppq - 1);
          g.fillRect(nx, top + span - ((n.pitch - lo) / (hi - lo)) * span - 1, nw, 2);
        }
      }
      // name
      g.save();
      g.beginPath();
      g.rect(x + 2, y, Math.max(0, cw - 4), CLIP_H);
      g.clip();
      g.fillStyle = '#fff';
      g.font = `600 10.5px ${FONT}`;
      g.textBaseline = 'top';
      g.fillText(`${isAuto(clip) ? '∿ ' : ''}${clip.name}  ${ctx.targetLabel(clip)}`, x + 6, y + 3);
      g.restore();
    }
    g.restore();

    // playhead
    const { playing, pos } = ctx.transport;
    if (playing || pos > 0) {
      const x = Math.round(xOf(pos)) + 0.5;
      g.strokeStyle = PLAYHEAD;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillStyle = PLAYHEAD;
      g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.fill();
    }
    g.restore();

    // ruler
    g.fillStyle = 'rgba(21, 21, 23, 0.92)';
    g.fillRect(0, 0, w, RULER);
    g.save();
    g.beginPath();
    g.rect(x0, 0, w - x0, RULER);
    g.clip();
    g.font = `500 10px ui-monospace, monospace`;
    g.textBaseline = 'middle';
    const barY = SIG_H + (RULER - SIG_H) / 2;
    g.lineWidth = 2;
    let labelEnd = -Infinity;
    for (const b of bars) {
      const x = Math.round(xOf(b.t)) + 0.5;
      g.strokeStyle = '#3a3a40';
      g.beginPath(); g.moveTo(x, RULER - 7); g.lineTo(x, RULER); g.stroke();
      if (x < labelEnd) continue; // zoomed out: skip labels that would overlap
      const label = String(b.bar + 1);
      g.fillStyle = '#9a9aa0';
      g.fillText(label, x + 4, barY);
      labelEnd = x + 4 + g.measureText(label).width + 8;
    }
    // signature row
    g.fillStyle = 'rgba(255, 255, 255, 0.025)';
    g.fillRect(x0, 0, w - x0, SIG_H);
    g.font = `600 10px ui-monospace, monospace`;
    sigBoxes = [];
    for (const seg of m) {
      const x = Math.round(xOf(seg.at));
      if (x > w) break;
      const label = `${seg.num}/${seg.den}`;
      const tw = g.measureText(label).width + 8;
      if (x + tw < x0) continue;
      g.fillStyle = '#4b3a78';
      g.fillRect(x, 2, tw, SIG_H - 3);
      g.fillStyle = '#e4dcff';
      g.fillText(label, x + 4, SIG_H / 2 + 0.5);
      sigBoxes.push({ at: seg.at, x0: x, x1: x + tw });
    }
    g.restore();
    g.fillStyle = '#e8e8ea';
    g.font = `600 11px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(LABEL, 10, barY);
    g.fillStyle = '#6e6e76';
    g.font = `500 9.5px ${FONT}`;
    g.fillText('Sig', 10, SIG_H / 2 + 0.5);
    g.strokeStyle = '#26262a';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, RULER - 0.5); g.lineTo(w, RULER - 0.5); g.stroke();
    // time zero, directly after the colon
    if (view.sx <= 0.5) {
      g.strokeStyle = '#e8e8ea';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(x0 + 0.75, 2); g.lineTo(x0 + 0.75, h); g.stroke();
    }
  }

  // automation clip: its curve, minimum at the bottom
  function miniCurve(g, clip, x, y) {
    const poly = autoPolyline(clip);
    if (!poly) return;
    const top = y + 15;
    const span = CLIP_H - 19;
    const px = (t) => x + clamp(t, 0, clip.length) * view.ppq;
    const py = (v) => top + span - v * span;
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(px(0), py(poly[1]));
    for (let i = 0; i < poly.length; i += 2) g.lineTo(px(poly[i]), py(poly[i + 1]));
    g.lineTo(px(clip.length), py(poly[poly.length - 1]));
    g.stroke();
  }

  function insert(x, y, auto) {
    const song = ctx.song();
    const start = Math.max(0, snapFloor(timeAt(x), step()));
    const opts = {
      start,
      y: Math.max(0, Math.round(y - RULER + view.sy - CLIP_H / 2)),
      length: barLength(song, start),
    };
    const clip = auto ? addAutoClip(song, { ...opts, target: ctx.defaultAutoTarget() }) : addClip(song, { ...opts, target: ctx.defaultTarget() });
    place(clip);
    ctx.select(clip.id);
    ctx.changed();
  }

  function hit(x, y) {
    if (y < RULER || x < x0) return null;
    const clips = ctx.song().clips;
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      const cx = xOf(c.start);
      const cw = c.length * view.ppq;
      const cy = yOf(c.y);
      if (x < cx || x > cx + cw || y < cy || y > cy + CLIP_H) continue;
      const edge = Math.min(EDGE, cw / 4);
      return { clip: c, part: x - cx <= edge ? 'left' : cx + cw - x <= edge ? 'right' : 'body' };
    }
    return null;
  }

  function hoverAt(x, y) {
    const h = hit(x, y);
    const id = h?.clip.id ?? null;
    cv.style.cursor = !h ? (y < RULER && x >= x0 ? (y < SIG_H ? (sigAt(x, y) ? 'pointer' : 'copy') : 'text') : 'default') : h.part === 'body' ? 'grab' : 'ew-resize';
    if (id !== hoverId) { hoverId = id; s.redraw(); }
  }

  cv.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    cv.focus();
    pointer = s.local(e);
    if (e.button === 1) {
      dragging = true;
      startPan(s, e, (dx, dy) => { view.sx -= dx; view.sy -= dy; s.redraw(); }, () => { dragging = false; });
      return;
    }
    const { x, y } = s.local(e);
    const song = ctx.song();
    if (e.button === 2) { // right-click a time signature: remove it
      const box = sigAt(x, y);
      if (box && removeSig(song, box.at)) { ctx.changed(); s.redraw(); }
      // double right-click on empty space: insert an automation clip
      if (y >= RULER && x >= x0 && !hit(x, y)) {
        const now = e.timeStamp;
        if (lastRight && now - lastRight.time < DOUBLE_MS && Math.hypot(x - lastRight.x, y - lastRight.y) < DOUBLE_PX) {
          lastRight = null;
          insert(x, y, true);
        } else lastRight = { time: now, x, y };
      } else lastRight = null;
      return;
    }
    lastRight = null;
    if (e.button !== 0) return;
    const st = step();
    if (y < SIG_H) return; // signature row: double-click to insert / edit
    if (y < RULER) { // ruler: set / scrub the play position
      if (x < x0) return;
      const seek = (ev) => { ctx.transport.seek(Math.max(0, snapRound(timeAt(s.local(ev).x), st))); s.redraw(); };
      seek(e);
      dragging = true;
      capture(cv, e, seek, () => { dragging = false; });
      return;
    }
    let h = hit(x, y);
    if (!h) return;
    e.preventDefault();
    const source = h.clip;
    const orig = structuredClone(source);
    const tStart = timeAt(x);
    const yStart = y + view.sy;
    let clip = source;
    const dup = e.altKey;
    if (dup) {
      clip = duplicateClip(song, clip);
      place(clip);
      h = { clip, part: 'body' };
    }
    ctx.select(clip.id);
    let moved = false;
    dragging = true;
    cv.style.cursor = h.part === 'body' ? 'grabbing' : 'ew-resize';
    capture(cv, e, (ev) => {
      const p = s.local(ev);
      if (!moved && Math.hypot(p.x - x, p.y - y) < 3) return; // a click is not a move
      const dt = timeAt(p.x) - tStart;
      if (h.part === 'body') {
        place(clip, {
          start: Math.max(0, snapRound(orig.start + dt, st)),
          y: Math.max(0, orig.y + p.y + view.sy - yStart),
        });
      } else if (h.part === 'right') {
        setLength(clip, Math.max(st, clean(snapRound(orig.start + orig.length + dt, st) - clip.start)));
      } else {
        const end = orig.start + orig.length;
        const bounds = clipResizeBounds(song.clips, clip);
        trimClipStart(clip, clamp(snapRound(orig.start + dt, st), bounds.start, end - Math.min(st, orig.length)), orig);
        place(clip);
      }
      moved = true;
      s.redraw();
      ctx.live?.();
    }, (ev) => {
      dragging = false;
      if (dup && (!moved || ev.type === 'pointercancel')) { // Alt + click/cancel: no copy
        removeClip(song, clip.id);
        ctx.select(source.id);
      } else if (moved) ctx.changed();
      const p = s.local(ev);
      hoverAt(p.x, p.y);
    });
  });

  function sigAt(x, y) {
    if (y >= SIG_H || x < x0) return null;
    return sigBoxes.findLast((b) => x >= b.x0 && x <= b.x1) ?? null;
  }

  cv.addEventListener('dblclick', (e) => {
    const { x, y } = s.local(e);
    if (x < x0) return;
    const song = ctx.song();
    if (y < RULER) { // time signature change at the nearest bar line (or the one double-clicked)
      const box = sigAt(x, y);
      ctx.editSig(box ? box.at : barRound(song, Math.max(0, timeAt(x))));
      return;
    }
    if (hit(x, y)) return;
    insert(x, y, false);
  });

  cv.addEventListener('pointermove', (e) => {
    pointer = s.local(e);
    if (e.buttons) return;
    const { x, y } = s.local(e);
    hoverAt(x, y);
  });
  cv.addEventListener('pointerleave', () => { pointer = null; if (hoverId !== null) { hoverId = null; s.redraw(); } });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const deleting = key === 'backspace' || key === 'delete';
    if (!deleting && !(command && ['x', 'c', 'v'].includes(key))) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragging) return;
    const song = ctx.song();
    if (command && key === 'v') {
      if (!clipboard || !pointer || pointer.x < x0 || pointer.x > s.w || pointer.y < RULER || pointer.y > s.h) return;
      const copy = duplicateClip(song, clipboard);
      copy.name = clipboard.name;
      place(copy, {
        start: Math.max(0, snapFloor(timeAt(pointer.x), step())),
        y: Math.max(0, Math.round(pointer.y - RULER + view.sy - CLIP_H / 2)),
      });
      ctx.select(copy.id);
      ctx.changed();
      return;
    }
    const clip = getClip(song, song.selected);
    if (!clip) return;
    if (command && (key === 'c' || key === 'x')) clipboard = structuredClone(clip);
    if ((deleting || (command && key === 'x')) && removeClip(song, clip.id)) {
      ctx.select(null);
      ctx.changed();
    }
  });

  onWheel(cv, {
    zoom(notches, e) {
      pointer = s.local(e);
      const { x } = s.local(e);
      const t = timeAt(x);
      view.ppq = clamp(view.ppq * Math.pow(1.15, notches), 2, 200);
      view.sx = t * view.ppq - (x - x0);
      s.redraw();
    },
    scroll(dx, dy, e) {
      pointer = s.local(e);
      view.sx += dx;
      view.sy += dy;
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    place,
    setLength,
    // keep the selected clip in view
    reveal(id) {
      const c = getClip(ctx.song(), id);
      if (!c) return;
      const x = xOf(c.start);
      if (x < x0 || x > s.w - 20) view.sx = Math.max(0, c.start * view.ppq - 20);
      const y = yOf(c.y);
      if (y < RULER || y + CLIP_H > s.h) view.sy = Math.max(0, c.y - 10);
      s.redraw();
    },
    getView: () => ({ ...view }),
    setView(v) {
      if (!v) return;
      for (const k of ['sx', 'sy', 'ppq']) if (Number.isFinite(v[k])) view[k] = v[k];
      view.ppq = clamp(view.ppq, 2, 200);
      s.redraw();
    },
  };
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
