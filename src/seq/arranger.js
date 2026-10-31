// TimeLine arranger: time runs left -> right (quarter notes), clips sit on numbered lanes (one clip
// high, the numbers are in the column under "TimeLine:"). Time zero is the bright vertical line;
// scroll left to park clips before it (they are not played by the song, / still auditions them,
// together with the clips around them).
//   double-click empty space   insert a clip (one bar)
//   double right-click empty   insert an automation clip (one bar, drives one controller; the second
//                              press closes the menu the first one opened)
//   click a clip               select it (the piano roll shows it); when stopped the playhead jumps to its start
//                              (the border of selected clips pulses white / grey at 50 BPM)
//   drag on empty space        select clips with a rectangle (Ctrl/Cmd + drag adds to the selection)
//   Ctrl/Cmd + click a clip    add it to / remove it from the selection
//   drag a clip                move it, or the whole selection (time snaps, vertical snaps to lanes)
//   clips snap out of overlaps to the nearest free position; resizing stops at neighbours
//   drag a clip's left/right edge  trim the start / set the length (snaps)
//   click M / S left of a lane number  mute / solo the lane (toggle); drag over a column of buttons to set many
//                              lanes alike. While any lane is soloed only soloed lanes play; mute wins over solo.
//   (while dragging, holding the pointer near an edge of the time area auto-scrolls the view)
//   Alt + drag                 duplicate (standalone copies with the same name)
//   Shift + drag               linked clone: shares the notes with the source (see song.js); clones
//                              are hatched, a selected clone shows a dashed arrow to its source
//   right-click                menu: cut / copy / paste / delete / duplicate / clone / detach / go to source /
//                              consolidate (selected clips on one lane -> one clip) / split at the playhead
//   Backspace / Delete         delete the selected clips
//   Ctrl/Cmd + X / C / V       cut / copy / paste clips at the snapped pointer position
//   Ctrl/Cmd + D / Shift + D   linked clone / duplicate the selection right after itself
//   Ctrl/Cmd + A, Escape       select all / clear the selection
//   click the ruler            set the play position (the signature row too: click / drag scrubs)
//   drag on the ruler          select a loop region (snapped); song playback loops inside it
//   drag the overview map      scroll sideways over the time axis
//   wheel / Shift + wheel      scroll sideways over the time axis / scroll the lanes
//   middle-drag, Ctrl/Cmd + wheel  pan / zoom the time axis
//   right-click the region     remove it (the ruler, a short click)
//   double-click the ruler     insert a time signature change at the nearest bar line (or edit it)
//   right-click a signature    remove that change (the first one can only be edited)
// Trimming the start of a linked clone trims all its clones (they share the notes).
import {
  snapStep, snapFloor, snapRound, loopEnd, getClip, addClip, addAutoClip, isAuto, autoPolyline, duplicateClip, removeClip, trimClipStart, BAR, clean,
  meter, barLines, barRound, barLength, removeSig, cloneClip, detachClip, linkedClips, isLinked, isClone, linkSource, setLoop,
  canConsolidate, consolidateClips, splitClip, laneMuted, laneSoloed, laneSilent, clipSilent, setLaneFlag,
} from '../song.js';
import { createSurface, capture, startPan, onWheel, clamp, snapBands, rightHold, edgeScroll, MUTE_COLOR } from './surface.js';
import { CLIP_H, findClipPosition, clipResizeBounds } from './clipplacement.js';
import { showMenu, shortcut } from './menu.js';

const SIG_H = 16; // time signature row on top of the ruler
const MAP_Y = 38;
const MAP_H = 12;
const RULER = MAP_Y + MAP_H; // signature row, bar numbers and the timeline overview map
const LABEL = 'TimeLine:';
const EDGE = 6;
const PLAYHEAD = '#ff5a36';
const LOOP = '74, 144, 226'; // loop region (rgb)
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// lane buttons in the lane number column: mute (M) and solo (S)
const LANE_BTN_W = 18;
const LANE_BTN_H = 18;
const LANE_BTNS = [
  { key: 'mutes', label: 'M', x: 4, on: MUTE_COLOR, edge: '#f0c24a', is: laneMuted },
  { key: 'solos', label: 'S', x: 24, on: '#3fa7e0', edge: '#7cc6ef', is: laneSoloed },
];

const BLINK_MS = 60000 / 50 / 2; // selection border pulses at 50 BPM: white half a beat, a darker grey the other half

const DOUBLE_MS = 400; // double right-click detection
const DOUBLE_PX = 6;

