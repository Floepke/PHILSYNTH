// IMAGE SAMPLER scanner geometry and colour mapping, shared by the DSP kernel
// (imagesampler.dsp.js, audio thread: no DOM here) and the photo editor (imageview.js), so the
// drawn scanner is exactly what plays.
// Coordinates are image pixels (pixel centres 0..width-1, 0..height-1, y down). X / Y (0..100 %)
// place the scanner's centre on the image, Length (0..100 %) is a share of the image diagonal,
// angles are degrees counterclockwise on screen (0 = horizontal, start on the left).
// Every voice runs over the scanner from its start to its end once per cycle of its note (Line,
// Propellor), or once around it (Oval: counterclockwise on screen, from the end of the Width axis;
// a closed path, so the cycle has no jump back).
export const SCAN_TYPES = ['Line', 'Propellor', 'Oval'];
export const SCAN = { LINE: 0, PROPELLOR: 1, OVAL: 2 };

export const diagonal = (w, h) => Math.hypot(Math.max(0, w - 1), Math.max(0, h - 1));

// Centre (px) and length (px) of the scanner from the X / Y / Length controllers
export function scanCenter(x, y, length, w, h) {
  const c = (v) => Math.min(100, Math.max(0, Number(v) || 0)) / 100;
  return { cx: c(x) * Math.max(0, w - 1), cy: c(y) * Math.max(0, h - 1), len: c(length) * diagonal(w, h) };
}

// Start / end point of the scanner at angle `deg`
export function scanEnds({ cx, cy, len }, deg) {
  const a = (deg * Math.PI) / 180;
  const dx = (Math.cos(a) * len) / 2;
  const dy = (-Math.sin(a) * len) / 2;
  return { x0: cx - dx, y0: cy - dy, x1: cx + dx, y1: cy + dy };
}

// Oval: semi-axes (px) from Width (% of the image width) and Height (% of the image height)
export function ovalAxes(width, height, w, h) {
  const c = (v) => Math.min(100, Math.max(0, Number(v) || 0)) / 100;
  return { a: (c(width) * Math.max(0, w - 1)) / 2, b: (c(height) * Math.max(0, h - 1)) / 2 };
}

// Point of the oval at progress u (0..1 = once around), rotated by `deg` (counterclockwise)
export function ovalPoint(cx, cy, a, b, deg, u) {
  const t = 2 * Math.PI * u;
  const r = (deg * Math.PI) / 180;
  const lx = a * Math.cos(t);
  const ly = b * Math.sin(t);
  return { x: cx + lx * Math.cos(r) - ly * Math.sin(r), y: cy - (lx * Math.sin(r) + ly * Math.cos(r)) };
}

// Perimeter of an ellipse (Ramanujan), for the anti-aliasing (pixels per cycle)
export const ovalPerimeter = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt(Math.max(0, (3 * a + b) * (a + 3 * b))));

// Colour byte (0..255) -> -1..1
export const unit = (c) => c / 127.5 - 1;

// Colour channels -> speakers. Every channel (red, green, blue) has a Pan (-100 = left .. +100 =
// right, equal-gain: (1 -/+ pan) / 2 to each side) and a Level (-100..+100 %, negative inverts it).
// Each speaker plays the sum of what it gets, divided by the total weight it gets when that is
// above 1, so even all three channels at full level on one side stay within -1..1, while a single
// channel keeps its level as volume. Returns { L: [r, g, b], R: [r, g, b] } weights.
export const COLORS = ['red', 'green', 'blue'];
export function colorWeights(p) {
  const L = [0, 0, 0];
  const R = [0, 0, 0];
  COLORS.forEach((c, i) => {
    const pan = Math.min(100, Math.max(-100, Number(p[`${c}Pan`]) || 0)) / 100;
    const lvl = Math.min(100, Math.max(-100, Number(p[`${c}Level`]) || 0)) / 100;
    L[i] = lvl * (1 - pan) / 2;
    R[i] = lvl * (1 + pan) / 2;
  });
  const norm = (w) => {
    const sum = Math.abs(w[0]) + Math.abs(w[1]) + Math.abs(w[2]);
    if (sum > 1) for (let i = 0; i < 3; i++) w[i] /= sum;
    return w;
  };
  return { L: norm(L), R: norm(R) };
}

// Angle of the scanner (degrees) from the start point to a dragged point, for the Rotation controller
export const angleTo = (cx, cy, x, y) => (Math.atan2(-(y - cy), x - cx) * 180) / Math.PI;

// Degrees wrapped to -180..180
export const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
