// Shared plumbing for the sequencer views: a HiDPI canvas that fills its host element and
// redraws on resize, plus middle-mouse panning and wheel handling.
import { wheelNotches, wheelDelta } from '../params.js';

export function createSurface(host, paint, { onResize } = {}) {
  const cv = document.createElement('canvas');
  cv.tabIndex = 0; // focusable, so Backspace / Delete reach the view that was clicked last
  host.append(cv);
  const g = cv.getContext('2d');
  const s = {
    cv, g, w: 0, h: 0, dpr: 1, frame: 0,
    draw() { g.setTransform(s.dpr, 0, 0, s.dpr, 0, 0); paint(g, s.w, s.h); },
    redraw() { s.frame ||= requestAnimationFrame(() => { s.frame = 0; s.draw(); }); },
    local(e) {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
  };
  new ResizeObserver(() => {
    s.dpr = window.devicePixelRatio || 1;
    s.w = host.clientWidth;
    s.h = host.clientHeight;
    onResize?.(s.w, s.h);
    cv.width = Math.max(1, Math.round(s.w * s.dpr));
    cv.height = Math.max(1, Math.round(s.h * s.dpr));
    cv.style.width = `${s.w}px`;
    cv.style.height = `${s.h}px`;
    s.draw();
  }).observe(host);
  cv.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll
  cv.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); }); // no Linux paste
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  return s;
}

// Drag with pointer capture: onMove(e) while the button is down, then onUp(e).
export function capture(cv, e, onMove, onUp) {
  cv.setPointerCapture(e.pointerId);
  let ended = false;
  const move = (ev) => { if (ev.pointerId === e.pointerId) onMove(ev); };
  const up = (ev) => {
    if (ended || (ev.pointerId !== undefined && ev.pointerId !== e.pointerId)) return;
    ended = true;
    cv.removeEventListener('pointermove', move);
    cv.removeEventListener('pointerup', up);
    cv.removeEventListener('pointercancel', up);
    cv.removeEventListener('lostpointercapture', up);
    onUp?.(ev);
  };
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('lostpointercapture', up);
  return up;
}

// Relative ruler drag: pointer lock restores the cursor to its press position on release.
export function rulerDrag(cv, e, onMove, onUp) {
  let ended = false;
  let locked = false;
  let dx = 0, dy = 0;
  const move = ev => {
    if (ended) return;
    if (document.pointerLockElement === cv) {
      if (ev.type !== 'mousemove') return;
      dx += ev.movementX;
      dy += ev.movementY;
    } else {
      if (ev.type !== 'pointermove' || ev.pointerId !== e.pointerId) return;
      dx = ev.clientX - e.clientX;
      dy = ev.clientY - e.clientY;
    }
    onMove(dx, dy);
  };
  const finish = ev => {
    if (ended) return;
    ended = true;
    cv.removeEventListener('pointermove', move);
    cv.removeEventListener('pointerup', finish);
    cv.removeEventListener('pointercancel', finish);
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', finish);
    document.removeEventListener('pointerlockchange', lockChange);
    document.removeEventListener('pointerlockerror', lockError);
    window.removeEventListener('blur', cancel);
    if (document.pointerLockElement === cv) document.exitPointerLock();
    onUp(ev);
  };
  const cancel = () => finish({ type: 'pointercancel' });
  const lockChange = () => {
    if (document.pointerLockElement === cv) {
      if (ended) document.exitPointerLock();
      else locked = true;
    } else if (locked) cancel();
  };
  const lockError = () => console.warn('Ruler pointer lock unavailable; using ordinary cursor dragging.');
  cv.setPointerCapture(e.pointerId);
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', finish);
  document.addEventListener('pointerlockchange', lockChange);
  document.addEventListener('pointerlockerror', lockError);
  window.addEventListener('blur', cancel);
  if (cv.requestPointerLock) {
    try {
      const pending = cv.requestPointerLock();
      pending?.then(() => { if (ended && document.pointerLockElement === cv) document.exitPointerLock(); }, lockError);
    } catch (err) {
      console.warn('Could not lock ruler cursor:', err);
    }
  }
  return finish;
}

