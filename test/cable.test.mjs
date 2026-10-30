import assert from 'node:assert/strict';
import { midpoint, arrowPath, curvePath, samplePoints } from '../src/cable.js';
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
assert.ok(curvePath({ x: 0, y: 0 }, { x: 10, y: 10 }).startsWith('M0,0 C'));

// points along the curve for the audio scope: evenly spaced, from a to b, unit normals
{
  const a = { x: 10, y: 20 }, b = { x: 400, y: 260 };
  const p = samplePoints(a, b, 3);
  near(p.x[0], 10); near(p.y[0], 20); near(p.x[p.n - 1], 400, 1e-3); near(p.y[p.n - 1], 260, 1e-3);
  const gaps = [];
  for (let i = 1; i < p.n; i++) gaps.push(Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]));
  assert.ok(Math.max(...gaps) < 3.1 && Math.min(...gaps) > 2.7, `even spacing ${Math.min(...gaps)}..${Math.max(...gaps)}`);
  for (let i = 0; i < p.n; i++) near(Math.hypot(p.nx[i], p.ny[i]), 1, 1e-5);
  near(p.nx[0], 0, 1e-6); near(Math.abs(p.ny[0]), 1, 1e-6); // leaves the port horizontally
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
