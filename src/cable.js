// Cable geometry (world coordinates). A cable is a horizontal-ish cubic Bézier from an
// out port to an in port, with a direction arrow at its midpoint.

export function controlPoints(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
}

export function curvePath(a, b) {
  const [, c1, c2] = controlPoints(a, b);
  return `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
}

// Point and unit tangent at t = 0.5 of the cubic.
export function midpoint(a, b) {
  const [p0, p1, p2, p3] = controlPoints(a, b);
  const x = (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8;
  const y = (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8;
  let tx = p3.x + p2.x - p1.x - p0.x;
  let ty = p3.y + p2.y - p1.y - p0.y;
  const len = Math.hypot(tx, ty);
  if (len < 1e-9) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
  return { x, y, tx, ty };
}

// Arrowhead (closed triangle path) centred on the cable midpoint, pointing from a to b.
export function arrowPath(a, b, size = 7) {
  const { x, y, tx, ty } = midpoint(a, b);
  const nx = -ty;
  const ny = tx;
  const tip = { x: x + tx * size, y: y + ty * size };
  const bx = x - tx * size;
  const by = y - ty * size;
  const w = size * 0.85;
  const f = (n) => Math.round(n * 100) / 100;
  return `M${f(tip.x)},${f(tip.y)} L${f(bx + nx * w)},${f(by + ny * w)} L${f(bx - nx * w)},${f(by - ny * w)} Z`;
}

// Points along the cable about `step` world px apart, from a to b, with unit normals:
// { n, x: Float32Array, y, nx, ny }. Used by the audio scope drawn on the cable (cablescope.js).
export function samplePoints(a, b, step = 3) {
  const [p0, p1, p2, p3] = controlPoints(a, b);
  const at = (t) => {
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    return [w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x, w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y];
  };
  // arc length table, then resample at equal distances
  const K = 64;
  const len = new Float64Array(K + 1);
  let [px, py] = at(0);
  for (let i = 1; i <= K; i++) {
    const [x, y] = at(i / K);
    len[i] = len[i - 1] + Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  const total = len[K];
  const n = Math.max(2, Math.ceil(total / step) + 1);
  const out = { n, x: new Float32Array(n), y: new Float32Array(n), nx: new Float32Array(n), ny: new Float32Array(n) };
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = (total * i) / (n - 1);
    while (k < K - 1 && len[k + 1] < d) k++;
    const seg = len[k + 1] - len[k];
    const t = (k + (seg > 1e-9 ? (d - len[k]) / seg : 0)) / K;
    const [x, y] = at(t);
    const u = 1 - t;
    let tx = 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
    let ty = 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
    const l = Math.hypot(tx, ty);
    if (l < 1e-9) { tx = b.x - a.x; ty = b.y - a.y; }
    const l2 = Math.hypot(tx, ty) || 1;
    out.x[i] = x;
    out.y[i] = y;
    out.nx[i] = -ty / l2;
    out.ny[i] = tx / l2;
  }
  return out;
}
