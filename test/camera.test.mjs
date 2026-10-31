import assert from 'node:assert/strict';
import { clampZoom, defaultCam, validCam, toWorld, toScreen, zoomAt, fitBox, ZOOM_MIN, ZOOM_MAX } from '../src/camera.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// round trip
const cam = { x: 120, y: -40, z: 1.7 };
const w = toWorld(cam, 300, 200);
const s = toScreen(cam, w.x, w.y);
near(s.x, 300); near(s.y, 200);

// zooming keeps the point under the cursor fixed
for (const f of [1.15, 1 / 1.15, 4, 0.01]) {
  const z = zoomAt(cam, 300, 200, f);
  const w2 = toWorld(z, 300, 200);
  near(w2.x, w.x); near(w2.y, w.y);
  assert.ok(z.z >= ZOOM_MIN && z.z <= ZOOM_MAX);
}
assert.equal(zoomAt(cam, 0, 0, 100).z, ZOOM_MAX);
assert.equal(zoomAt(cam, 0, 0, 0.0001).z, ZOOM_MIN);

// validation of persisted cameras
assert.deepEqual(validCam(undefined), defaultCam());
assert.deepEqual(validCam({ x: 1, y: 2, z: NaN }), defaultCam());
assert.deepEqual(validCam({ x: 1, y: 2, z: 99 }), { x: 1, y: 2, z: ZOOM_MAX });

// fit: box centred, never zoomed in beyond 1
const f = fitBox({ l: 1000, t: 500, r: 1200, b: 600 }, 800, 600);
assert.equal(f.z, 1);
const c = toWorld(f, 400, 300);
near(c.x, 1100); near(c.y, 550);
const big = fitBox({ l: 0, t: 0, r: 4000, b: 1000 }, 800, 600, { margin: 0 });
near(big.z, 0.2);

console.log('camera tests passed');

// Non-finite zoom (bad wheel delta) falls back to 100 % instead of NaN.
assert.equal(clampZoom(NaN), 1);
assert.equal(clampZoom(Infinity), 1);
