import assert from 'node:assert/strict';
import { clampZoom, defaultCam, validCam, toWorld, toScreen, zoomAt, fitBox, clampCam, ZOOM_MIN, ZOOM_MAX } from '../src/camera.js';

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

// pan limit: the modules may go almost out of view, but 40 px of them stay inside on each side
{
  const box = { l: 0, t: 0, r: 400, b: 200 };
  // panning the view down (modules move up): the lowest module's bottom edge stops 40 px below the top
  const up = clampCam({ x: 100, y: -9000, z: 1 }, box, 800, 600);
  assert.equal(up.y + box.b, 40);
  // panning up (modules move down): the top edge stops 40 px above the bottom
  const down = clampCam({ x: 100, y: 9000, z: 1 }, box, 800, 600);
  assert.equal(down.y + box.t, 600 - 40);
  const left = clampCam({ x: -9000, y: 100, z: 1 }, box, 800, 600);
  assert.equal(left.x + box.r, 40, 'the rightmost edge stops 40 px inside the left side');
  const right = clampCam({ x: 9000, y: 100, z: 1 }, box, 800, 600);
  assert.equal(right.x + box.l, 800 - 40, 'the leftmost edge stops 40 px inside the right side');
  // free panning anywhere in between, also with most of the modules off screen
  for (const c of [{ x: 100, y: 50, z: 1 }, { x: -300, y: -100, z: 1 }, { x: 700, y: 500, z: 1 }]) {
    assert.deepEqual(clampCam(c, box, 800, 600), c);
  }
  // zoom is respected: at 50 % the box is half as large on screen
  const half = clampCam({ x: 0, y: -9000, z: 0.5 }, box, 800, 600);
  assert.equal(half.y + box.b * 0.5, 40);
  assert.equal(half.z, 0.5, 'zoom is kept');
  const ok = { x: 100, y: 50, z: 1 };
  assert.deepEqual(clampCam(ok, null, 800, 600), ok, 'no modules: free panning');
}

// Non-finite zoom (bad wheel delta) falls back to 100 % instead of NaN.
assert.equal(clampZoom(NaN), 1);
assert.equal(clampZoom(Infinity), 1);
