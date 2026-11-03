// Run: node test/grid.test.mjs   (patcher Snap to Grid)
import assert from 'node:assert/strict';
import { GRID, snapToGrid } from '../src/grid.js';

assert.equal(GRID, 20, 'half a module high');
assert.equal(snapToGrid(0), 0);
assert.equal(snapToGrid(9), 0);
assert.equal(snapToGrid(10), 20);
assert.equal(snapToGrid(19), 20);
assert.equal(snapToGrid(20), 20);
assert.equal(snapToGrid(61), 60);
assert.equal(snapToGrid(-11), -20, 'left / above the origin too');
assert.equal(snapToGrid(-9) + 0, 0);
assert.equal(snapToGrid(61.4, false), 61, 'off: whole pixels, as before');
console.log('grid tests passed');
