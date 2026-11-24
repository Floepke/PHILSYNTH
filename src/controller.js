// Panel controller: a tall rectangle whose fill shows the value.
//   drag sideways     move the value (relative, a click does not jump; Shift while dragging = fine,
//                     Alt/Option = extra fine)
//   ◀ / ▶ buttons     move one fine step (0.01 % for a 0..100 range); hold to repeat
// Controllers with p.snapValues(values) (fixed values depending on the other controllers, e.g. a
// synced LFO Frequency) snap drags and button clicks to them and show a tick at each.
//   double-click      reset to the default
// Bipolar ranges (min < 0 < max) fill from the zero point. Option lists show a tick per entry.
// The element never takes keyboard focus, so keyboard shortcuts keep working.
import { toNorm, fromNorm, nudge, snapNearest, snapStep } from './params.js';

const FINE_DRAG = 0.1; // Shift-drag speed relative to normal
const EXTRA_FINE_DRAG = 0.01; // Alt/Option-drag
const REPEAT_DELAY = 350;
const REPEAT_INTERVAL = 50;
export const ctlTitle = (p) => `${p.label} — drag sideways (Shift: fine, Alt/Option: extra fine), use or hold ◀ / ▶ to step, double-click: reset`;

export function createController(p, { index, value, onInput, format, onBegin, onEnd, values }) {
  const el = document.createElement('div');
  el.className = 'ctl';
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', p.label);
  el.setAttribute('aria-valuemin', p.min);
  el.setAttribute('aria-valuemax', p.max);
  el.title = ctlTitle(p);

  const track = document.createElement('div');
  track.className = 'ctl-track';
  const fill = document.createElement('span');
  fill.className = 'ctl-fill';
  track.append(fill);
  const num = document.createElement('span');
  num.className = 'ctl-num';
  num.textContent = index;
  num.title = `Controller ${index}`;
  const name = document.createElement('span');
  name.className = 'ctl-label';
  name.textContent = p.label;
  // If the label contains a note symbol (♩), split it and style the symbol separately.
  if (p.label.includes('♩')) {
    const [before, after] = p.label.split('♩');
    const note = document.createElement('span');
    note.className = 'ctl-note-symbol';
    note.textContent = '♩';
    name.textContent = before;
    name.append(note, after);
  }
  const out = document.createElement('output');
  out.className = 'ctl-value';
  const buttons = document.createElement('div');
  buttons.className = 'ctl-buttons';
  const stepButtons = [];
  let press = null;
  const stopPress = (event) => {
    if (!press || (event?.pointerId !== undefined && event.pointerId !== press.id)) return;
    const { button, id, timer, began } = press;
    press = null;
    clearTimeout(timer);
    window.removeEventListener('pointerup', stopPress, true);
    window.removeEventListener('pointercancel', stopPress, true);
    window.removeEventListener('blur', stopPress);
    if (button.hasPointerCapture?.(id)) button.releasePointerCapture(id);
    if (began) onEnd?.();
  };
  for (const [direction, glyph, label] of [[-1, '◀', 'Decrease'], [1, '▶', 'Increase']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.textContent = glyph;
    button.className = direction < 0 ? 'ctl-decrease' : 'ctl-increase';
    button.setAttribute('aria-label', `${label} ${p.label}`);
    button.title = label;
    const step = () => {
      if (p.disabled) return;
      updateSnaps();
      const next = snaps ? snapStep(snaps, v, direction) : nudge(p, v, direction, 'extra');
      if (next === v || !Number.isFinite(next)) return;
      if (press) {
        if (!press.began) { press.began = true; onBegin?.(); }
        set(next);
      } else {
        onBegin?.();
        set(next);
        onEnd?.();
      }
    };
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || p.disabled || press) return;
      e.preventDefault();
      e.stopPropagation();
      press = { button, id: e.pointerId, timer: null, began: false };
      button.setPointerCapture(e.pointerId);
      window.addEventListener('pointerup', stopPress, true);
      window.addEventListener('pointercancel', stopPress, true);
      window.addEventListener('blur', stopPress);
      step();
      const repeat = () => {
        if (!press) return;
        if (!button.isConnected || p.disabled) { stopPress(); return; }
        step();
        if (press) press.timer = setTimeout(repeat, REPEAT_INTERVAL);
      };
      if (press) press.timer = setTimeout(repeat, REPEAT_DELAY);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, stopPress);
    button.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.detail) return; // the pointer press already stepped
      step();
    });
    buttons.append(button);
    stepButtons.push(button);
  }
  el.append(track, num, name, out, buttons);

  const origin = p.min < 0 && p.max > 0 && p.scale !== 'log' ? toNorm(p, 0) : 0;
  el.style.setProperty('--origin', origin);
  const steps = p.options ? p.options.length - 1 : p.step && (p.max - p.min) / p.step <= 16 ? Math.round((p.max - p.min) / p.step) : 0;
  if (steps > 0) {
    el.classList.add('stepped');
    el.style.setProperty('--steps', steps);
  }

  // fixed values of the moment (null: continuous), ticks at their slider positions
  let snaps = null;
  const updateSnaps = () => {
    const next = p.snapValues?.(values?.()) ?? null;
    if (next === snaps) return;
    snaps = next?.length ? next : null;
    el.classList.toggle('ticked', !!snaps);
    if (!snaps) return;
    const at = snaps.map((s) => `${(Math.min(1, Math.max(0, toNorm(p, s))) * 100).toFixed(3)}%`);
    el.style.setProperty('--tick-img', at.map(() => 'linear-gradient(rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.22))').join(', '));
    el.style.setProperty('--tick-pos', at.map((x) => `${x} 0`).join(', '));
  };

  let v = value;
  const show = (nv) => {
    if (p.disabled) stopPress();
    el.setAttribute('aria-disabled', !!p.disabled);
    el.setAttribute('aria-valuemax', p.max);
    el.title = p.disabled ? p.disabledReason : ctlTitle(p);
    for (const button of stepButtons) button.disabled = !!p.disabled;
    updateSnaps();
    v = nv;
    const x = Math.min(1, Math.max(0, toNorm(p, v)));
    el.style.setProperty('--pos', x);
    const text = format(v);
    out.textContent = text;
    el.setAttribute('aria-valuenow', v);
    el.setAttribute('aria-valuetext', text);
  };
  const set = (nv) => {
    if (p.disabled || nv === v || !Number.isFinite(nv)) return;
    show(nv);
    onInput(nv);
  };
  show(value);

  // ---- pointer: relative drag (no jump on click); Shift = fine, Alt/Option = extra fine ----
  // Dragging across the controller's width covers the whole range.
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || p.disabled) return;
    e.preventDefault(); // no text selection, no focus
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    drag = { x: e.clientX, norm: toNorm(p, v), id: e.pointerId };
    onBegin?.();
    // a release anywhere (the capture may already be gone) or leaving the window ends the drag
    window.addEventListener('pointerup', end, true);
    window.addEventListener('blur', end);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // the release can get lost (e.g. outside the window): no button held = the drag is over
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(); return; }
    const width = el.getBoundingClientRect().width || 1;
    drag.norm = Math.min(1, Math.max(0, drag.norm + ((e.clientX - drag.x) / width) * (e.altKey ? EXTRA_FINE_DRAG : e.shiftKey ? FINE_DRAG : 1)));
    drag.x = e.clientX;
    const nv = fromNorm(p, drag.norm);
    set(snaps ? snapNearest(p, snaps, nv) : nv);
  });
  function end() {
    if (!drag) return;
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('blur', end);
    const { id } = drag;
    drag = null;
    if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    el.classList.remove('active');
    onEnd?.();
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('dblclick', () => set(p.default ?? p.min));

  return { el, show }; // show(v): a driven value (LFO, automation, …) moved the controller
}
