// Shared controller (param) helpers.
// A controller's "position" is 0..1 along its slider: linear, or exponential for scale:'log'.

export function toNorm(p, v) {
  if (p.scale === 'log') return Math.log(v / p.min) / Math.log(p.max / p.min);
  const span = p.max - p.min;
  return span ? (v - p.min) / span : 0;
}

export function fromNorm(p, x) {
  x = Math.min(1, Math.max(0, x));
  if (p.scale === 'log') return p.min * Math.pow(p.max / p.min, x);
  let v = p.min + x * (p.max - p.min);
  if (p.step) v = p.min + Math.round((v - p.min) / p.step) * p.step;
  return Math.min(p.max, Math.max(p.min, +v.toFixed(6)));
}

// Controller list of a module instance (some modules, like Patch, have dynamic ranges).
export const paramsOf = (entry) => entry.inst.params?.() ?? entry.def.params;

// Mouse-wheel / nudge step: `notches` wheel clicks (fractional for trackpads, + = up).
// One notch moves 1 % of the slider (0.1 % with `fine`); stepped controllers always move at
// least one step so option lists and integers advance one entry per click.
export const WHEEL_COARSE = 0.01;
export const WHEEL_FINE = 0.001;
export function nudge(p, v, notches, fine = false) {
  if (!notches) return v;
  const next = fromNorm(p, toNorm(p, v) + notches * (fine ? WHEEL_FINE : WHEEL_COARSE));
  if (p.step && next === v) return Math.min(p.max, Math.max(p.min, +(v + Math.sign(notches) * p.step).toFixed(6)));
  return next;
}

// Wheel event -> notches (positive = scroll up). Mouse wheels give one big delta per click
// (Chrome ±100/120 px, Firefox 3 lines or ~50 px); trackpads give many small pixel deltas.
export function wheelNotches(deltaY, deltaMode) {
  const n = -(deltaMode === 1 ? deltaY / 3 : deltaMode === 2 ? deltaY : deltaY / 100);
  return Math.abs(n) >= 0.4 ? Math.sign(n) * Math.max(1, Math.round(Math.abs(n))) : n;
}
