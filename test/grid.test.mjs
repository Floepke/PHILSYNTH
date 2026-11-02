// Run: node test/grid.test.mjs   (patcher Snap to Grid)
import assert from 'node:assert/strict';
import { GRID, snapToGrid } from '../src/grid.js';

assert.equal(GRID, 40, 'one module high');
assert.equal(snapToGrid(0), 0);
assert.equal(snapToGrid(19), 0);
assert.equal(snapToGrid(20), 40);
assert.equal(snapToGrid(61), 80);
assert.equal(snapToGrid(-21), -40, 'left / above the origin too');
assert.equal(snapToGrid(-19) + 0, 0);
assert.equal(snapToGrid(61.4, false), 61, 'off: whole pixels, as before');
console.log('grid tests passed');
