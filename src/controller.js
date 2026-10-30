// Panel controller: a tall rectangle whose fill shows the value.
//   drag sideways     move the value (relative, a click does not jump; Shift while dragging = fine)
//   mouse wheel       ±1 % per notch, Shift + wheel ±0.1 %; stepped controllers move one step
//   double-click      reset to the default
// Bipolar ranges (min < 0 < max) fill from the zero point. Option lists show a tick per entry.
// The element never takes keyboard focus, so keyboard shortcuts keep working.
import { toNorm, fromNorm, nudge, wheelAccumulator } from './params.js';

const FINE_DRAG = 0.1; // Shift-drag speed relative to normal

export function createController(p, { index, value, onInput, format }) {
  const el = document.createElement('div');
  el.className = 'ctl';
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', p.label);
  el.setAttribute('aria-valuemin', p.min);
  el.setAttribute('aria-valuemax', p.max);
  el.title = `${p.label} — drag sideways or scroll (Shift: fine), double-click: reset`;

  const fill = document.createElement('span');
  fill.className = 'ctl-fill';
  const marker = document.createElement('span');
  marker.className = 'mod-marker';
  const num = document.createElement('span');
  num.className = 'ctl-num';
  num.textContent = index;
  num.title = `Controller ${index}`;
  const name = document.createElement('span');
  name.className = 'ctl-label';
  name.textContent = p.label;
  const out = document.createElement('output');
  out.className = 'ctl-value';
  el.append(fill, marker, num, name, out);

  const origin = p.min < 0 && p.max > 0 && p.scale !== 'log' ? toNorm(p, 0) : 0;
  el.style.setProperty('--origin', origin);
  const steps = p.options ? p.options.length - 1 : p.step && (p.max - p.min) / p.step <= 16 ? Math.round((p.max - p.min) / p.step) : 0;
  if (steps > 0) {
    el.classList.add('stepped');
    el.style.setProperty('--steps', steps);
  }

  let v = value;
  const show = (nv) => {
    v = nv;
    const x = Math.min(1, Math.max(0, toNorm(p, v)));
    el.style.setProperty('--pos', x);
    const text = format(v);
    out.textContent = text;
    el.setAttribute('aria-valuenow', v);
    el.setAttribute('aria-valuetext', text);
  };
  const set = (nv) => {
    if (nv === v || !Number.isFinite(nv)) return;
    show(nv);
    onInput(nv);
  };
  show(value);

  // ---- pointer: relative drag (no jump on click); Shift = fine ----
  // Dragging across the controller's width covers the whole range.
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no focus
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    drag = { x: e.clientX, norm: toNorm(p, v), id: e.pointerId };
    // a release anywhere (the capture may already be gone) or leaving the window ends the drag
    window.addEventListener('pointerup', end, true);
    window.addEventListener('blur', end);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // the release can get lost (e.g. outside the window): no button held = the drag is over
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(); return; }
    const width = el.getBoundingClientRect().width || 1;
    drag.norm = Math.min(1, Math.max(0, drag.norm + ((e.clientX - drag.x) / width) * (e.shiftKey ? FINE_DRAG : 1)));
    drag.x = e.clientX;
    set(fromNorm(p, drag.norm));
  });
  function end() {
    if (!drag) return;
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('blur', end);
    const { id } = drag;
    drag = null;
    if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    el.classList.remove('active');
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('dblclick', () => set(p.default ?? p.min));

  // ---- wheel ----
  const take = wheelAccumulator({ whole: !!p.step }); // stepped controllers wait for a whole notch
  el.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return; // keep Ctrl + wheel for zoom
    e.preventDefault();
    // Shift + wheel is horizontal scrolling on some systems: use whichever axis moved
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const n = take(e, delta);
    if (!n) return;
    set(nudge(p, v, n, e.shiftKey));
    el.classList.add('wheel');
    clearTimeout(el._wheelTimer);
    el._wheelTimer = setTimeout(() => el.classList.remove('wheel'), 400);
  }, { passive: false });

  return {
    el,
    show,
    // live modulation position (0..1) or null when not modulated
    setMod(norm) {
      el.classList.toggle('modulated', norm !== null);
      if (norm !== null) el.style.setProperty('--mod', Math.min(1, Math.max(0, norm)));
    },
  };
}
