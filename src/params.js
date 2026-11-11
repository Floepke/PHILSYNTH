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

// Explicit numbers allow reserved slots without adding dummy controllers to the list.
export const controllerNumber = (p, index) => p.number ?? index;
export const controllerAt = (params, number) => params.find((p, i) => controllerNumber(p, i) === number);

// Mouse-wheel / nudge step: `notches` wheel clicks (fractional for trackpads, + = up).
// One notch moves 1 % of the slider (0.1 % with `fine`); stepped controllers always move at
// least one step so option lists and integers advance one entry per click. A controller with
// p.wheelStep moves exactly that much per notch instead (e.g. BPM: 1 per click), `fine` too.
// p.wheelSingleStep caps accelerated scrolling at one notch per update.
export const WHEEL_COARSE = 0.01;
export const WHEEL_FINE = 0.001;
export function nudge(p, v, notches, fine = false) {
  if (!notches) return v;
  if (p.wheelSingleStep) notches = Math.sign(Math.round(notches));
  if (p.wheelStep) return Math.min(p.max, Math.max(p.min, +(v + Math.round(notches) * p.wheelStep).toFixed(6)));
  const next = fromNorm(p, toNorm(p, v) + notches * (fine ? WHEEL_FINE : WHEEL_COARSE));
  if (p.step && next === v) return Math.min(p.max, Math.max(p.min, +(v + Math.sign(notches) * p.step).toFixed(6)));
  return next;
}

// Fixed values a controller snaps to, depending on the other controllers: p.snapValues(values)
// returns an ascending list (or null: continuous). E.g. LFO Frequency with a synced Frequency Unit.
// The value of `list` nearest to v on the slider (log controllers: by ratio).
export function snapNearest(p, list, v) {
  const x = toNorm(p, v);
  return list.reduce((best, s) => (Math.abs(toNorm(p, s) - x) < Math.abs(toNorm(p, best) - x) ? s : best));
}
// `notches` whole wheel clicks along `list` (a value between two entries first goes to the next one)
export function snapStep(list, v, notches) {
  const n = Math.round(notches);
  if (!n) return v;
  let i = n > 0 ? list.findIndex((s) => s > v + 1e-9) - 1 : list.findIndex((s) => s >= v - 1e-9);
  if (n > 0 && i === -2) i = list.length - 1;
  if (n < 0 && i === -1) i = list.length;
  return list[Math.min(list.length - 1, Math.max(0, i + n))];
}

// Wheel deltas as finite numbers. Firefox on macOS can deliver non-finite deltas (some
// trackpad / smooth-scrolling mouse events); a NaN would poison zoom and scroll positions.
const finite = (v) => (Number.isFinite(v) ? v : 0);
export const wheelDelta = (e) => ({ dx: finite(e.deltaX), dy: finite(e.deltaY), mode: e.deltaMode });

// Wheel event -> notches (positive = scroll up). Mouse wheels give one big delta per click
// (Chrome ±100/120 px, Firefox 3 lines or ~50 px); trackpads give many small pixel deltas.
export function wheelNotches(deltaY, deltaMode) {
  deltaY = finite(deltaY);
  const n = -(deltaMode === 1 ? deltaY / 3 : deltaMode === 2 ? deltaY : deltaY / 100);
  return Math.abs(n) >= 0.4 ? Math.sign(n) * Math.max(1, Math.round(Math.abs(n))) : n;
}

// Wheel events -> notches to apply now. macOS reports a slow mouse-wheel click as a tiny pixel
// delta (a few px, only fast scrolling is accelerated to big deltas), so an event after a pause
// counts as at least one whole notch. Trackpads send a dense stream (~16 ms apart) whose small
// deltas add up as before. whole: only whole notches are returned (stepped values), the rest waits.
// Some Linux (Wayland) setups deliver one wheel click as a burst of two or more notch-sized
// events a few ms apart; for whole steps those count once (one click = one option / step).
//   const take = wheelAccumulator({ whole });  const n = take(e, delta);  if (n) ...
export const WHEEL_PAUSE_MS = 50;
export const WHEEL_BURST_MS = 30;
export function wheelAccumulator({ whole = false } = {}) {
  let acc = 0;
  let last = -Infinity;
  let lastStep = -Infinity;
  return (e, delta = e.deltaY) => {
    let n = wheelNotches(delta, e.deltaMode);
    if (whole && Math.abs(n) >= 1 && e.timeStamp - lastStep < WHEEL_BURST_MS) {
      last = e.timeStamp;
      return 0; // the rest of the click that just stepped
    }
    if (e.timeStamp - last > WHEEL_PAUSE_MS) {
      if (Math.sign(n) !== Math.sign(acc)) acc = 0; // a new gesture forgets leftovers of the other way
      if (n && Math.abs(n) < 1) n = Math.sign(n);
    }
    last = e.timeStamp;
    acc += n;
    const out = whole ? Math.trunc(acc) : acc;
    acc -= out;
    if (out && Math.abs(n) >= 1) lastStep = e.timeStamp;
    return out;
  };
}
