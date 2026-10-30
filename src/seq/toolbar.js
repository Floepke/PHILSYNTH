import { clamp } from './surface.js';

// A stationary pointer near an edge reveals overflow; the middle is a stable editing zone.
export function createHoverToolbar(bar, content) {
  let frame = 0;
  let last = 0;
  let speed = 0;
  let position = 0;
  const end = () => Math.max(0, bar.scrollWidth - bar.clientWidth);
  const showEdges = () => {
    bar.classList.toggle('can-scroll-left', bar.scrollLeft > 1);
    bar.classList.toggle('can-scroll-right', bar.scrollLeft < end() - 1);
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    last = 0;
    speed = 0;
  };
  const tick = (time) => {
    frame = 0;
    const dt = Math.min(50, last ? time - last : 16) / 1000;
    last = time;
    // Retain subpixel movement: browsers may round each scrollLeft assignment.
    position = clamp(position + speed * dt, 0, end());
    bar.scrollLeft = position;
    showEdges();
    if ((speed < 0 && position > 0) || (speed > 0 && position < end())) frame = requestAnimationFrame(tick);
    else last = 0;
  };
  bar.addEventListener('pointermove', (e) => {
    if (e.buttons || e.pointerType === 'touch' || bar.contains(document.activeElement) || !bar.clientWidth || end() <= 1) {
      stop();
      return;
    }
    const r = bar.getBoundingClientRect();
    const x = e.clientX - r.left;
    const edge = Math.min(72, r.width / 3);
    speed = x < edge ? -560 * (1 - clamp(x / edge, 0, 1)) ** 2
      : x > r.width - edge ? 560 * (1 - clamp((r.width - x) / edge, 0, 1)) ** 2 : 0;
    if (!speed) stop();
    else if (!frame) {
      position = bar.scrollLeft;
      frame = requestAnimationFrame(tick);
    }
  });
  for (const event of ['pointerleave', 'pointerdown', 'pointercancel', 'keydown']) bar.addEventListener(event, stop);
  bar.addEventListener('wheel', (e) => {
    stop();
    // Widget handlers have already adjusted their values; never wheel-scroll the toolbar.
    if (!e.ctrlKey && !e.metaKey) e.preventDefault();
  }, { passive: false });
  bar.addEventListener('focusin', (e) => {
    stop();
    const bounds = bar.getBoundingClientRect();
    const field = e.target.getBoundingClientRect();
    if (field.left < bounds.left) bar.scrollLeft -= bounds.left - field.left + 10;
    else if (field.right > bounds.right) bar.scrollLeft += field.right - bounds.right + 10;
    showEdges();
  });
  bar.addEventListener('scroll', showEdges, { passive: true });
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  const resize = new ResizeObserver(() => {
    stop();
    bar.scrollLeft = clamp(bar.scrollLeft, 0, end());
    showEdges();
  });
  resize.observe(bar);
  resize.observe(content);
  showEdges();
}