// Auto-scroll while dragging near (or past) the edges of the scrollable area. update(p) with the
// local pointer after every move; while p is within `edge` px of an edge (or beyond it), every
// tick calls scroll(dx, dy) (px, faster the deeper the pointer is) and then onScroll() so the drag
// is re-applied at the new view. stop() when the drag ends. area() -> { left, top, right, bottom };
// vertical: false keeps dy at 0.
// A big solid black M centred in the visible area (x, y, w, h): the clip shown
// sits on a muted TimeLine lane, so it is silent. Drawn as one path, not a font glyph (glyphs
// built from overlapping strokes can show inner seams).
export const MUTE_COLOR = '#d9a521';
// unit M outline (x 0..1, y 0..1 down): stems 0.2 wide, diagonals meeting in the middle
const M_SHAPE = [[0, 1], [0, 0], [0.22, 0], [0.5, 0.5], [0.78, 0], [1, 0], [1, 1], [0.8, 1], [0.8, 0.284], [0.5, 0.82], [0.2, 0.284], [0.2, 1]];
export function mutedMark(g, x, y, w, h) {
  const mh = Math.min(h * 0.55, w * 0.6);
  if (!(mh > 8)) return;
  const mw = mh * 1.05;
  const left = x + (w - mw) / 2;
  const top = y + (h - mh) / 2;
  g.save();
  g.beginPath();
  M_SHAPE.forEach(([px, py], i) => (i ? g.lineTo : g.moveTo).call(g, left + px * mw, top + py * mh));
  g.closePath();
  g.fillStyle = '#000';
  g.fill();
  g.restore();
}

export const EDGE_SCROLL_PX = 32;
export const EDGE_SCROLL_MS = 16;
const EDGE_SCROLL_MAX = 40; // px per tick
export function edgeScroll({ area, scroll, onScroll, vertical = true, edge = EDGE_SCROLL_PX }) {
  let p = null;
  let timer = null;
  const axis = (lo, hi, x) => {
    const e = Math.min(edge, Math.max(0, (hi - lo) / 4));
    const rate = (d) => Math.min(EDGE_SCROLL_MAX, Math.max(1, d * 0.6));
    if (x < lo + e) return -rate(lo + e - x);
    if (x > hi - e) return rate(x - (hi - e));
    return 0;
  };
  const velocity = () => {
    if (!p) return [0, 0];
    const a = area();
    return [axis(a.left, a.right, p.x), vertical ? axis(a.top, a.bottom, p.y) : 0];
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    const [dx, dy] = velocity();
    if (!dx && !dy) { stop(); return; }
    scroll(dx, dy);
    onScroll();
  };
  return {
    update(point) {
      p = point;
      const [dx, dy] = velocity();
      if ((dx || dy) && !timer) timer = setInterval(tick, EDGE_SCROLL_MS);
      else if (!dx && !dy) stop();
    },
    stop() { p = null; stop(); },
  };
}

// Scrollbars of the TimeLine and the piano roll, drawn like the controller panel's.
export const SB = 32; // bar thickness
export const SB_PAD = 8; // thumb inset
export const SB_MIN = 48; // shortest thumb
export const SB_TRACK = '#151517'; // --surface-2
export const SB_THUMB = ['#2a2a2e', '#4a4a52', '#5a5a64']; // --surface-4, hover, dragged
// Track from a over len px for the scroll values lo..hi (page = the visible extent, v = now):
// -> { a, len, lo, hi, thumb (px long), pos (px, start of the thumb) }
export function scrollThumb(a, len, page, lo, hi, v) {
  len = Math.max(0, len);
  const thumb = Math.min(len, Math.max(SB_MIN, (len * page) / (hi - lo + page)));
  const pos = a + (hi > lo ? (clamp(v, lo, hi) - lo) / (hi - lo) : 0) * (len - thumb);
  return { a, len, lo, hi, thumb, pos };
}
// the scroll value that puts the thumb's start at track coordinate `at`
export const scrollValue = (b, at) => b.lo + (b.len > b.thumb ? clamp((at - b.a) / (b.len - b.thumb), 0, 1) : 0) * (b.hi - b.lo);
// the rounded thumb of bar b in the track whose cross axis starts at `across`; state 0 idle, 1 hover, 2 dragged
export function paintThumb(g, b, vertical, across, state) {
  g.fillStyle = SB_THUMB[state];
  const th = SB - 2 * SB_PAD;
  const tl = Math.max(th, b.thumb - 2 * SB_PAD);
  if (vertical) roundRect(g, across + SB_PAD, b.pos + SB_PAD, th, tl, th / 2);
  else roundRect(g, b.pos + SB_PAD, across + SB_PAD, tl, th, th / 2);
  g.fill();
}

