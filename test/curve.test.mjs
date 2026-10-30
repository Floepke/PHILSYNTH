// Run: node test/curve.test.mjs   (WAVESHAPER curve maths)
import assert from 'node:assert/strict';
import { curvePolyline, curveTable, defaultCurve, normalizeCurve, sampleAt } from '../src/curve.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// identity in both ranges
for (const sym of [true, false]) {
  const t = curveTable(defaultCurve(), sym, 1025);
  for (let i = 0; i < t.length; i += 64) close(t[i], -1 + (2 * i) / 1024, 1e-6, `identity (symmetric ${sym})`);
}

// straight segments without rounding
const pts = [{ x: 0, y: 0, r: 0 }, { x: 0.5, y: 1, r: 0 }, { x: 1, y: 0.5, r: 0 }];
const poly = curvePolyline(pts);
close(sampleAt(poly, 0.25), 0.5, 1e-9, 'first segment');
close(sampleAt(poly, 0.75), 0.75, 1e-9, 'second segment');
close(sampleAt(poly, 0.5), 1, 1e-9, 'corner');

// rounding cuts the corner smoothly, stays inside the corner triangle, and only near the corner
const round = curvePolyline(pts.map((p, i) => (i === 1 ? { ...p, r: 1 } : p)));
assert.ok(sampleAt(round, 0.5) < 0.9 && sampleAt(round, 0.5) > 0.7, `rounded corner is lower (${sampleAt(round, 0.5)})`);
close(sampleAt(round, 0.2), 0.4, 1e-9, 'before the rounding: unchanged');
close(sampleAt(round, 0.8), 0.7, 1e-9, 'after the rounding: unchanged');
for (let i = 2; i < round.length; i += 2) assert.ok(round[i] >= round[i - 2], 'x keeps increasing');
// slopes at the cut points match the segments (no kink)
const d = 1e-4;
close((sampleAt(round, 0.25 + d) - sampleAt(round, 0.25)) / d, 2, 0.1, 'tangent at the start of the rounding (chord of the sampled Bézier)');

// symmetric: mirrored, odd; full: whole range
const sym = curveTable({ points: pts }, true, 1001);
close(sym[1000], 0.5, 1e-6, 'symmetric +max');
close(sym[0], -0.5, 1e-6, 'symmetric -max mirrored');
close(sym[750], 1, 1e-6, 'symmetric +0.5 -> peak');
const full = curveTable({ points: pts }, false, 1001);
close(full[0], -1, 1e-6, 'full -max -> bottom');
close(full[500], 1, 1e-6, 'full 0 -> top of the graph');

// normalize: sorts, clamps, fixes end points and gaps, falls back to the identity
const n = normalizeCurve({ points: [{ x: 0.9, y: 2 }, { x: 0.1, y: -1, r: 3 }, { x: 0.5, y: 0.5 }, { x: 0.5005, y: 0.4 }] });
assert.deepEqual(n.points.map((p) => [p.x, p.y, p.r]), [[0, 0, 0], [0.5, 0.5, 0], [1, 1, 0]]);
assert.deepEqual(normalizeCurve(null), defaultCurve());
assert.deepEqual(normalizeCurve({ points: [{ x: 0.3, y: 0.3 }] }), defaultCurve());

console.log('curve tests passed');
