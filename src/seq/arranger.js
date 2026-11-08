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
//   Shift + drag on empty space  pan the view (like the patcher; middle-drag pans anywhere)
//   Ctrl/Cmd + click a clip    add it to / remove it from the selection
//   drag a clip                move it, or the whole selection (time snaps, vertical snaps to lanes)
//   clips snap out of overlaps to the nearest free position; resizing stops at neighbours
// Idea storage: the space above the first lane holds clips freely (no time or lane snapping,
// overlaps allowed); they are never played by the song (see song.js). Drag an idea onto a lane to
// play it there (it snaps like any clip); drag a clip above the first lane to store it.
//   drag a clip's left/right edge  trim the start / set the length (snaps)
//   click M / S left of a lane number  mute / solo the lane (toggle); drag over a column of buttons to set many
//                              lanes alike. While any lane is soloed only soloed lanes play; mute wins over solo.
//   (while dragging, holding the pointer near an edge of the time area auto-scrolls the view)
//   Alt + drag                 duplicate (standalone copies with the same name)
//   Shift + drag               linked clone: shares the notes with the source (see song.js); clones
//                              are hatched, a selected clone shows a dashed arrow to its source
//   right-click                menu: cut / copy / paste / delete / duplicate / clone / detach / go to source /
//                              consolidate (selected MIDI clips -> one clip) / split at the playhead
//                              / save clip (.clip file); on empty space: paste / insert / load clip
//   Backspace / Delete         delete the selected clips
//   Ctrl/Cmd + X / C / V       cut / copy / paste clips at the snapped pointer position
//   Ctrl/Cmd + D / Shift + D   linked clone / duplicate the selection right after itself
//   Ctrl/Cmd + A               select all (one clip always stays selected while there are clips)
//   click the ruler            set the play position (the signature row too: click / drag scrubs)
//   wheel / Shift + wheel      scroll sideways over the time axis / scroll the lanes
//   middle-drag, Ctrl/Cmd + wheel  pan / zoom the time axis
//   scrollbars (bottom, right) drag the thumb, or click the track to jump there
// The camera pans freely except upward: the idea-storage label stays above the bottom scrollbar.
//   double-click the signature row  insert a time signature change at the nearest bar line (or edit it)
//   right-click a signature    remove that change (the first one can only be edited)
// Restart point (green 'restart:' marker in the bar number row): song playback continues there at
// the end of the song and stopping it parks the playhead there.
//   double-click the bar numbers   insert the restart point there (snapped; moves an existing one)
//   drag the marker            move it (snapped); dropped at time zero it is removed
//   right-click the marker     remove it; elsewhere on the ruler: menu insert at the playhead / remove
//                              (the clip and empty-space menus have these items too)
// Trimming the start of a linked clone trims all its clones (they share the notes).
import { MOUSE_FORWARD } from '../mousebuttons.js';
import {
  snapStep, snapFloor, snapRound, loopEnd, getClip, addClip, addAutoClip, isAuto, autoPolyline, duplicateClip, removeClip, trimClipStart, BAR, clean,
  meter, barLines, barRound, barLength, removeSig, moveSig, cloneClip, detachClip, linkedClips, isLinked, isClone, linkSource,
  canConsolidate, consolidateClips, splitClip, setRestart, laneMuted, laneSoloed, laneSilent, clipSilent, setLaneFlag, laneY, isIdea, ideaY,
} from '../song.js';
import {
  createSurface, capture, rulerDrag, startPan, onWheel, clamp, snapBands, rightHold, edgeScroll, MUTE_COLOR,
  SB, SB_TRACK, scrollThumb, scrollValue, paintThumb, roundRect,
} from './surface.js';
import { CLIP_H, clipsOverlap, findClipPosition, clipResizeBounds } from './clipplacement.js';
import { showMenu, shortcut } from './menu.js';

