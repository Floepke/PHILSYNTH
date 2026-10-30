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
