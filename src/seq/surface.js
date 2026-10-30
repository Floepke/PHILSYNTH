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
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    cv.removeEventListener('pointermove', move);
    cv.removeEventListener('pointerup', up);
    cv.removeEventListener('pointercancel', up);
    onUp?.(ev);
  };
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
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
