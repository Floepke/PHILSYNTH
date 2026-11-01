// Transfer curve of the WAVESHAPER (also the ENVELOPE shape over time): points {x, y, r} in 0..1, sorted by x, the first at x=0 and
// the last at x=1. Straight lines between points; an inner point with rounding r > 0 has its
// corner replaced by a quadratic Bézier that starts/ends r/2 of the way along its two segments
// (r = 1: the curve touches the midpoints of both segments, so neighbours never overlap).
export const MIN_GAP = 0.002; // smallest x distance between points
// rounding of a point inserted by double-click in any curve editor (waveshaper, velocity, automation): fully round
export const NEW_POINT_ROUND = 1;

export const defaultCurve = () => ({ points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] });
// ENVELOPE default: a quick rise and a rounded fall back to 0
export const defaultEnvelope = () => ({ points: [{ x: 0, y: 0, r: 0 }, { x: 0.1, y: 1, r: 0.5 }, { x: 1, y: 0, r: 0 }] });

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Repairs anything loaded from a file: sorted, inside 0..1, fixed endpoints, at least 2 points.
export function normalizeCurve(c) {
  let pts = (Array.isArray(c?.points) ? c.points : [])
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y), r: clamp01(+p.r || 0) }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) return defaultCurve();
  pts[0].x = 0;
  pts.at(-1).x = 1;
  pts = pts.filter((p, i) => i === 0 || i === pts.length - 1 || (p.x - pts[i - 1].x >= MIN_GAP && 1 - p.x >= MIN_GAP));
  pts[0].r = pts.at(-1).r = 0;
  return { points: pts };
}

// Dense polyline [x0, y0, x1, y1, ...] of the curve, x increasing.
export function curvePolyline(points, steps = 24) {
  const out = [];
  points.forEach((p, i) => {
    if (i === 0 || i === points.length - 1 || !p.r) { out.push(p.x, p.y); return; }
    const a = points[i - 1];
    const b = points[i + 1];
    const k = p.r / 2;
    const ax = p.x + (a.x - p.x) * k, ay = p.y + (a.y - p.y) * k;
    const bx = p.x + (b.x - p.x) * k, by = p.y + (b.y - p.y) * k;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      out.push(u * u * ax + 2 * u * t * p.x + t * t * bx, u * u * ay + 2 * u * t * p.y + t * t * by);
    }
  });
  return out;
}

// y of the polyline at x (linear interpolation)
export function sampleAt(poly, x) {
  const n = poly.length / 2;
  if (x <= poly[0]) return poly[1];
  if (x >= poly[(n - 1) * 2]) return poly[(n - 1) * 2 + 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (poly[mid * 2] <= x) lo = mid; else hi = mid;
  }
  const x0 = poly[lo * 2], x1 = poly[hi * 2];
  const y0 = poly[lo * 2 + 1], y1 = poly[hi * 2 + 1];
  return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
}

// The curve as y over evenly spaced x 0..1 (`size` values, the ENVELOPE's time table).
export function curveSamples({ points }, size = 1024) {
  const poly = curvePolyline(points);
  const t = new Float32Array(size);
  for (let i = 0; i < size; i++) t[i] = sampleAt(poly, i / (size - 1));
  return t;
}

// Lookup table for a WaveShaperNode: input -1..1 -> output -1..1.
//   symmetric: the graph covers |input| 0..1 and is mirrored for negative input (odd harmonics)
//   otherwise: the graph covers the full -1..1 input and output range (can be asymmetric)
export function curveTable({ points }, symmetric, size = 4096) {
  const poly = curvePolyline(points);
  const t = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const u = -1 + (2 * i) / (size - 1);
    t[i] = symmetric ? Math.sign(u) * sampleAt(poly, Math.abs(u)) : sampleAt(poly, (u + 1) / 2) * 2 - 1;
  }
  return t;
}
