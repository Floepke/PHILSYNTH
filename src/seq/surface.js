// Shared plumbing for the sequencer views: a HiDPI canvas that fills its host element and
// redraws on resize, plus middle-mouse panning and wheel handling.
import { wheelNotches } from '../params.js';

export function createSurface(host, paint) {
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

// Auto-scroll while dragging near (or past) the edges of the scrollable area. update(p) with the
// local pointer after every move; while p is within `edge` px of an edge (or beyond it), every
// tick calls scroll(dx, dy) (px, faster the deeper the pointer is) and then onScroll() so the drag
// is re-applied at the new view. stop() when the drag ends. area() -> { left, top, right, bottom };
// vertical: false keeps dy at 0.
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
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let dx = e.deltaX * k;
    let dy = e.deltaY * k;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    scroll(dx, dy, e);
  }, { passive: false });
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Alternating light/dark bands one snap step wide, from t0 to t1, instead of a line per step.
// When a step is too thin to see, bands of 2, 4, 8… steps are used so the stripes stay readable.
// band(a, b) draws the dark band covering time a..b.
export function snapBands(st, ppq, t0, t1, band, minPx = 4) {
  let s = st;
  while (s * ppq < minPx) s *= 2;
  for (let k = Math.floor(t0 / s + 1e-9); k * s < t1; k++) if (k % 2) band(k * s, (k + 1) * s);
}