export function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export const RIGHT_HOLD_MS = 250;
export const RIGHT_HOLD_SLOP = 5; // px the pointer may move before a right-button hold is cancelled

// Right button press: holding it still for RIGHT_HOLD_MS calls onHold() (the release then does
// nothing); an earlier release calls onShort(ev). Moving `slop` px or more, the wheel, Escape,
// blur or a lost capture cancel both. onEnd(ev) always runs last. Returns a cancel function.
export function rightHold(el, e, { onShort, onHold, onEnd, slop = RIGHT_HOLD_SLOP }) {
  let held = false;
  let moved = false;
  let timer = null;
  const hold = () => {
    if (held || moved) return;
    held = true;
    clearTimeout(timer);
    onHold?.();
  };
  const key = (ev) => { if (ev.key === 'Escape') stop(ev); };
  const stop = capture(el, e, (ev) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) >= slop) {
      moved = true;
      clearTimeout(timer);
    }
  }, (ev) => {
    clearTimeout(timer);
    el.removeEventListener('wheel', stop, true);
    window.removeEventListener('blur', stop);
    window.removeEventListener('keydown', key, true);
    if (ev.type === 'pointerup' && !held && !moved) {
      // A busy event loop can deliver the release before the overdue timer callback.
      if (ev.timeStamp - e.timeStamp >= RIGHT_HOLD_MS) hold();
      else onShort?.(ev);
    }
    onEnd?.(ev);
  });
  el.addEventListener('wheel', stop, true);
  window.addEventListener('blur', stop);
  window.addEventListener('keydown', key, true);
  timer = setTimeout(hold, RIGHT_HOLD_MS);
  return stop;
}

// Middle mouse drag: pan(dx, dy) gets the movement since the last call.
export function startPan(s, e, pan, onUp) {
  e.preventDefault();
  let lx = e.clientX;
  let ly = e.clientY;
  s.cv.classList.add('panning');
  capture(s.cv, e, (ev) => {
    pan(ev.clientX - lx, ev.clientY - ly);
    lx = ev.clientX;
    ly = ev.clientY;
  }, (ev) => { s.cv.classList.remove('panning'); onUp?.(ev); });
}

// Wheel: Ctrl = zoom(notches, e) (+ = in), Shift = horizontal scroll, otherwise
// scroll(dx, dy, e) in pixels (trackpads also deliver deltaX).
export function onWheel(cv, { zoom, scroll }) {
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { zoom(wheelNotches(e.deltaY, e.deltaMode), e); return; }
    const d = wheelDelta(e);
    const k = d.mode === 1 ? 16 : d.mode === 2 ? 400 : 1;
    let dx = d.dx * k;
    let dy = d.dy * k;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    scroll(dx, dy, e);
  }, { passive: false });
}

// NaN clamps to lo, so a bad value can never stick in a view position
export const clamp = (v, lo, hi) => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)));

// Alternating light/dark bands one snap step wide, from t0 to t1, instead of a line per step.
// When a step is too thin to see, bands of 2, 4, 8… steps are used so the stripes stay readable.
// band(a, b) draws the dark band covering time a..b.
export function snapBands(st, ppq, t0, t1, band, minPx = 4) {
  let s = st;
  while (s * ppq < minPx) s *= 2;
  for (let k = Math.floor(t0 / s + 1e-9); k * s < t1; k++) if (k % 2) band(k * s, (k + 1) * s);
}
