// IMAGE SAMPLER scanner geometry and colour mapping, shared by the DSP kernel
// (imagesampler.dsp.js, audio thread: no DOM here) and the photo editor (imageview.js), so the
// drawn scanner is exactly what plays.
// Coordinates are image pixels (pixel centres 0..width-1, 0..height-1, y down). X / Y (0..100 %)
// place the scanner's centre on the image, Length (0..100 %) is a share of the image diagonal,
// angles are degrees counterclockwise on screen (0 = horizontal, start on the left).
// Every voice runs over the scanner from its start to its end once per cycle of its note (Line,
// Propellor), or once around it (counterclockwise on screen; a closed path, so the cycle has no
// jump back): Oval from the end of the Width axis, Rectangle from the middle of its Width side
// (X / Y centre, Width / Height / Rotation as the Oval), Triangle from corner 1 to 2 to 3 and back
// (corners at X1 / Y1, X2 / Y2, X3 / Y3 in % of the image). The polygons run at an even speed
// along their edges (progress = share of the perimeter).
export const SCAN_TYPES = ['Line', 'Propellor', 'Oval', 'Triangle', 'Rectangle'];
export const SCAN = { LINE: 0, PROPELLOR: 1, OVAL: 2, TRIANGLE: 3, RECTANGLE: 4 };
// the types sized by Width / Height / Rotation
export const sized = (type) => type === SCAN.OVAL || type === SCAN.RECTANGLE;
export const TRI = ['triX1', 'triY1', 'triX2', 'triY2', 'triX3', 'triY3'];
export const TRI_DEFAULT = [50, 15, 15, 85, 85, 85];

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

// Rectangle corners (px) for a closed path: starts in the middle of the Width side (local (a, 0),
// rotated by `deg` counterclockwise like the oval), then counterclockwise on screen.
// Returns { xs, ys } with 5 points (the path closes back to the first).
export function rectCorners(cx, cy, a, b, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const lx = [a, a, -a, -a, a];
  const ly = [0, b, b, -b, -b];
  return { xs: lx.map((x, i) => cx + x * c - ly[i] * s), ys: lx.map((x, i) => cy - (x * s + ly[i] * c)) };
}

// Triangle corners (px) from the X1..Y3 controllers (% of the image): { xs, ys }
export function triCorners(v, w, h) {
  const c = (id, i) => Math.min(100, Math.max(0, Number(v[id] ?? TRI_DEFAULT[i]) || 0)) / 100;
  const W = Math.max(0, w - 1);
  const H = Math.max(0, h - 1);
  return { xs: [c(TRI[0], 0) * W, c(TRI[2], 2) * W, c(TRI[4], 4) * W], ys: [c(TRI[1], 1) * H, c(TRI[3], 3) * H, c(TRI[5], 5) * H] };
}

// A closed polygon through xs / ys, walked at an even speed: { length, at(u, out) } where at writes
// the point at progress u (0..1 of the perimeter, wraps) into out[0], out[1]. Zero length: the
// first corner.
export function polyPath(xs, ys) {
  const n = xs.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
  }
  const length = cum[n];
  return {
    length,
    at(u, out) {
      if (!(length > 0)) { out[0] = xs[0]; out[1] = ys[0]; return out; }
      const d = (u - Math.floor(u)) * length;
      let i = 0;
      while (i < n - 1 && cum[i + 1] <= d) i++;
      const seg = cum[i + 1] - cum[i];
      const f = seg > 0 ? (d - cum[i]) / seg : 0;
      const j = (i + 1) % n;
      out[0] = xs[i] + (xs[j] - xs[i]) * f;
      out[1] = ys[i] + (ys[j] - ys[i]) * f;
      return out;
    },
  };
}

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
