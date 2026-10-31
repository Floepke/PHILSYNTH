import { clamp } from './surface.js';

// Pointer position across the visible row maps continuously to its full scroll range.
export function createHoverToolbar(bar, content) {
  let frame = 0;
  let position = 0;
  const end = () => Math.max(0, bar.scrollWidth - bar.clientWidth);
  const showEdges = () => {
    bar.classList.toggle('can-scroll-left', bar.scrollLeft > 1);
    bar.classList.toggle('can-scroll-right', bar.scrollLeft < end() - 1);
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const tick = () => {
    frame = 0;
    bar.scrollLeft = clamp(position, 0, end());
    showEdges();
  };
  bar.addEventListener('pointermove', (e) => {
    if (e.buttons || e.pointerType === 'touch' || bar.contains(document.activeElement) || !bar.clientWidth || end() <= 1) {
      stop();
      return;
    }
    const r = bar.getBoundingClientRect();
    const x = e.clientX - r.left;
    const inset = Math.min(r.width / 4, Math.max(32,
      (content.firstElementChild?.offsetWidth ?? 0) / 2 + 6,
      (content.lastElementChild?.offsetWidth ?? 0) / 2 + 6));
    position = clamp((x - inset) / (r.width - 2 * inset), 0, 1) * end();
    if (!frame) frame = requestAnimationFrame(tick);
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
