import assert from 'node:assert/strict';
import { CLIP_H, clipsOverlap, findClipPosition, clipResizeBounds } from '../src/seq/clipplacement.js';

const clip = (start, length, y = 0) => ({ start, length, y });
const distance = (a, b, ppq) => ((a.start - b.start) * ppq) ** 2 + (a.y - b.y) ** 2;
const free = (moving, others) => others.every((c) => !clipsOverlap(moving, c));

// Contact is legal on all four edges; a partial vertical overlap is still a collision.
{
  const a = clip(4, 4, 34);
  for (const b of [clip(0, 4, 34), clip(8, 4, 34), clip(4, 4, 0), clip(4, 4, 68)]) {
    assert.equal(clipsOverlap(a, b), false);
  }
  assert.equal(clipsOverlap(a, clip(7.99, 1, 67.99)), true);
}

// Prefer the closest edge measured in pixels at the current zoom, not always right or down.
{
  const source = clip(0, 4);
  const copy = clip(0, 4);
  assert.deepEqual(findClipPosition([source, copy], copy, {}, 16), { start: 0, y: CLIP_H });
  assert.deepEqual(findClipPosition([source, copy], copy, {}, 4), { start: 4, y: 0 });
  assert.deepEqual(findClipPosition([source, copy], copy, { start: 3.5 }, 16), { start: 4, y: 0 });
  assert.deepEqual(findClipPosition([source, copy], copy, { y: 30 }, 16), { start: 0, y: 34 });
  const later = clip(5, 4);
  assert.deepEqual(findClipPosition([later, copy], copy, { start: 1.25 }, 16), { start: 1, y: 0 });
  assert.deepEqual(findClipPosition([later, copy], copy, { start: 1, y: 34 }, 16), { start: 1, y: 34 });
  assert.deepEqual(findClipPosition([copy], copy, { start: -2, y: -10 }, 16), { start: -2, y: 0 }, 'clips may start before zero; lanes start at 0');
  assert.deepEqual(findClipPosition([copy], copy, { start: 1, y: 50 }, 16), { start: 1, y: 34 }, 'y snaps to the nearest lane');
  assert.deepEqual(findClipPosition([copy], copy, { start: 1, y: 52 }, 16), { start: 1, y: 68 });
  // a blocker at 0 pushes the clip left into negative time when that is closer
  assert.deepEqual(findClipPosition([clip(0, 4), copy], copy, { start: -1 }, 4), { start: -4, y: 0 });
}

// Find a diagonal gap between blockers instead of resolving against only the first collision.
{
  const moving = clip(0, 2);
  const others = [clip(0, 3, 0), clip(3, 4, 34), clip(0, 7, 68)];
  const wanted = { start: 2, y: 25 };
  const result = findClipPosition(others, moving, wanted, 16);
  assert.deepEqual(result, { start: 1, y: 34 });
  assert.ok(free({ ...moving, ...result }, others));
}

// A gap exactly one clip wide is legal, including non-grid edges.
{
  const moving = clip(0, 2);
  const others = [clip(0, 1.3), clip(3.3, 4)];
  const result = findClipPosition(others, moving, { start: 1.5 }, 16);
  assert.deepEqual(result, { start: 1.3, y: 0 });
  assert.ok(free({ ...moving, ...result }, others));
  const third = clip(7.3, 5);
  const crowded = [...others, third];
  assert.ok(free({ ...moving, ...findClipPosition(crowded, moving, { start: 6 }, 16) }, crowded));
}

// Triplet contact does not create tiny numerical overlaps.
{
  const moving = clip(0, 0.333333333);
  const others = [clip(0, 0.666666667), clip(1, 1)];
  const result = findClipPosition(others, moving, { start: 0.75 }, 100);
  assert.deepEqual(result, { start: 0.666666667, y: 0 });
  assert.ok(free({ ...moving, ...result }, others));
}

// Bounds use the neighbours on the same lane, ignoring clips on other lanes.
{
  const moving = clip(4, 4, 34);
  const others = [moving, clip(1, 2, 0), clip(2, 2, 34), clip(10, 1, 34), clip(8, 2, 68)];
  assert.deepEqual(clipResizeBounds(others, moving), { start: 4, end: 10 });
  assert.deepEqual(clipResizeBounds([moving], moving), { start: -Infinity, end: Infinity }, 'trimming may reach before zero');
}

// Compare against an exhaustive independent search on integer geometry. Every optimum
// lies on integer coordinates here, so this checks true nearest placement, not just no overlap.
{
  let seed = 12345;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let run = 0; run < 80; run++) {
    const others = Array.from({ length: 5 }, () => clip(random(12), 1 + random(5), random(3) * CLIP_H));
    const moving = clip(random(12), 1 + random(4), random(3) * CLIP_H);
    const ppq = 1 + random(20);
    const before = structuredClone(others);
    const result = findClipPosition([...others, moving], moving, {}, ppq);
    assert.ok(result.y >= 0 && result.y % CLIP_H === 0, 'on a lane');
    assert.ok(free({ ...moving, ...result }, others));
    let nearest = Infinity;
    for (let start = -20; start <= 20; start++) {
      for (let y = 0; y <= 6 * CLIP_H; y += CLIP_H) {
        if (others.some((c) => start < c.start + c.length && start + moving.length > c.start
          && y < c.y + CLIP_H && y + CLIP_H > c.y)) continue;
        nearest = Math.min(nearest, distance({ start, y }, moving, ppq));
      }
    }
    assert.equal(distance(result, moving, ppq), nearest, `nearest position in case ${run}`);
    assert.deepEqual(others, before);
  }
}

console.log('clip placement tests passed');
