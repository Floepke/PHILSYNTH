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

// Resolution: the number of points read along the scanner per cycle (the waveform is the straight
// lines between them). Point j sits at progress j / points.
export const RES_MIN = 2;
export const RES_MAX = 1024;
export const RES_DEFAULT = 64;
export const resPoints = (v) => Math.min(RES_MAX, Math.max(RES_MIN, Math.round(Number(v) || RES_DEFAULT)));

// Colour byte (0..255) -> -1..1
export const unit = (c) => c / 127.5 - 1;

// Colour channels -> speakers. Each speaker has its own amount of red, green and blue
// (-100..+100 %: + plays the colour as it is, - inverted, 0 = not on that speaker), e.g. red +100 %
// left and -100 % right. Each speaker plays the sum, divided by its total amount when that is above
// 1, so even all three channels at full on one side stay within -1..1, while a single channel keeps
// its amount as volume. Returns { L: [r, g, b], R: [r, g, b] } weights.
export const COLORS = ['red', 'green', 'blue'];
export function colorWeights(p) {
  const amount = (id) => Math.min(100, Math.max(-100, Number(p[id]) || 0)) / 100;
  const side = (s) => {
    const w = COLORS.map((c) => amount(`${c}${s}`));
    const sum = Math.abs(w[0]) + Math.abs(w[1]) + Math.abs(w[2]);
    if (sum > 1) for (let i = 0; i < 3; i++) w[i] /= sum;
    return w;
  };
  return { L: side('Left'), R: side('Right') };
}

// Angle of the scanner (degrees) from the start point to a dragged point, for the Rotation controller
export const angleTo = (cx, cy, x, y) => (Math.atan2(-(y - cy), x - cx) * 180) / Math.PI;

// Degrees wrapped to -180..180
export const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
