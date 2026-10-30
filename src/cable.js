// Cable geometry (world coordinates). A cable is a straight line from the centre of the source
// module to the centre of the destination module. The boxes are drawn over the cables, so the
// visible part runs from box edge to box edge (visibleSegment); the direction arrow and the live
// audio wave (cablescope.js) sit on that visible part.

export function linePath(a, b) {
  return `M${a.x},${a.y} L${b.x},${b.y}`;
}

// Centre of a box { x, y, w, h }.
export const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

// Where the ray from the centre of box `r` towards point `p` leaves the box (plus `gap` px).
export function edgePoint(r, p, gap = 0) {
  const c = centerOf(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return c;
  const hw = r.w / 2 + gap;
  const hh = r.h / 2 + gap;
  const s = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

// Visible part of a cable between boxes ra -> rb (rb may be null: a point, e.g. the pointer while
// dragging a new cable). When the boxes overlap (nothing visible) it is the centre-to-centre line.
export function visibleSegment(ra, rb, to = centerOf(rb)) {
  const a = centerOf(ra);
  const from = edgePoint(ra, to);
  const end = rb ? edgePoint(rb, a) : to;
  const along = (p) => (p.x - a.x) * (to.x - a.x) + (p.y - a.y) * (to.y - a.y);
  if (along(end) <= along(from)) return { from: a, to };
  return { from, to: end };
}

// Middle of the straight segment and its unit direction.
export function midpoint(a, b) {
  let tx = b.x - a.x;
  let ty = b.y - a.y;
  const len = Math.hypot(tx, ty);
  if (len < 1e-9) { tx = 1; ty = 0; } else { tx /= len; ty /= len; }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, tx, ty };
}

// Arrowhead (closed triangle path) centred on the segment's midpoint, pointing from a to b.
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

// Points along the segment about `step` world px apart, from a to b, with the unit normal:
// { n, x: Float32Array, y, nx, ny }. Used by the audio scope drawn on the cable (cablescope.js).
export function samplePoints(a, b, step = 3) {
  const { tx, ty } = midpoint(a, b);
  const total = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.ceil(total / step) + 1);
  const out = { n, x: new Float32Array(n), y: new Float32Array(n), nx: new Float32Array(n), ny: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.x[i] = a.x + (b.x - a.x) * t;
    out.y[i] = a.y + (b.y - a.y) * t;
    out.nx[i] = -ty;
    out.ny[i] = tx;
  }
  return out;
}
