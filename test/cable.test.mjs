import assert from 'node:assert/strict';
import { midpoint, arrowPath, curvePath } from '../src/cable.js';

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

console.log('cable tests passed');