const SIG_H = CLIP_H; // time signature row on top of the ruler
const RULER = 2 * CLIP_H; // signature row and bar numbers
const FAR = 1e7; // maximum distance before floating-point precision becomes unusable
const MIN_LANES = 16; // the lanes (and bars) that count as content even when empty
const IDEA_BG = '#121016';
const IDEA_EDGE = '#3a3346';
const IDEA_TEXT = '#5e566e';
const IDEA_LABEL = 'Playback of clips in this area is ignored except if you loop the clip.';
const LABEL = 'TimeLine:';
const EDGE = 6;
const PLAYHEAD = '#ff5a36';
const RESTART = '#5fd38a'; // restart point marker
const RESTART_LABEL = 'restart:';
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
  let restartBox = null; // painted restart marker with its label: { x0, x1 }
  let pointer = null;
  let clipboard = null; // snapshots of the copied clips
  let dragging = false;
  let sbHover = null; // scrollbar under the pointer / being dragged: 'h' | 'v' | null
  let sbActive = null;
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

  let viewportWidth = 0;
  let viewportHeight = 0;
  const s = createSurface(host, paint, {
    onResize(w, h) {
      // Remember the last visible size across hiding/restoring the pane.
      if (w <= 0 || h <= 0) return;
      if (viewportWidth > 0 && viewportHeight > 0) {
        view.sx -= (w - viewportWidth) / 2;
        view.sy -= (h - viewportHeight) / 2;
      }
      viewportWidth = w;
      viewportHeight = h;
    },
  });
  const { cv } = s;
  cv.title = 'Drag empty space to select; Shift + drag, middle-drag or scrollbars pan. Wheel scrolls sideways, Shift + wheel scrolls the lanes';
  const xOf = (t) => x0 + t * view.ppq - view.sx;
  const yOf = (y) => RULER + y - view.sy;
  const timeAt = (x) => (x - x0 + view.sx) / view.ppq;
  const step = () => snapStep(ctx.song().snap);
  const laneAt = (y) => Math.max(0, Math.floor((y - RULER + view.sy) / CLIP_H)) * CLIP_H; // lane y under local y
  const worldY = (y) => y - RULER + view.sy; // < 0: idea storage
  const right = () => s.w - SB; // the time area ends at the scrollbars
  const bottom = () => s.h - SB;

  // ideas (y < 0) go exactly where asked, clips on lanes to the nearest free position
  function place(clip, position) {
    const y = position?.y ?? clip.y;
    if (y < 0) Object.assign(clip, position, { y: ideaY(y) });
    else Object.assign(clip, findClipPosition(ctx.song().clips, clip, position, view.ppq));
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
      if (targets[i].y < 0) { Object.assign(members[i], { start: targets[i].start, y: ideaY(targets[i].y) }); continue; }
      const others = ctx.song().clips.filter((c) => !moving.has(c) || placed.has(c));
      Object.assign(members[i], findClipPosition(others, members[i], targets[i], view.ppq));
      placed.add(members[i]);
    }
  }

  // Move clips from their original positions by dt quarters / dy px. On lanes the anchor's start
  // snaps and the others follow by the same amount (a clip coming from idea storage snaps itself);
  // a clip whose middle ends up above the first lane becomes an idea and moves freely.
  function moveGroup(members, origs, anchor, dt, dy) {
    const a = origs[anchor];
    const st = step();
    const delta = snapRound(a.start + dt, st) - a.start;
    placeAll(members, origs.map((o) => {
      const y = o.y + dy;
      if (y + CLIP_H / 2 < 0) return { start: clean(o.start + dt), y: ideaY(y) };
      return { start: clean(o.y < 0 ? snapRound(o.start + dt, st) : o.start + delta), y: laneY(y) };
    }));
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
    if (x < x0 || x > right() - 20) view.sx = c.start >= 0 ? Math.max(0, c.start * view.ppq - 20) : c.start * view.ppq - 20;
    const y = yOf(c.y);
    if (y < RULER || y + CLIP_H > bottom()) view.sy = c.y < 0 ? c.y - CLIP_H : Math.max(0, c.y - CLIP_H);
    if (s.h > 0) limitScroll();
    s.redraw();
  }

  function setLength(clip, length) {
    const { end } = clipResizeBounds(ctx.song().clips, clip);
    clip.length = Math.min(length, clean(end - clip.start));
    place(clip);
  }

  // Scrollbars span the content and the current view, bounded above by the idea label.
  // -> { x: [min, max] sx, y: [min, max] sy, vw, vh (time area size) }
  function scrollRange() {
    const song = ctx.song();
    const vw = Math.max(1, right() - x0);
    const vh = Math.max(1, bottom() - RULER);
    const first = Math.min(0, ...song.clips.map((c) => c.start)) * view.ppq;
    const last = Math.max(loopEnd(song), MIN_LANES * BAR, song.sigs.at(-1).at, song.restart ?? 0, ...song.clips.map((c) => c.start + c.length)) * view.ppq;
    const low = Math.max(MIN_LANES * CLIP_H, ...song.clips.map((c) => c.y + CLIP_H));
    return {
      x: [Math.min(first - vw, view.sx), Math.max(last, view.sx)],
      y: [minScrollY(), Math.max(low, view.sy)],
      vw, vh,
    };
  }

  // The label's bottom is six pixels above lane zero; keep it above the bottom scrollbar.
  const minScrollY = (height = s.h) => Math.min(0, RULER - (height - SB + 6));
  function limitScroll(height = s.h) {
    view.sx = Number.isFinite(view.sx) ? clamp(view.sx, -FAR, FAR) : 0;
    view.sy = Number.isFinite(view.sy) ? clamp(view.sy, minScrollY(height), FAR) : 0;
  }

  // Any drag in the time area: holding the pointer near / past an edge scrolls the TimeLine along
  // (faster further out); onScroll re-applies the drag at the new view. vertical / horizontal pick the axes.
  const areaScroll = (onScroll, { vertical = true, horizontal = true } = {}) => edgeScroll({
    area: () => ({ left: horizontal ? x0 : -Infinity, top: RULER, right: horizontal ? right() : Infinity, bottom: bottom() }),
    vertical,
    scroll: (dx, dy) => { view.sx += dx; view.sy += dy; limitScroll(); ctx.viewChanged?.(); },
    onScroll,
  });

  // scrollbar geometry: track from a over len px, thumb at pos (thumb px long), view range lo..hi
  function scrollbars() {
    const r = scrollRange();
    const make = (vertical) => {
      const [lo, hi] = vertical ? r.y : r.x;
      const a = vertical ? RULER : x0;
      const len = (vertical ? bottom() : right()) - a;
      return { vertical, ...scrollThumb(a, len, vertical ? r.vh : r.vw, lo, hi, vertical ? view.sy : view.sx) };
    };
    return { h: make(false), v: make(true) };
  }
  // 'h' / 'v': the scrollbar under local (x, y); 'corner' for the dead parts beside them
  function barAt(x, y) {
    const below = y >= bottom();
    const beside = x >= right() && y >= RULER;
    if (below && x >= x0 && x < right()) return 'h';
    if (beside && !below) return 'v';
    return below || beside ? 'corner' : null;
  }
  // drag a thumb (grabbed where pressed), or press the track: the thumb centres there and follows
  function scrollbarDrag(e, which, p) {
    e.preventDefault();
    const b = scrollbars()[which];
    const along = (q) => (b.vertical ? q.y : q.x);
    const inside = along(p) >= b.pos && along(p) <= b.pos + b.thumb;
    const offset = inside ? along(p) - b.pos : b.thumb / 2;
    const scrollTo = (q) => {
      view[b.vertical ? 'sy' : 'sx'] = scrollValue(b, along(q) - offset);
      limitScroll();
      ctx.viewChanged?.();
      s.redraw();
    };
    sbActive = which;
    dragging = true;
    if (!b.vertical) {
      const before = { ...view };
      scrollTo(p);
      const ppq = view.ppq;
      const stop = rulerDrag(cv, e, (dx, dy) => {
        const sx = scrollValue(b, p.x + dx - offset);
        view.ppq = clamp(ppq * Math.pow(1.15, -dy / 48), 2, 200);
        view.sx = (sx + p.x - x0) * view.ppq / ppq - (p.x - x0);
        limitScroll();
        ctx.viewChanged?.();
        s.redraw();
      }, ev => {
        cv.removeEventListener('keydown', cancel);
        if (ev.type === 'pointercancel') { Object.assign(view, before); ctx.viewChanged?.(); }
        sbActive = null;
        dragging = false;
        s.redraw();
      });
      const cancel = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); stop({ type: 'pointercancel' }); }
      };
      cv.addEventListener('keydown', cancel);
      return;
    }
    scrollTo(p);
    capture(cv, e, (ev) => scrollTo(s.local(ev)), () => { sbActive = null; dragging = false; s.redraw(); });
  }
  function paintScrollbars(g, w, h) {
    g.fillStyle = SB_TRACK;
    g.fillRect(0, h - SB, w, SB);
    g.fillRect(w - SB, RULER, SB, h - SB - RULER);
    g.strokeStyle = '#1e1e21';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h - SB + 0.5); g.lineTo(w, h - SB + 0.5);
    g.moveTo(w - SB + 0.5, RULER); g.lineTo(w - SB + 0.5, h - SB);
    g.stroke();
    const bars = scrollbars();
    for (const key of ['h', 'v']) {
      const b = bars[key];
      paintThumb(g, b, b.vertical, b.vertical ? w - SB : h - SB, sbActive === key ? 2 : sbHover === key ? 1 : 0);
    }
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
    // idea storage above the first lane: no lanes, no grid
    const iy = Math.round(yOf(0));
    if (iy > RULER) {
      g.fillStyle = IDEA_BG;
      g.fillRect(x0, RULER, w - x0, iy - RULER);
    }
    const gy = Math.max(RULER, iy);
    if (ctx.timelineDisplay?.showInputGrid !== false) {
      g.fillStyle = 'rgba(255, 255, 255, 0.022)';
      snapBands(step(), view.ppq, t0, t1, (a, b) => {
        const xa = Math.round(xOf(a));
        g.fillRect(xa, gy, Math.round(xOf(b)) - xa, h);
      });
    }
    const m = meter(song);
    const bars = barLines(null, t0, t1, m);
    if (ctx.timelineDisplay?.showVerticalBarlines !== false) {
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
    }
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
        g.fillText('Idea Storage', zx - 8, h - SB - 6);
        g.textAlign = 'left';
      }
    }

    if (iy > RULER && iy < h) {
      g.strokeStyle = IDEA_EDGE;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0, iy - 1); g.lineTo(w, iy - 1); g.stroke();
      if (iy - RULER > 18) {
        g.fillStyle = IDEA_TEXT;
        g.font = `600 10px ${FONT}`;
        g.textBaseline = 'bottom';
        g.fillText(IDEA_LABEL, x0 + 8, iy - 6);
      }
    }

    // Playback loops over the whole song or just the auditioned clip.
    const tr = ctx.transport;
    const looping = tr.loopClip ? (tr.clipSong === song ? tr.loopClip() : null) : getClip(song, tr.clipId); // looped clip of this layer
    const bounds = looping ? [looping.start, looping.start + looping.length] : [loopEnd(song)];
    for (const t of bounds) if (t !== 0) {
      const x = Math.round(xOf(t)) + 0.5;
      g.setLineDash([4, 4]);
      g.strokeStyle = '#4a4a52';
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
      g.globalAlpha = (selected ? 0.95 : clip.id === hoverId ? 0.8 : 0.68) * (isIdea(clip) ? 0.85 : clipSilent(song, clip) ? 0.4 : 1);
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
        const top = y + 2;
        const span = CLIP_H - 6;
        g.fillStyle = 'rgba(0, 0, 0, 0.55)';
        for (const n of ns) {
          const nx = x + n.start * view.ppq;
          const nw = Math.max(1.5, Math.min(n.length, clip.length - n.start) * view.ppq - 1);
          g.fillRect(nx, top + span - ((n.pitch - lo) / (hi - lo)) * span, nw, 2);
        }
      }
      // type icon and name
      g.save();
      g.beginPath();
      g.rect(x + 2, y, Math.max(0, cw - 4), CLIP_H);
      g.clip();
      g.fillStyle = '#fff';
      const icon = isAuto(clip) ? '∿' : '♫';
      const iconHeight = CLIP_H - 4;
      g.font = `600 ${iconHeight}px ${FONT}`;
      g.textBaseline = 'alphabetic';
      const metrics = g.measureText(icon);
      // Fit the visible glyph, not its font's line height (especially for the wave).
      const iconScale = iconHeight / (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
      g.font = `600 ${iconHeight * iconScale}px ${FONT}`;
      g.fillText(icon, x + 4, y + 2 + metrics.actualBoundingBoxAscent * iconScale);
      g.font = `600 10.5px ${FONT}`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      const label = `${linked && !clone ? '⧉ ' : ''}${clip.name}  ${ctx.targetLabel(clip)}`;
      const labelLeft = Math.max(x + 2, x0);
      const labelRight = Math.min(x + cw - 2, right());
      g.beginPath();
      g.rect(labelLeft, y, Math.max(0, labelRight - labelLeft), CLIP_H);
      g.clip();
      const labelStart = Math.max(x + 8 + metrics.width * iconScale, x0 + 4);
      g.fillText(label, labelStart, y + CLIP_H / 2);
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
    if (iy > RULER) { // the gutter beside idea storage
      g.fillStyle = IDEA_BG;
      g.fillRect(0, RULER, x0 - 1, iy - RULER);
      g.fillStyle = IDEA_EDGE;
      g.fillRect(0, iy - 2, x0, 2);
      if (iy - RULER > 18 && iy < h) {
        g.fillStyle = IDEA_TEXT;
        g.font = `600 10px ${FONT}`;
        g.textBaseline = 'bottom';
        g.fillText('Ideas', 10, iy - 6);
      }
    }

    // ruler
    g.fillStyle = 'rgba(21, 21, 23, 0.92)';
    g.fillRect(0, 0, w, RULER);
    g.save();
    g.beginPath();
    g.rect(x0, 0, w - x0, RULER);
    g.clip();
    g.font = `500 20px ui-monospace, monospace`;
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
      g.fillStyle = b.t < 0 ? '#5c5c63' : '#9a9aa0';
      g.fillText(label, x + 4, barY);
      labelEnd = x + 4 + g.measureText(label).width + 8;
    }
    // restart point: 'restart:' and a | in the bar number row (the label goes right when there is no room left)
    restartBox = null;
    if (Number.isFinite(song.restart)) {
      const x = Math.round(xOf(song.restart));
      g.font = `600 20px ui-monospace, monospace`;
      const tw = g.measureText(RESTART_LABEL).width;
      const left = x - tw - 6 >= x0;
      const lx = left ? x - tw - 5 : x + 5;
      if (x + tw + 8 >= x0 && x - tw - 8 <= w) {
        g.fillStyle = 'rgba(21, 21, 23, 0.95)';
        g.fillRect(left ? lx - 3 : x + 2, SIG_H + 1, tw + 6, RULER - SIG_H - 3);
        g.fillStyle = RESTART;
        g.fillRect(x - 1, SIG_H, 3, RULER - SIG_H);
        g.fillText(RESTART_LABEL, lx, barY);
        restartBox = { x0: left ? lx - 3 : x - 3, x1: left ? x + 3 : lx + tw + 3 };
      }
    }
    // signature row
    g.fillStyle = 'rgba(255, 255, 255, 0.025)';
    g.fillRect(x0, 0, w - x0, SIG_H);
    g.font = `600 20px ui-monospace, monospace`;
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
    g.strokeStyle = '#26262a';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, RULER - 0.5); g.lineTo(w, RULER - 0.5); g.stroke();
    if (Number.isFinite(song.restart)) { // the restart point continues faintly through the lanes
      const x = Math.round(xOf(song.restart)) + 0.5;
      if (x >= x0 && x <= w) {
        g.strokeStyle = 'rgba(95, 211, 138, 0.35)';
        g.lineWidth = 1;
        g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, h - SB); g.stroke();
        g.setLineDash([]);
      }
    }
    // time zero (directly after the colon unless scrolled)
    if (zx >= x0 - 0.5 && zx <= w) {
      const x = Math.max(x0, zx) + 0.75;
      g.strokeStyle = '#e8e8ea';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(x, 2); g.lineTo(x, h); g.stroke();
    }
    paintScrollbars(g, w, h);
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
    const { start, y: row } = dropAt({ x, y });
    const opts = {
      start,
      y: row,
      length: barLength(song, start),
    };
    const clip = auto ? addAutoClip(song, { ...opts, target: ctx.defaultAutoTarget() }) : addClip(song, { ...opts, target: ctx.defaultTarget() });
    place(clip);
    ctx.select(clip.id);
    park(clip);
    ctx.changed();
  }

  function hit(x, y) {
    if (y < RULER || x < x0 || barAt(x, y)) return null;
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
    if (y < RULER || x >= x0 || y >= bottom() || worldY(y) < 0) return null;
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
    let p = null;
    const apply = () => {
      if (!p) return;
      const l = laneAt(clamp(p.y, RULER, bottom() - 1)) / CLIP_H;
      // fill the lanes skipped by a fast move (or a scroll)
      for (let i = Math.min(l, last); i <= Math.max(l, last); i++) changed = set(i) || changed;
      last = l;
      s.redraw();
      ctx.live?.();
    };
    const auto = areaScroll(apply, { horizontal: false });
    capture(cv, e, (ev) => {
      p = s.local(ev);
      apply();
      auto.update(p);
    }, () => {
      auto.stop();
      dragging = false;
      if (changed) ctx.changed();
    });
  }

  function hoverAt(x, y) {
    const bar = barAt(x, y);
    const sb = bar === 'h' || bar === 'v' ? bar : null;
    if (sb !== sbHover) { sbHover = sb; s.redraw(); }
    const h = hit(x, y);
    const id = h?.clip.id ?? null;
    cv.style.cursor = bar === 'h' ? 'zoom-in' : bar ? 'default'
      : laneBtnAt(x, y) ? 'pointer'
        : y < RULER && x >= x0 ? (y < SIG_H ? 'text' : 'grab')
          : !h ? 'default' : h.part === 'body' ? 'grab' : 'ew-resize';
    if (id !== hoverId) { hoverId = id; s.redraw(); }
  }

  // whether local x, y is on the restart marker (bar number row)
  const restartAt = (x, y) => !!restartBox && y >= SIG_H && y < RULER && x >= restartBox.x0 && x <= restartBox.x1;
  function insertRestart() {
    setRestart(ctx.song(), ctx.transport.pos);
    ctx.changed();
    s.redraw();
  }
  function removeRestart() {
    if (!Number.isFinite(ctx.song().restart)) return;
    setRestart(ctx.song(), null);
    ctx.changed();
    s.redraw();
  }
  const restartItems = () => [
    { label: 'Insert restart point at playhead', action: insertRestart },
    { label: 'Remove restart point', disabled: !Number.isFinite(ctx.song().restart), action: removeRestart },
  ];
  function signatureItem(x) {
    const at = barRound(ctx.song(), Math.max(0, timeAt(x)));
    return { label: 'Insert/Edit time-Signature Change…', action: () => ctx.editSig(at) };
  }

  // Recalculate from the original positions so moving back restores downstream boundaries.
  function signatureDrag(e, at) {
    const song = ctx.song();
    const before = song.sigs;
    const initial = s.local(e);
    const grab = timeAt(initial.x) - at;
    let p = initial;
    let moved = false;
    const apply = () => {
      song.sigs = before;
      moveSig(song, at, timeAt(clamp(p.x, x0, right())) - grab);
      ctx.live?.();
      s.redraw();
    };
    const auto = areaScroll(apply, { vertical: false });
    const cancel = ev => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      finish({ type: 'pointercancel' });
    };
    dragging = true;
    const finish = capture(cv, e, ev => {
      p = s.local(ev);
      if (!moved && Math.abs(p.x - initial.x) < 3) return;
      moved = true;
      apply();
      auto.update(p);
    }, ev => {
      cv.removeEventListener('keydown', cancel);
      auto.stop();
      dragging = false;
      if (ev.type === 'pointercancel') song.sigs = before;
      else if (song.sigs !== before) ctx.changed();
      else if (!moved) ctx.transport.seek(Math.max(0, snapRound(timeAt(initial.x), step())));
      ctx.live?.();
      s.redraw();
    });
    cv.addEventListener('keydown', cancel);
  }

  // drag the restart marker along the ruler (snapped); released at time zero it is removed
  function restartDrag(e) {
    const song = ctx.song();
    const before = song.restart;
    const grab = timeAt(s.local(e).x) - before; // keep the grab offset (the label is beside the |)
    const st = step();
    let p = s.local(e);
    let moved = false;
    const apply = () => {
      setRestart(song, Math.max(0, snapRound(timeAt(clamp(p.x, x0, right())) - grab, st)));
      s.redraw();
    };
    const auto = areaScroll(apply, { vertical: false });
    dragging = true;
    capture(cv, e, (ev) => {
      p = s.local(ev);
      if (!moved && Math.abs(p.x - s.local(e).x) < 3) return;
      moved = true;
      apply();
      auto.update(p);
    }, (ev) => {
      auto.stop();
      dragging = false;
      if (ev.type === 'pointercancel') setRestart(song, before);
      else if (song.restart !== before) ctx.changed();
      s.redraw();
    });
  }

  cv.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    cv.focus();
    pointer = s.local(e);
    const bar = barAt(pointer.x, pointer.y);
    if (bar && e.button !== 1) {
      e.preventDefault();
      if (e.button === 0 && bar !== 'corner') scrollbarDrag(e, bar, pointer);
      return;
    }
    if (e.button === 1) {
      dragging = true;
      startPan(s, e, (dx, dy) => { view.sx -= dx; view.sy -= dy; limitScroll(); ctx.viewChanged?.(); s.redraw(); }, () => { dragging = false; });
      return;
    }
    const { x, y } = s.local(e);
    const song = ctx.song();
    if (e.button === MOUSE_FORWARD) {
      e.preventDefault();
      lastRight = null;
      if (y >= RULER && x >= x0) selectRect(e, x, y, e.ctrlKey || e.metaKey);
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      const box = sigAt(x, y);
      if (y < RULER || x < x0) {
        lastRight = null;
        // right-click a time signature: remove it; the restart marker: remove it;
        // elsewhere on the ruler: the signature / restart point menu
        const openRulerMenu = () => menu({ x: e.clientX, y: e.clientY, items: [signatureItem(x), '-', ...restartItems()] });
        if (box) rightHold(cv, e, {
          onShort: () => { if (removeSig(ctx.song(), box.at)) { ctx.changed(); s.redraw(); } },
          onHold: openRulerMenu,
        });
        else if (x >= x0 && restartAt(x, y)) rightHold(cv, e, { onShort: removeRestart, onHold: openRulerMenu });
        else if (x >= x0) openRulerMenu();
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
      const signature = sigAt(x, y);
      if (signature?.at > 0) { signatureDrag(e, signature.at); return; }
      let p = { x, y };
      const seek = () => { ctx.transport.seek(Math.max(0, snapRound(timeAt(clamp(p.x, x0, right())), st))); s.redraw(); };
      const auto = areaScroll(seek, { vertical: false });
      seek();
      dragging = true;
      capture(cv, e, (ev) => { p = s.local(ev); seek(); auto.update(p); }, () => { auto.stop(); dragging = false; });
      return;
    }
    if (y < RULER) { // bar numbers: click seeks, relative dragging pans and zooms time
      if (x < x0) return;
      if (restartAt(x, y)) { e.preventDefault(); restartDrag(e); return; }
      ctx.transport.seek(Math.max(0, snapRound(timeAt(x), st)));
      const before = { ...view };
      const anchor = timeAt(x);
      let moved = false;
      dragging = true;
      const cancel = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); stop({ type: 'pointercancel' }); }
      };
      const stop = rulerDrag(cv, e, (dx, dy) => {
        if (!moved && Math.max(Math.abs(dx), Math.abs(dy)) < 3) return;
        moved = true;
        view.ppq = clamp(before.ppq * Math.pow(1.15, -dy / 48), 2, 200);
        view.sx = anchor * view.ppq - (x - x0) - dx;
        limitScroll();
        s.redraw();
      }, ev => {
        cv.removeEventListener('keydown', cancel);
        dragging = false;
        if (ev.type === 'pointercancel') Object.assign(view, before);
        else if (moved) ctx.viewChanged?.();
        s.redraw();
      });
      cv.addEventListener('keydown', cancel);
      s.redraw();
      return;
    }
    if (x < x0) return;
    const additive = e.ctrlKey || e.metaKey;
    const h = hit(x, y);
    if (!h) {
      if (e.shiftKey) {
        dragging = true;
        startPan(s, e, (dx, dy) => { view.sx -= dx; view.sy -= dy; limitScroll(); ctx.viewChanged?.(); s.redraw(); }, () => { dragging = false; });
      } else selectRect(e, x, y, additive);
      return;
    }
    e.preventDefault();
    const source = h.clip;
    if (additive && !e.altKey && !e.shiftKey) { // Ctrl/Cmd + click: toggle the clip in the selection
      const clips = selectedClips();
      if (sel.has(source.id)) { if (clips.length > 1) setSelection(clips.filter((c) => c !== source)); } // the last one stays
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
    const snapT = (t) => (isIdea(clip) ? clean(t) : snapRound(t, st)); // ideas resize freely
    let moved = false;
    dragging = true;
    cv.style.cursor = part === 'body' ? 'grabbing' : 'ew-resize';
    let last = null;
    // dragging near an edge of the time area scrolls it, so a clip can travel anywhere in one drag
    const auto = areaScroll(() => { if (last) apply(last); }, { vertical: part === 'body' });
    const apply = (ev) => {
      const p = s.local(ev);
      if (!moved && Math.hypot(p.x - x, p.y - y) < 3) return; // a click is not a move
      const dt = timeAt(p.x) - tStart;
      if (part === 'body') {
        moveGroup(members, origs, anchor, dt, p.y + view.sy - yStart);
      } else if (part === 'right') {
        setLength(clip, Math.max(st, clean(snapT(orig.start + orig.length + dt) - clip.start)));
      } else {
        const lo = Math.max(...linked.map((l) => l.bounds.start - l.start));
        const hi = Math.min(...linked.map((l) => l.length - Math.min(st, l.length)));
        const delta = clamp(snapT(orig.start + dt) - orig.start, lo, hi);
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

  // Drag on empty space: rectangle selection (additive keeps the current selection). A plain click on
  // empty space, or a rectangle that catches no clip, keeps the selection: one clip is always selected.
  function selectRect(e, x, y, additive) {
    e.preventDefault();
    const base = additive ? selectedClips().map((c) => c.id) : [];
    // the start corner is anchored in the song, so the rectangle grows while the view scrolls along
    const t0 = timeAt(x);
    const w0 = worldY(y);
    rect = { x0: x, y0: y, x1: x, y1: y, ids: new Set(base), shown: false };
    const state = rect;
    let p = null;
    dragging = true;
    const apply = () => {
      if (rect !== state || !p) return;
      rect.shown = true;
      const ax = xOf(t0);
      const ay = w0 + RULER - view.sy;
      const bx = clamp(p.x, x0, right());
      const by = clamp(p.y, RULER, bottom());
      // drawn inside the time area; hit-tested over the whole span
      rect.x0 = clamp(ax, x0, right());
      rect.y0 = clamp(ay, RULER, bottom());
      rect.x1 = bx;
      rect.y1 = by;
      const l = Math.min(ax, bx);
      const r = Math.max(ax, bx);
      const t = Math.min(ay, by);
      const b = Math.max(ay, by);
      const hits = ctx.song().clips.filter((c) => {
        const cx = xOf(c.start);
        const cy = yOf(c.y);
        return cx < r && cx + c.length * view.ppq > l && cy < b && cy + CLIP_H > t;
      });
      rect.ids = new Set([...base, ...hits.map((c) => c.id)]);
      s.redraw();
    };
    const auto = areaScroll(apply);
    capture(cv, e, (ev) => {
      p = s.local(ev);
      if (!rect.shown && Math.hypot(p.x - x, p.y - y) < 3) return;
      apply();
      auto.update(p);
    }, (ev) => {
      auto.stop();
      dragging = false;
      const r = rect;
      rect = null;
      const clips = ctx.song().clips.filter((c) => r.ids.has(c.id));
      if (ev.type === 'pointercancel' || !r.shown || !clips.length) { s.redraw(); return; }
      setSelection(clips);
    });
  }

  // ---- commands (keyboard and context menu) ----
  // where pasted / inserted clips go: the snapped time and lane at local point p; in idea storage
  // exactly there (the clip's middle at the pointer)
  const dropAt = (p) => (worldY(p.y) < 0
    ? { start: clean(timeAt(p.x)), y: ideaY(worldY(p.y) - CLIP_H / 2) }
    : { start: snapFloor(timeAt(p.x), step()), y: laneAt(p.y) });
  const inTimeArea = (p) => !!p && p.x >= x0 && p.x <= right() && p.y >= RULER && p.y <= bottom();
  // clips keep their formation from the drop point; dropped in idea storage they all stay there
  function dropTargets(at, clips) {
    const t0 = Math.min(...clips.map((c) => c.start));
    const y0 = Math.min(...clips.map((c) => c.y));
    const targets = clips.map((c) => ({ start: clean(at.start + c.start - t0), y: at.y + c.y - y0 }));
    const over = at.y < 0 ? Math.max(...targets.map((t) => t.y)) + CLIP_H : 0;
    if (over > 0) for (const t of targets) t.y -= over;
    return targets;
  }

  function copy() {
    const clips = selectedClips();
    if (clips.length) clipboard = clips.map((c) => structuredClone(c));
    return clips.length > 0;
  }
  function remove() {
    const clips = selectedClips();
    if (!clips.length) return;
    for (const c of clips) removeClip(ctx.song(), c.id);
    const next = getClip(ctx.song(), ctx.song().selected); // removeClip picks the clip nearest to the removed one
    setSelection(next ? [next] : []);
    ctx.changed();
  }
  function paste(p) {
    if (!clipboard || !inTimeArea(p)) return;
    const song = ctx.song();
    const copies = clipboard.map((c) => duplicateClip(song, c));
    placeAll(copies, dropTargets(dropAt(p), clipboard));
    setSelection(copies, copies[0]);
    ctx.changed();
  }
  // clips from a .clip file, placed like a paste at local point p
  async function loadClips(p) {
    const loaded = await ctx.openClips?.();
    if (!loaded?.length) return;
    const song = ctx.song();
    const copies = loaded.map((c) => duplicateClip(song, c));
    placeAll(copies, dropTargets(dropAt(p), loaded));
    setSelection(copies, copies[0]);
    ctx.changed();
  }
  async function importMidi(p) {
    const song = ctx.song();
    const layerVersion = ctx.layerVersion?.();
    const at = dropAt(p);
    const result = await ctx.openMidi?.();
    if (!result) return;
    if (ctx.song() !== song || ctx.layerVersion?.() !== layerVersion) {
      ctx.midiImportCancelled?.();
      return;
    }
    const tracks = result.tempoClip ? [...result.clips, result.tempoClip] : result.clips;
    const copies = [];
    if (at.y < 0) {
      const firstY = Math.min(at.y, -tracks.length * CLIP_H);
      for (let i = 0; i < tracks.length; i++) {
        copies.push(duplicateClip(song, { ...tracks[i], start: at.start, y: firstY + i * CLIP_H }));
      }
    } else {
      let y = at.y;
      for (const track of tracks) {
        const candidate = { ...track, start: at.start, y };
        while (song.clips.some((c) => c.y >= 0 && clipsOverlap(candidate, c))) candidate.y += CLIP_H;
        copies.push(duplicateClip(song, candidate));
        y = candidate.y + CLIP_H;
      }
    }
    setSelection(copies, copies[0]);
    ctx.changed();
    ctx.midiImported?.(result);
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
    syncSel();
    const song = ctx.song();
    const clips = [...sel].map((id) => getClip(song, id)).filter(Boolean);
    const merged = consolidateClips(song, clips);
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
        { label: 'Split at playhead', shortcut: 'S', disabled: !splittable().length, action: split },
        '-',
        { label: clips.length > 1 ? 'Save Clips…' : 'Save Clip…', disabled: !ctx.saveClips, action: () => ctx.saveClips(clips) },
        { label: 'Import MIDI…', disabled: !ctx.openMidi || !inTimeArea(p), action: () => importMidi(p) },
        '-',
        signatureItem(x),
        ...restartItems(),
        '-',
        { label: 'Select all', shortcut: shortcut('A'), action: selectAll },
      ]
      : [
        { label: 'Paste', shortcut: shortcut('V'), disabled: !clipboard, action: () => paste(p) },
        '-',
        { label: 'Insert clip', action: () => insert(x, y, false) },
        { label: 'Insert automation clip', action: () => insert(x, y, true) },
        { label: 'Load Clip…', disabled: !ctx.openClips || !inTimeArea(p), action: () => loadClips(p) },
        { label: 'Import MIDI…', disabled: !ctx.openMidi || !inTimeArea(p), action: () => importMidi(p) },
        '-',
        signatureItem(x),
        ...restartItems(),
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
    if (e.button !== 0) return;
    const { x, y } = s.local(e);
    if (x < x0 || barAt(x, y)) return;
    const song = ctx.song();
    if (y < SIG_H) { // time signature change at the nearest bar line (or the one double-clicked)
      const box = sigAt(x, y);
      ctx.editSig(box ? box.at : barRound(song, Math.max(0, timeAt(x))));
      return;
    }
    if (y < RULER) { // bar numbers: the restart point here (snapped; time zero removes it)
      if (restartAt(x, y)) return;
      setRestart(song, Math.max(0, snapRound(timeAt(x), step())));
      ctx.changed();
      s.redraw();
      return;
    }
    const clip = hit(x, y)?.clip;
    if (clip) {
      setSelection([clip], clip);
      ctx.focusEditor?.();
      return;
    }
    insert(x, y, false);
  });

  cv.addEventListener('pointermove', (e) => {
    pointer = s.local(e);
    if (e.buttons) return;
    const { x, y } = s.local(e);
    hoverAt(x, y);
  });
  cv.addEventListener('pointerleave', () => {
    pointer = null;
    if (hoverId !== null || sbHover !== null) { hoverId = null; sbHover = null; s.redraw(); }
  });

  cv.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey;
    const deleting = key === 'backspace' || key === 'delete';
    const splitting = key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (!deleting && !splitting && key !== 'escape' && !(command && ['x', 'c', 'v', 'a', 'd'].includes(key))) return;
    if (key === 'escape' && !dragging) return; // the selection stays: a clip is always selected
    e.preventDefault();
    e.stopPropagation();
    if (dragging) return;
    if (splitting) { if (!e.repeat) split(); }
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
      limitScroll();
      ctx.viewChanged?.();
      s.redraw();
    },
    // the wheel scrolls along the time axis; Shift + wheel scrolls the lanes
    scroll(dx, dy, e) {
      pointer = s.local(e);
      if (e.shiftKey) view.sy += dx + dy;
      else view.sx += dx + dy;
      limitScroll();
      ctx.viewChanged?.();
      s.redraw();
    },
  });

  return {
    surface: s,
    redraw: s.redraw,
    place,
    setLength,
    reveal,
    selectedClips,
    getView: () => ({ ...view }),
    setView(v) {
      if (!v) return;
      for (const k of ['sx', 'sy', 'ppq']) if (Number.isFinite(v[k])) view[k] = v[k];
      view.ppq = clamp(view.ppq, 2, 200);
      if (host.clientHeight > 0) limitScroll(host.clientHeight);
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        viewportWidth = host.clientWidth;
        viewportHeight = host.clientHeight;
      }
      s.redraw();
    },
  };
}
