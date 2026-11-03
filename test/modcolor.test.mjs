// Run: node test/modcolor.test.mjs   (custom module colours: helpers + patch model)
import assert from 'node:assert/strict';

import { dspTestHost } from './dsphost.mjs';
import { cleanColor, colorOf, stockColor, hexToRgb, rgbToHex } from '../src/modcolor.js';

assert.equal(cleanColor('#A1b2C3'), '#a1b2c3');
assert.equal(cleanColor(' #000000 '), '#000000');
for (const bad of [null, undefined, '', 'red', '#abc', '#12345g', 42]) assert.equal(cleanColor(bad), null, String(bad));
assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
assert.equal(rgbToHex(255, 128, 0), '#ff8000');
assert.equal(rgbToHex(300, -5, 7.6), '#ff0008', 'clamped and rounded');
assert.equal(stockColor({ color: '#aaa' }), '#aaaaaa', 'short codes expand');
assert.equal(stockColor({ color: '#3A7BD5' }), '#3a7bd5');
assert.equal(stockColor({ isOutput: true }), '#c4c4c8', 'Output: light grey');
const { default: patchDef } = await import('../src/modules/patch.js');
assert.equal(stockColor(patchDef), '#000000', 'Patch modules are black unless recoloured');
assert.equal(colorOf({ def: { color: '#123456' }, color: null }), '#123456', 'stock');
assert.equal(colorOf({ def: { color: '#123456' }, color: '#abcdef' }), '#abcdef', 'custom wins');
assert.equal(colorOf({ def: { isOutput: true }, color: null }), null, 'Output keeps its own look');
assert.equal(colorOf({ def: { isOutput: true }, color: '#102030' }), '#102030');

// patch model: recolor, save, load (old projects without `color`), duplicate, copy / paste
const ctx = { currentTime: 0 };
const { dsp } = dspTestHost();
const { PatchRuntime } = await import('../src/patch.js');
const engine = { ctx, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
const root = await PatchRuntime.create(engine, dsp.destination);

const osc = await root.addModule('OSC', { x: 0, y: 0 });
assert.equal(osc.color, null, 'new modules use the stock colour');
let emits = 0;
root.listeners.add(() => emits++);
assert.ok(root.recolor(osc.id, '#FF0000'));
assert.equal(osc.color, '#ff0000');
assert.equal(emits, 1, 'recolor notifies (the TimeLine redraws its clips)');
root.recolor(osc.id, '#ff0000');
assert.equal(emits, 1, 'no change, no notify');
root.recolor(0, '#336699');
assert.equal(root.recolor(99, '#000000'), false);

const saved = root.toJSON();
assert.equal(saved.modules.find((m) => m.id === osc.id).color, '#ff0000');
assert.equal(saved.modules.find((m) => m.id === 0).color, '#336699');

const copy = await root.duplicate(osc.id);
assert.equal(copy.color, '#ff0000', 'duplicate keeps the colour');
const [pasted] = await root.pasteMany(root.copyMany([osc.id]));
assert.equal(pasted.color, '#ff0000', 'paste keeps the colour');

const other = await PatchRuntime.create(engine, dsp.destination);
await other.load(saved);
assert.equal(other.modules.get(osc.id).color, '#ff0000');
assert.equal(other.modules.get(0).color, '#336699');

// an older project: no `color` anywhere -> null, the stock look as before
const old = structuredClone(saved);
for (const m of old.modules) delete m.color;
await other.load(old);
assert.equal(other.modules.get(osc.id).color, null);
assert.equal(other.modules.get(0).color, null);
await other.load({ modules: [{ id: 1, type: 'OSC', x: 0, y: 0, values: {}, color: 'not a colour' }], cables: [] });
assert.equal(other.modules.get(1).color, null, 'invalid colour -> stock');

root.recolor(osc.id, null);
assert.equal(osc.color, null, 'reset to stock');

console.log('modcolor: ok');
