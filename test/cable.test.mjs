import assert from 'node:assert/strict';
import { midpoint, arrowPath, linePath, samplePoints, edgePoint, visibleSegment, centerOf } from '../src/cable.js';
import { Ring, displace, scopePath, AMP } from '../src/cablescope.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const tipOf = (d) => d.match(/^M([-\d.]+),([-\d.]+)/).slice(1).map(Number);

// straight left-to-right cable: midpoint in the middle, arrow points right
let m = midpoint({ x: 0, y: 0 }, { x: 200, y: 0 });
near(m.x, 100); near(m.y, 0); near(m.tx, 1); near(m.ty, 0);
assert.deepEqual(tipOf(arrowPath({ x: 0, y: 0 }, { x: 200, y: 0 })), [107, 0]);

// reversed: arrow points left
m = midpoint({ x: 200, y: 0 }, { x: 0, y: 0 });
near(m.x, 100); assert.ok(m.tx < 0);
assert.ok(tipOf(arrowPath({ x: 200, y: 0 }, { x: 0, y: 0 }))[0] < 100);

// vertical-ish cable: tangent points from a towards b, unit length
m = midpoint({ x: 0, y: 0 }, { x: 0, y: 300 });
near(Math.hypot(m.tx, m.ty), 1); assert.ok(m.ty > 0); near(m.y, 150);

// degenerate (same point) does not produce NaN
assert.ok(!arrowPath({ x: 5, y: 5 }, { x: 5, y: 5 }).includes('NaN'));
assert.equal(linePath({ x: 0, y: 0 }, { x: 10, y: 10 }), 'M0,0 L10,10', 'a straight line');

// centre to centre: the visible part runs from box edge to box edge
{
  const A = { x: 0, y: 0, w: 100, h: 40 }; // centre 50,20
  const B = { x: 300, y: 0, w: 100, h: 40 }; // centre 350,20
  assert.deepEqual(centerOf(A), { x: 50, y: 20 });
  assert.deepEqual(visibleSegment(A, B), { from: { x: 100, y: 20 }, to: { x: 300, y: 20 } });
  const C = { x: 0, y: 200, w: 100, h: 40 }; // straight below A
  assert.deepEqual(visibleSegment(A, C), { from: { x: 50, y: 40 }, to: { x: 50, y: 200 } });
  // diagonal: leaves through the edge the ray crosses first, stays on the centre line
  const D = { x: 400, y: 300, w: 100, h: 40 }; // centre 450,320
  const s = visibleSegment(A, D);
  near(s.from.y, 40); near(s.from.x, 50 + 400 * (20 / 300)); // bottom edge of A (flat box)
  near(s.to.y, 300); // top edge of D
  const cross = (p) => (p.x - 50) * 300 - (p.y - 20) * 400;
  near(cross(s.from), 0, 1e-6); near(cross(s.to), 0, 1e-6);
  // overlapping boxes: nothing visible, fall back to the centre line (no NaN, no reversed arrow)
  const o = visibleSegment(A, { x: 20, y: 10, w: 100, h: 40 });
  assert.deepEqual(o, { from: { x: 50, y: 20 }, to: { x: 70, y: 30 } });
  // a point instead of a box (dragging a new cable to the pointer)
  assert.deepEqual(visibleSegment(A, null, { x: 50, y: 120 }), { from: { x: 50, y: 40 }, to: { x: 50, y: 120 } });
  assert.deepEqual(visibleSegment(A, null, { x: 60, y: 25 }), { from: { x: 50, y: 20 }, to: { x: 60, y: 25 } }, 'pointer inside the box');
  assert.deepEqual(edgePoint(A, { x: 50, y: 20 }), { x: 50, y: 20 }, 'degenerate');
}

// points along the cable for the audio scope: evenly spaced, from a to b, unit normals
{
  const a = { x: 10, y: 20 }, b = { x: 400, y: 260 };
  const p = samplePoints(a, b, 3);
  near(p.x[0], 10); near(p.y[0], 20); near(p.x[p.n - 1], 400, 1e-3); near(p.y[p.n - 1], 260, 1e-3);
  const gaps = [];
  for (let i = 1; i < p.n; i++) gaps.push(Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]));
  assert.ok(Math.max(...gaps) < 3.1 && Math.min(...gaps) > 2.7, `even spacing ${Math.min(...gaps)}..${Math.max(...gaps)}`);
  for (let i = 0; i < p.n; i++) near(Math.hypot(p.nx[i], p.ny[i]), 1, 1e-5);
  // a straight line: every point on it, one normal for all
  for (let i = 0; i < p.n; i++) {
    near((p.x[i] - 10) * 240 - (p.y[i] - 20) * 390, 0, 0.5);
    near(p.nx[i], p.nx[0]); near(p.ny[i], p.ny[0]);
  }
  near(p.nx[0] * 390 + p.ny[0] * 240, 0, 1e-4); // perpendicular to the cable
  const z = samplePoints({ x: 5, y: 5 }, { x: 5, y: 5 });
  assert.ok(z.n >= 2 && [...z.x, ...z.y, ...z.nx, ...z.ny].every(Number.isFinite), 'degenerate cable');
}

// scope ring: newest value first, quiet count; displacement pinned to the ports
{
  const r = new Ring(8);
  assert.equal(r.quiet, 8);
  [1, 2, 3].forEach((v) => r.push(v / 10));
  near(r.at(0), 0.3); near(r.at(2), 0.1); assert.equal(r.at(3), 0); assert.equal(r.at(99), 0);
  assert.equal(r.quiet, 0);
  for (let i = 0; i < 10; i++) r.push(0);
  assert.equal(r.quiet, 8);
  assert.equal(displace(1, 0, 100), 0); assert.equal(displace(1, 99, 100), 0);
  assert.ok(displace(1, 50, 100) > 0.8 * AMP && displace(-1, 50, 100) < -0.8 * AMP);
  assert.ok(displace(100, 50, 100) <= AMP, 'soft clipped');
  const pts = samplePoints({ x: 0, y: 0 }, { x: 300, y: 0 });
  const ring = new Ring();
  for (let i = 0; i < 200; i++) ring.push(i % 2 ? 0.5 : -0.5);
  const d = scopePath(pts, ring);
  const ys = [...d.matchAll(/[ML][-\d.]+,([-\d.]+)/g)].map((m) => +m[1]);
  assert.equal(ys.length, pts.n);
  assert.ok(Math.max(...ys) > 4 && Math.min(...ys) < -4 && ys[0] === 0, 'the wave runs along the cable');
}

console.log('cable tests passed');