// ctx: { song(), color(clip), targetLabel(clip), select(id, { scroll }), changed(), defaultTarget(), defaultAutoTarget(), transport,
//        editSig(at) (asks for the signature starting at `at`), menu?(opts) (context menu, default showMenu) }
export function createArranger(host, ctx) {
  const view = { sx: 0, sy: 0, ppq: 16 };
  let x0 = 70; // x of time zero, measured from the label
  let hoverId = null;
  let sigBoxes = []; // painted signature labels: { at, x0, x1 }
  let pointer = null;
  let clipboard = null; // snapshots of the copied clips
  let dragging = false;
  let mapDrag = null;
  let lastRight = null; // { time, x, y } of the last right-button press on empty space
  let sel = new Set(); // selected clip ids; song.selected (the clip in the piano roll) is one of them
  let rect = null; // selection rectangle in progress: { x0, y0, x1, y1, ids }
  const menu = (opts) => (ctx.menu ?? showMenu)(opts);
  let blinkTimer = null;
  let blinkDue = 0;
  // the border of selected clips pulses white / grey; repaint at each switch while any is shown
  function blinkOn() {
    const now = performance.now();
    if (!blinkTimer || now > blinkDue + 4 * BLINK_MS) { // (a lost timer is replaced)
      blinkDue = (Math.floor(now / BLINK_MS) + 1) * BLINK_MS;
      blinkTimer = setTimeout(() => { blinkTimer = null; s.redraw(); }, blinkDue - now + 1);
      blinkTimer?.unref?.(); // never keeps a headless (node) process alive
    }
    return Math.floor(now / BLINK_MS) % 2 === 0;
  }

  const s = createSurface(host, paint);
  const { cv } = s;
  cv.title = 'Wheel or drag the overview map to scroll sideways; Shift + wheel scrolls lanes';
  const xOf = (t) => x0 + t * view.ppq - view.sx;
  const yOf = (y) => RULER + y - view.sy;
  const timeAt = (x) => (x - x0 + view.sx) / view.ppq;
  const step = () => snapStep(ctx.song().snap);
  const laneAt = (y) => Math.max(0, Math.floor((y - RULER + view.sy) / CLIP_H)) * CLIP_H; // lane y under local y

  function place(clip, position) {
    Object.assign(clip, findClipPosition(ctx.song().clips, clip, position, view.ppq));
  }

  // Place several clips at targets[i] = { start, y }, each at the nearest free position. Clips are
  // placed in time order against the other clips and the members placed so far, so a group moved
  // into free space keeps its formation.
  function placeAll(members, targets) {
    if (members.length === 1) { place(members[0], targets[0]); return; }
    const moving = new Set(members);
    const placed = new Set();
    const order = members.map((_, i) => i).sort((i, j) => targets[i].start - targets[j].start || targets[i].y - targets[j].y);
    for (const i of order) {
      const others = ctx.song().clips.filter((c) => !moving.has(c) || placed.has(c));
      Object.assign(members[i], findClipPosition(others, members[i], targets[i], view.ppq));
      placed.add(members[i]);
    }
  }

  // Move clips from their original positions by dt quarters / dy px; the anchor's start snaps and
  // the others follow by the same amount.
  function moveGroup(members, origs, anchor, dt, dy) {
    const a = origs[anchor];
    const delta = snapRound(a.start + dt, step()) - a.start;
    const dyy = Math.max(Math.round(dy / CLIP_H) * CLIP_H, -Math.min(...origs.map((o) => o.y)));
    placeAll(members, origs.map((o) => ({ start: clean(o.start + delta), y: o.y + dyy })));
  }

  // ---- selection ----
  function syncSel() {
    if (rect) return;
    const song = ctx.song();
    const ids = new Set(song.clips.map((c) => c.id));
    if (song.selected === null || !ids.has(song.selected)) sel = new Set();
    else if (!sel.has(song.selected)) sel = new Set([song.selected]);
    else sel = new Set([...sel].filter((id) => ids.has(id)));
  }
  const selectedClips = () => { syncSel(); return ctx.song().clips.filter((c) => sel.has(c.id)); };
  // primary: the clip the piano roll shows (default: keep the current one, else the first)
  function setSelection(clips, primary = null) {
    const song = ctx.song();
    sel = new Set(clips.map((c) => c.id));
    const p = primary ?? clips.find((c) => c.id === song.selected) ?? [...clips].sort((a, b) => a.start - b.start || a.y - b.y)[0] ?? null;
    if ((p?.id ?? null) !== song.selected) ctx.select(p?.id ?? null, { scroll: false });
    park(p);
    s.redraw();
  }
  // selecting a clip while stopped moves the playhead to its start (playback is not disturbed)
  function park(clip) {
    if (clip && !ctx.transport.playing) ctx.transport.seek(clip.start);
  }

  // keep a clip in view
  function reveal(id) {
    const c = getClip(ctx.song(), id);
    if (!c) return;
    const x = xOf(c.start);
    if (x < x0 || x > s.w - 20) view.sx = c.start >= 0 ? Math.max(0, c.start * view.ppq - 20) : c.start * view.ppq - 20;
    const y = yOf(c.y);
    if (y < RULER || y + CLIP_H > s.h) view.sy = Math.max(0, c.y - CLIP_H);
    s.redraw();
  }

  function setLength(clip, length) {
    const { end } = clipResizeBounds(ctx.song().clips, clip);
    clip.length = Math.min(length, clean(end - clip.start));
    place(clip);
  }

  function limitScroll() {
    const song = ctx.song();
    const { first, end } = timeBounds();
    // the end may scroll to the middle of the view, so there is always room to scroll sideways
    view.sx = clamp(view.sx, first * view.ppq, Math.max(first * view.ppq, end * view.ppq - (s.w - x0) / 2));
    const bottom = song.clips.reduce((m, c) => Math.max(m, c.y + CLIP_H), 0);
    view.sy = clamp(view.sy, 0, Math.max(0, bottom + 2 * CLIP_H - (s.h - RULER)));
  }

  function timeBounds() {
    const song = ctx.song();
    return {
      first: Math.min(0, ...song.clips.map((c) => c.start)) - 4 * BAR,
      end: Math.max(loopEnd(song), BAR, song.sigs.at(-1).at, song.loop?.end ?? 0) + 4 * BAR,
    };
  }

  function mapGeometry() {
    const { first, end } = timeBounds();
    const width = Math.max(0, s.w - x0);
    const duration = Math.max(1, end - first);
    const left = x0 + ((timeAt(x0) - first) / duration) * width;
    const visible = Math.min(width, ((s.w - x0) / view.ppq / duration) * width);
    return { first, end, width, duration, left, visible };
  }

  function scrollFromMap(x, offset) {
    const { first, width, duration } = mapGeometry();
    if (width <= 0) return;
    const left = first + clamp((x - x0 - offset) / width, 0, 1) * duration;
    view.sx = left * view.ppq;
    limitScroll();
    s.redraw();
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
    const t0 = timeAt(x0);
    const t1 = timeAt(w);
    // lanes: thin lines between them
    const lane0 = Math.max(0, Math.floor(view.sy / CLIP_H));
    const lane1 = Math.ceil((view.sy + h - RULER) / CLIP_H);
    g.strokeStyle = '#17171a';
    g.lineWidth = 1;
    g.beginPath();
    for (let l = lane0; l <= lane1 + 1; l++) { const y = Math.round(yOf(l * CLIP_H)) + 0.5; g.moveTo(x0, y); g.lineTo(w, y); }
    g.stroke();
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
    // before time zero: parking space, never played by the song
    const zx = xOf(0);
    if (zx > x0) {
      g.fillStyle = 'rgba(0, 0, 0, 0.45)';
      g.fillRect(x0, RULER, zx - x0, h - RULER);
      if (zx - x0 > 130) {
        g.fillStyle = '#4a4a52';
        g.font = `500 10px ${FONT}`;
        g.textBaseline = 'bottom';
        g.textAlign = 'right';
        g.fillText('before start · not played', zx - 8, h - 6);
        g.textAlign = 'left';
      }
    }

    // Playback loops over the whole song, the loop region or just the auditioned clip.
    const tr = ctx.transport;
    const looping = tr.loopClip ? (tr.clipSong === song ? tr.loopClip() : null) : getClip(song, tr.clipId); // looped clip of this layer
    const region = song.loop;
    if (region && !looping) {
      const xa = Math.round(xOf(region.start));
      g.fillStyle = `rgba(${LOOP}, 0.06)`;
      g.fillRect(xa, RULER, Math.round(xOf(region.end)) - xa, h - RULER);
    }
    const bounds = looping ? [looping.start, looping.start + looping.length] : region ? [region.start, region.end] : [loopEnd(song)];
    for (const t of bounds) if (t !== 0 || (region && !looping)) {
      const x = Math.round(xOf(t)) + 0.5;
      g.setLineDash([4, 4]);
      g.strokeStyle = region && !looping ? `rgba(${LOOP}, 0.7)` : '#4a4a52';
      g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, h); g.stroke();
      g.setLineDash([]);
    }

    // clips
    syncSel();
    const shown = rect ? rect.ids : sel;
    const lit = shown.size ? blinkOn() : true;
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
      const selected = shown.has(clip.id);
      const primary = !rect && clip.id === song.selected;
      g.globalAlpha = (selected ? 0.95 : clip.id === hoverId ? 0.8 : 0.68) * (clipSilent(song, clip) ? 0.4 : 1);
      g.fillStyle = color;
      roundRect(g, x + 0.5, y + 0.5, Math.max(2, cw - 1), CLIP_H - 1, 4);
      g.fill();
      g.globalAlpha = 1;
      const linked = isLinked(song, clip);
      const clone = linked && isClone(song, clip);
      if (clone) hatch(g, x, y, cw, w);
      g.strokeStyle = selected ? (primary ? (lit ? '#f2f2f4' : '#a9a9b0') : (lit ? 'rgba(242, 242, 244, 0.7)' : 'rgba(169, 169, 176, 0.7)')) : 'rgba(0, 0, 0, 0.6)';
      g.lineWidth = primary ? 2 : selected ? 1.5 : 1;
      roundRect(g, x + 0.5, y + 0.5, Math.max(2, cw - 1), CLIP_H - 1, 4);
      if (clone) g.setLineDash([5, 3]);
      g.stroke();
      if (clone) g.setLineDash([]);
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
      g.fillText(`${linked && !clone ? '⧉ ' : ''}${isAuto(clip) ? '∿ ' : ''}${clip.name}  ${ctx.targetLabel(clip)}`, x + 6, y + 3);
      g.restore();
    }
    // selected clones point to their source
    for (const clip of song.clips) {
      if (!shown.has(clip.id) || !isClone(song, clip)) continue;
      const src = linkSource(song, clip);
      if (src) cloneArrow(g, clip, src);
    }
    if (rect?.shown) {
      const rx = Math.min(rect.x0, rect.x1);
      const ry = Math.min(rect.y0, rect.y1);
      g.fillStyle = 'rgba(255, 255, 255, 0.06)';
      g.fillRect(rx, ry, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0));
      g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      g.lineWidth = 1;
      g.strokeRect(rx + 0.5, ry + 0.5, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0));
    }
    g.restore();

    // playhead
    const { playing, pos } = ctx.transport;
    if ((playing || pos > 0) && ctx.transport.plays?.(song) !== false) { // not while another level plays
      const x = Math.round(xOf(pos)) + 0.5;
      g.strokeStyle = PLAYHEAD;
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      g.fillStyle = PLAYHEAD;
      g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.fill();
    }
    g.restore();

    // lane numbers in the column under the label
    g.fillStyle = '#0e0e10';
    g.fillRect(0, RULER, x0, h - RULER);
    const busy = new Set(song.clips.filter((c) => shown.has(c.id)).map((c) => Math.round(c.y / CLIP_H)));
    g.font = `500 10px ui-monospace, monospace`;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let l = lane0; l <= lane1; l++) {
      const y = yOf(l * CLIP_H);
      g.fillStyle = laneSilent(song, l) ? '#6e6e76' : busy.has(l) ? '#e8e8ea' : '#5c5c63';
      g.fillText(String(l + 1), x0 - 8, y + CLIP_H / 2);
      // mute / solo toggles
      const by = Math.round(y + (CLIP_H - LANE_BTN_H) / 2);
      g.textAlign = 'center';
      g.font = `700 10px ${FONT}`;
      g.lineWidth = 1;
      for (const b of LANE_BTNS) {
        const on = b.is(song, l);
        roundRect(g, b.x + 0.5, by + 0.5, LANE_BTN_W - 1, LANE_BTN_H - 1, 3);
        g.fillStyle = on ? b.on : '#18181b';
        g.fill();
        g.strokeStyle = on ? b.edge : '#2c2c31';
        g.stroke();
        g.fillStyle = on ? '#121212' : '#6a6a72';
        g.fillText(b.label, b.x + LANE_BTN_W / 2, by + LANE_BTN_H / 2 + 0.5);
      }
      g.font = `500 10px ui-monospace, monospace`;
      g.textAlign = 'right';
    }
    g.textAlign = 'left';
    g.strokeStyle = '#17171a';
    g.lineWidth = 1;
    g.beginPath();
    for (let l = lane0; l <= lane1 + 1; l++) { const y = Math.round(yOf(l * CLIP_H)) + 0.5; g.moveTo(0, y); g.lineTo(x0, y); }
    g.moveTo(x0 - 0.5, RULER); g.lineTo(x0 - 0.5, h);
    g.stroke();

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
    if (region) { // loop region: a band in the bar number row
      const xa = Math.round(xOf(region.start));
      const xb = Math.round(xOf(region.end));
      g.fillStyle = `rgba(${LOOP}, ${looping ? 0.15 : 0.35})`;
      g.fillRect(xa, SIG_H, xb - xa, RULER - SIG_H);
      g.fillStyle = `rgba(${LOOP}, ${looping ? 0.4 : 0.95})`;
      g.fillRect(xa, SIG_H, 2, RULER - SIG_H);
      g.fillRect(xb - 2, SIG_H, 2, RULER - SIG_H);
    }
    g.lineWidth = 2;
    let labelEnd = -Infinity;
    for (const b of bars) {
      const x = Math.round(xOf(b.t)) + 0.5;
      g.strokeStyle = '#3a3a40';
      g.beginPath(); g.moveTo(x, RULER - 7); g.lineTo(x, RULER); g.stroke();
      if (x < labelEnd) continue; // zoomed out: skip labels that would overlap
      const label = String(b.bar + 1);
      g.fillStyle = b.t < 0 ? '#5c5c63' : '#9a9aa0';
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
    g.fillText('Time Sig.', 10, SIG_H / 2 + 0.5);
    const map = mapGeometry();
    g.fillStyle = '#111114';
    g.fillRect(x0, MAP_Y, w - x0, MAP_H);
    const lanes = Math.max(1, ...song.clips.map((c) => Math.round(c.y / CLIP_H) + 1));
    for (const clip of song.clips) {
      const left = x0 + ((clip.start - map.first) / map.duration) * map.width;
      const right = x0 + ((clip.start + clip.length - map.first) / map.duration) * map.width;
      const laneY = MAP_Y + 2 + (Math.round(clip.y / CLIP_H) / lanes) * (MAP_H - 4);
      g.fillStyle = ctx.color(clip);
      g.fillRect(left, laneY, Math.max(1, right - left), Math.max(1, (MAP_H - 4) / lanes));
    }
    g.fillStyle = 'rgba(255, 255, 255, 0.12)';
    g.fillRect(map.left, MAP_Y, map.visible, MAP_H);
    g.strokeStyle = '#e8e8ea';
    g.lineWidth = 1;
    g.strokeRect(Math.round(map.left) + 0.5, MAP_Y + 0.5, Math.max(1, map.visible - 1), MAP_H - 1);
    g.strokeStyle = '#26262a';
    g.beginPath();
    g.moveTo(x0, MAP_Y + MAP_H - 0.5);
    g.lineTo(w, MAP_Y + MAP_H - 0.5);
    g.stroke();
    g.strokeStyle = '#26262a';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, RULER - 0.5); g.lineTo(w, RULER - 0.5); g.stroke();
    // time zero (directly after the colon unless scrolled)
    if (zx >= x0 - 0.5 && zx <= w) {
      const x = Math.max(x0, zx) + 0.75;
      g.strokeStyle = '#e8e8ea';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x, h); g.stroke();
    }
  }

  // diagonal stripes inside a linked clone (the source stays plain)
  function hatch(g, x, y, cw, w) {
    g.save();
    roundRect(g, x + 0.5, y + 0.5, Math.max(2, cw - 1), CLIP_H - 1, 4);
    g.clip();
    g.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    g.lineWidth = 4;
    g.beginPath();
    const from = Math.max(-CLIP_H, Math.floor((x0 - x - CLIP_H) / 10) * 10);
    const to = Math.min(cw, w - x);
    for (let k = from; k < to; k += 10) { g.moveTo(x + k, y + CLIP_H); g.lineTo(x + k + CLIP_H, y); }
    g.stroke();
    g.restore();
  }

  // dashed curved arrow from a clone to its source
  function cloneArrow(g, from, to) {
    const mid = (c) => xOf(c.start) + (c.length * view.ppq) / 2;
    let fx = mid(from), fy = yOf(from.y), tx = mid(to), ty = yOf(to.y);
    const bulge = Math.min(80, 18 + Math.abs(tx - fx) * 0.15);
    let cy = Math.min(fy, ty) - bulge;
    if (cy < RULER + 6) { // no room above: run below the clips
      fy += CLIP_H; ty += CLIP_H;
      cy = Math.max(fy, ty) + bulge;
    }
    const cx = (fx + tx) / 2;
    g.save();
    g.strokeStyle = 'rgba(242, 242, 244, 0.9)';
    g.fillStyle = 'rgba(242, 242, 244, 0.9)';
    g.lineWidth = 1.5;
    g.setLineDash([6, 4]);
    g.beginPath();
    g.moveTo(fx, fy);
    g.quadraticCurveTo(cx, cy, tx, ty);
    g.stroke();
    g.setLineDash([]);
    g.beginPath(); g.arc(fx, fy, 2.5, 0, Math.PI * 2); g.fill();
    const a = Math.atan2(ty - cy, tx - cx);
    g.beginPath();
    g.moveTo(tx, ty);
    g.lineTo(tx - 9 * Math.cos(a - 0.4), ty - 9 * Math.sin(a - 0.4));
    g.lineTo(tx - 9 * Math.cos(a + 0.4), ty - 9 * Math.sin(a + 0.4));
    g.closePath();
    g.fill();
    g.restore();
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
    const start = snapFloor(timeAt(x), step());
    const opts = {
      start,
      y: laneAt(y),
      length: barLength(song, start),
    };
    const clip = auto ? addAutoClip(song, { ...opts, target: ctx.defaultAutoTarget() }) : addClip(song, { ...opts, target: ctx.defaultTarget() });
    place(clip);
    ctx.select(clip.id);
    park(clip);
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

  // the lane button column (M or S) under local (x, y): { btn, lane }, or null
  function laneBtnAt(x, y) {
    if (y < RULER || x >= x0) return null;
    const [m, so] = LANE_BTNS;
    const btn = x < so.x - 1 ? m : x <= so.x + LANE_BTN_W + 1 ? so : null;
    return btn && { btn, lane: laneAt(y) / CLIP_H };
  }

  // Click a lane's M / S to toggle it; dragging over more buttons of that column gives them the
  // same state, so many lanes are muted / soloed in one gesture.
  function laneBtnDrag(e, { btn, lane }) {
    e.preventDefault();
    const song = ctx.song();
    const on = !btn.is(song, lane);
    const set = (l) => setLaneFlag(song, btn.key, l, on);
    let last = lane;
    let changed = set(lane);
    s.redraw();
    ctx.live?.();
    dragging = true;
    capture(cv, e, (ev) => {
      const p = s.local(ev);
      const l = laneAt(clamp(p.y, RULER, s.h - 1)) / CLIP_H;
      // fill the lanes skipped by a fast move
      for (let i = Math.min(l, last); i <= Math.max(l, last); i++) changed = set(i) || changed;
      last = l;
      s.redraw();
      ctx.live?.();
    }, () => {
      dragging = false;
      if (changed) ctx.changed();
    });
  }

  function hoverAt(x, y) {
    const h = hit(x, y);
    const id = h?.clip.id ?? null;
    cv.style.cursor = laneBtnAt(x, y) ? 'pointer' : !h ? (y < RULER && x >= x0 ? (sigAt(x, y) ? 'pointer' : 'text') : 'default') : h.part === 'body' ? 'grab' : 'ew-resize';
    if (id !== hoverId) { hoverId = id; s.redraw(); }
  }

  // the loop region under local x (ruler), or null
  function loopAt(x) {
    const r = ctx.song().loop;
    return r && x >= xOf(r.start) && x <= xOf(r.end) ? r : null;
  }

  cv.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    cv.focus();
    pointer = s.local(e);
    if (e.button === 0 && pointer.y >= MAP_Y && pointer.y < RULER && pointer.x >= x0) {
      e.preventDefault();
      const map = mapGeometry();
      const inside = pointer.x >= map.left && pointer.x <= map.left + map.visible;
      mapDrag = { offset: inside ? pointer.x - map.left : map.visible / 2 };
      dragging = true;
      scrollFromMap(pointer.x, mapDrag.offset);
      capture(cv, e, (ev) => scrollFromMap(s.local(ev).x, mapDrag.offset), () => {
        mapDrag = null;
        dragging = false;
      });
      return;
    }
    if (e.button === 1) {
      dragging = true;
      startPan(s, e, (dx, dy) => { view.sx -= dx; view.sy -= dy; s.redraw(); }, () => { dragging = false; });
      return;
    }
    const { x, y } = s.local(e);
    const song = ctx.song();
    if (e.button === 2) {
      e.preventDefault();
      const box = sigAt(x, y);
      if (y < RULER || x < x0) {
        lastRight = null;
        // right-click a time signature: remove it; right-click the loop region: remove that
        if (box) rightHold(cv, e, { onShort: () => { if (removeSig(ctx.song(), box.at)) { ctx.changed(); s.redraw(); } } });
        else if (x >= x0 && loopAt(x)) rightHold(cv, e, { onShort: () => { ctx.song().loop = null; ctx.changed(); s.redraw(); } });
        return;
      }
      // double right-click on empty space: insert an automation clip
      if (!hit(x, y)) {
        const now = e.timeStamp;
        if (lastRight && now - lastRight.time < DOUBLE_MS && Math.hypot(x - lastRight.x, y - lastRight.y) < DOUBLE_PX) {
          lastRight = null;
          insert(x, y, true);
          return;
        }
        lastRight = { time: now, x, y };
      } else lastRight = null;
      // a normal right-click opens the menu (a quick second one closes it again, see above)
      openMenu(x, y, e.clientX, e.clientY);
      return;
    }
    lastRight = null;
    if (e.button !== 0) return;
    const btn = laneBtnAt(x, y);
    if (btn) { laneBtnDrag(e, btn); return; }
    const st = step();
    if (y < SIG_H) { // signature row: set / scrub the play position (double-click inserts / edits a signature)
      if (x < x0) return;
      const seek = (ev) => { ctx.transport.seek(Math.max(0, snapRound(timeAt(s.local(ev).x), st))); s.redraw(); };
      seek(e);
      dragging = true;
      capture(cv, e, seek, () => { dragging = false; });
      return;
    }
    if (y < RULER) { // ruler: a click sets the play position, a drag selects the loop region
      if (x < x0) return;
      const at = (ev) => Math.max(0, snapRound(timeAt(s.local(ev).x), st));
      const a = at(e);
      ctx.transport.seek(a);
      s.redraw();
      const before = song.loop;
      let region = false;
      dragging = true;
      capture(cv, e, (ev) => {
        if (!region && Math.abs(s.local(ev).x - x) < 3) return;
        region = true;
        if (!setLoop(song, a, at(ev))) song.loop = before; // zero width: keep the old region for now
        s.redraw();
      }, (ev) => {
        dragging = false;
        if (!region) return;
        if (ev.type === 'pointercancel') song.loop = before;
        else if (song.loop !== before) {
          if (!ctx.transport.playing) ctx.transport.seek(song.loop.start);
          ctx.changed();
        }
        s.redraw();
      });
      return;
    }
    if (x < x0) return;
    const additive = e.ctrlKey || e.metaKey;
    const h = hit(x, y);
    if (!h) { selectRect(e, x, y, additive); return; }
    e.preventDefault();
    const source = h.clip;
    if (additive && !e.altKey && !e.shiftKey) { // Ctrl/Cmd + click: toggle the clip in the selection
      const clips = selectedClips();
      if (sel.has(source.id)) setSelection(clips.filter((c) => c !== source));
      else setSelection([...clips, source], source);
      return;
    }
    const copying = e.altKey ? 'dup' : e.shiftKey ? 'clone' : null;
    const part = copying ? 'body' : h.part;
    const inSelection = sel.has(source.id) && selectedClips().length > 1;
    const group = part === 'body' && inSelection ? selectedClips() : [source];
    let members = group;
    let anchor = group.indexOf(source);
    const origs = group.map((c) => ({ start: c.start, y: c.y }));
    if (copying) {
      members = group.map((c) => (copying === 'dup' ? duplicateClip(song, c) : cloneClip(song, c)));
      moveGroup(members, origs, anchor, 0, 0); // copies start clear of their sources
    }
    const clip = members[anchor];
    if (copying || !inSelection) setSelection(members, clip);
    else if (song.selected !== clip.id) ctx.select(clip.id, { scroll: false });
    const orig = structuredClone(clip);
    // trimming a linked clone's start trims every clone of it by the same amount
    const linked = part === 'left' ? linkedClips(song, clip).map((c) => ({ c, start: c.start, length: c.length, bounds: clipResizeBounds(song.clips, c) })) : [];
    const tStart = timeAt(x);
    const yStart = y + view.sy;
    let moved = false;
    dragging = true;
    cv.style.cursor = part === 'body' ? 'grabbing' : 'ew-resize';
    let last = null;
    // dragging near an edge of the time area scrolls it, so a clip can travel anywhere in one drag
    const auto = edgeScroll({
      area: () => ({ left: x0, top: RULER, right: s.w, bottom: s.h }),
      vertical: part === 'body',
      scroll: (dx, dy) => { view.sx += dx; view.sy += dy; limitScroll(); },
      onScroll: () => { if (last) apply(last); },
    });
    const apply = (ev) => {
      const p = s.local(ev);
      if (!moved && Math.hypot(p.x - x, p.y - y) < 3) return; // a click is not a move
      const dt = timeAt(p.x) - tStart;
      if (part === 'body') {
        moveGroup(members, origs, anchor, dt, p.y + view.sy - yStart);
      } else if (part === 'right') {
        setLength(clip, Math.max(st, clean(snapRound(orig.start + orig.length + dt, st) - clip.start)));
      } else {
        const lo = Math.max(...linked.map((l) => l.bounds.start - l.start));
        const hi = Math.min(...linked.map((l) => l.length - Math.min(st, l.length)));
        const delta = clamp(snapRound(orig.start + dt, st) - orig.start, lo, hi);
        trimClipStart(clip, clean(orig.start + delta), orig); // shifts the shared notes once
        for (const l of linked) if (l.c !== clip) { l.c.start = clean(l.start + delta); l.c.length = clean(l.length - delta); }
        place(clip);
      }
      moved = true;
      s.redraw();
      ctx.live?.();
    };
    capture(cv, e, (ev) => {
      last = ev;
      apply(ev);
      if (moved) auto.update(s.local(ev));
    }, (ev) => {
      auto.stop();
      dragging = false;
      if (copying && (!moved || ev.type === 'pointercancel')) { // Alt/Shift + click or cancel: no copy
        for (const c of members) removeClip(song, c.id);
        setSelection(group, source);
      } else if (moved) { park(clip); ctx.changed(); }
      else if (inSelection && part === 'body') setSelection([source], source); // click inside a selection: just this clip
      const p = s.local(ev);
      hoverAt(p.x, p.y);
    });
  });

  // Drag on empty space: rectangle selection (additive keeps the current selection). A plain click
  // on empty space clears the selection.
  function selectRect(e, x, y, additive) {
    e.preventDefault();
    const base = additive ? selectedClips().map((c) => c.id) : [];
    rect = { x0: x, y0: y, x1: x, y1: y, ids: new Set(base), shown: false };
    dragging = true;
    capture(cv, e, (ev) => {
      const p = s.local(ev);
      if (!rect.shown && Math.hypot(p.x - x, p.y - y) < 3) return;
      rect.shown = true;
      rect.x1 = clamp(p.x, x0, s.w);
      rect.y1 = clamp(p.y, RULER, s.h);
      const l = Math.min(x, rect.x1);
      const r = Math.max(x, rect.x1);
      const t = Math.min(y, rect.y1);
      const b = Math.max(y, rect.y1);
      const hits = ctx.song().clips.filter((c) => {
        const cx = xOf(c.start);
        const cy = yOf(c.y);
        return cx < r && cx + c.length * view.ppq > l && cy < b && cy + CLIP_H > t;
      });
      rect.ids = new Set([...base, ...hits.map((c) => c.id)]);
      s.redraw();
    }, (ev) => {
      dragging = false;
      const r = rect;
      rect = null;
      if (ev.type === 'pointercancel') { s.redraw(); return; }
      if (!r.shown) { if (!additive) setSelection([]); return; }
      setSelection(ctx.song().clips.filter((c) => r.ids.has(c.id)));
    });
  }

  // ---- commands (keyboard and context menu) ----
  // where pasted / inserted clips go: the snapped time and row at local point p
  const dropAt = (p) => ({ start: snapFloor(timeAt(p.x), step()), y: laneAt(p.y) });
  const inTimeArea = (p) => !!p && p.x >= x0 && p.x <= s.w && p.y >= RULER && p.y <= s.h;

  function copy() {
    const clips = selectedClips();
    if (clips.length) clipboard = clips.map((c) => structuredClone(c));
    return clips.length > 0;
  }
  function remove() {
    const clips = selectedClips();
    if (!clips.length) return;
    for (const c of clips) removeClip(ctx.song(), c.id);
    setSelection([]);
    ctx.changed();
  }
  function paste(p) {
    if (!clipboard || !inTimeArea(p)) return;
    const song = ctx.song();
    const at = dropAt(p);
    const t0 = Math.min(...clipboard.map((c) => c.start));
    const y0 = Math.min(...clipboard.map((c) => c.y));
    const copies = clipboard.map((c) => duplicateClip(song, c));
    placeAll(copies, clipboard.map((c) => ({ start: clean(at.start + c.start - t0), y: at.y + c.y - y0 })));
    setSelection(copies, copies[0]);
    ctx.changed();
  }
  // copies (or linked clones) of the selection, right after it on the same rows
  function repeat(linkedCopies) {
    const clips = selectedClips();
    if (!clips.length) return;
    const song = ctx.song();
    const span = Math.max(...clips.map((c) => c.start + c.length)) - Math.min(...clips.map((c) => c.start));
    const copies = clips.map((c) => (linkedCopies ? cloneClip(song, c) : duplicateClip(song, c)));
    placeAll(copies, clips.map((c) => ({ start: clean(c.start + span), y: c.y })));
    setSelection(copies, copies[clips.findIndex((c) => c.id === song.selected)] ?? copies[0]);
    ctx.changed();
  }
  function detach() {
    let n = 0;
    for (const c of selectedClips()) if (detachClip(ctx.song(), c)) n++;
    if (n) ctx.changed();
  }
  function consolidate() {
    const merged = consolidateClips(ctx.song(), selectedClips());
    if (!merged) return;
    setSelection([merged], merged);
    ctx.changed();
  }
  // splits the selected clips under the playhead; the right parts join the selection
  const splittable = () => selectedClips().filter((c) => ctx.transport.pos > c.start + 1e-9 && ctx.transport.pos < c.start + c.length - 1e-9);
  function split() {
    const clips = splittable();
    if (!clips.length) return;
    const song = ctx.song();
    const rights = clips.map((c) => splitClip(song, c, ctx.transport.pos));
    const primary = rights[clips.findIndex((c) => c.id === song.selected)] ?? rights[0];
    setSelection([...selectedClips(), ...rights], primary); // primary starts at the playhead: it stays put
    ctx.changed();
  }
  const selectAll = () => setSelection(ctx.song().clips);
  function goToSource(clip) {
    const src = linkSource(ctx.song(), clip);
    if (!src) return;
    setSelection([src], src);
    reveal(src.id);
  }

  function openMenu(x, y, cx, cy) {
    const h = hit(x, y);
    if (h && !sel.has(h.clip.id)) setSelection([h.clip], h.clip);
    const clips = h ? selectedClips() : [];
    const p = { x, y };
    const items = h
      ? [
        { label: 'Cut', shortcut: shortcut('X'), action: () => { if (copy()) remove(); } },
        { label: 'Copy', shortcut: shortcut('C'), action: copy },
        { label: 'Paste', shortcut: shortcut('V'), disabled: !clipboard, action: () => paste(p) },
        { label: 'Delete', shortcut: '⌫', action: remove },
        '-',
        { label: 'Duplicate', action: () => repeat(false) },
        { label: 'Clone (linked)', shortcut: shortcut('D'), action: () => repeat(true) },
        { label: 'Detach clone', disabled: !clips.some((c) => isLinked(ctx.song(), c)), action: detach },
        { label: 'Go to source', disabled: !(h && isClone(ctx.song(), h.clip)), action: () => goToSource(h.clip) },
        '-',
        { label: 'Consolidate', disabled: !canConsolidate(ctx.song(), clips), action: consolidate },
        { label: 'Split at playhead', disabled: !splittable().length, action: split },
        '-',
        { label: 'Select all', shortcut: shortcut('A'), action: selectAll },
      ]
      : [
        { label: 'Paste', shortcut: shortcut('V'), disabled: !clipboard, action: () => paste(p) },
        '-',
        { label: 'Insert clip', action: () => insert(x, y, false) },
        { label: 'Insert automation clip', action: () => insert(x, y, true) },
        '-',
        { label: 'Select all', shortcut: shortcut('A'), disabled: !ctx.song().clips.length, action: selectAll },
      ];
    menu({ x: cx, y: cy, items });
  }

  function sigAt(x, y) {
    if (y >= SIG_H || x < x0) return null;
    return sigBoxes.findLast((b) => x >= b.x0 && x <= b.x1) ?? null;
  }

  cv.addEventListener('dblclick', (e) => {
    const { x, y } = s.local(e);
    if (y >= MAP_Y && y < RULER) return;
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
    if (y >= MAP_Y && y < RULER && x >= x0) {
      cv.style.cursor = 'ew-resize';
      return;
    }
    hoverAt(x, y);
  });
  cv.addEventListener('pointerleave', () => { pointer = null; if (hoverId !== null) { hoverId = null; s.redraw(); } });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const deleting = key === 'backspace' || key === 'delete';
    if (!deleting && key !== 'escape' && !(command && ['x', 'c', 'v', 'a', 'd'].includes(key))) return;
    if (key === 'escape' && !dragging && selectedClips().length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragging) return;
    if (key === 'escape') setSelection([]);
    else if (key === 'a') selectAll();
    else if (key === 'v') paste(pointer);
    else if (key === 'd') repeat(!e.shiftKey);
    else if (key === 'c') copy();
    else if (key === 'x') { if (copy()) remove(); }
    else remove();
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
    // the wheel scrolls along the time axis; Shift + wheel scrolls the lanes
    scroll(dx, dy, e) {
      pointer = s.local(e);
      if (e.shiftKey) view.sy += dx + dy;
      else view.sx += dx + dy;
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    place,
    setLength,
    reveal,
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
