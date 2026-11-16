// Run: node test/modcolor.test.mjs   (custom module colours: helpers + patch model)
import assert from 'node:assert/strict';

import { dspTestHost } from './dsphost.mjs';
import { cleanColor, colorOf, stockColor, hexToRgb, rgbToHex } from '../src/modcolor.js';
import { MODULE_COLOR_PALETTE, nearestModuleColorIndex } from '../src/modulecolorpalette.js';
import { openColorDialog } from '../src/colordialog.js';

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
assert.equal(stockColor(patchDef), '#ff0000', 'Patch modules use the red stock colour');
assert.equal(colorOf({ def: { color: '#123456' }, color: null }), '#123456', 'stock');
assert.equal(colorOf({ def: { color: '#123456' }, color: '#abcdef' }), '#abcdef', 'custom wins');
assert.equal(colorOf({ def: { isOutput: true }, color: null }), null, 'Output keeps its own look');
assert.equal(colorOf({ def: { isOutput: true }, color: '#102030' }), '#102030');
assert.equal(MODULE_COLOR_PALETTE.length, 128);
assert.equal(new Set(MODULE_COLOR_PALETTE).size, 128, 'palette colors are unique');
for (let i = 0; i < MODULE_COLOR_PALETTE.length; i++) {
  assert.equal(nearestModuleColorIndex(MODULE_COLOR_PALETTE[i]), i, 'palette swatches map back to themselves');
  const [r, g, b] = hexToRgb(MODULE_COLOR_PALETTE[i]).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.ok(luminance > 0.18 && luminance < 0.55, 'palette avoids colors that are too dark or light');
}

{
  class Element extends EventTarget {
    attributes = new Map();
    dataset = {};
    style = { values: new Map(), setProperty(name, value) { this.values.set(name, value); }, removeProperty(name) { this.values.delete(name); } };
    classList = { toggle() {} };
    value = '0';
    textContent = '';
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    querySelector(selector) { return this.children.get(selector); }
    children = new Map();
    focus() {}
    showModal() { this.open = true; }
    close(value) {
      this.returnValue = value;
      this.open = false;
      this.dispatchEvent(new Event('close'));
    }
    getBoundingClientRect() { return { left: 0, width: 128 }; }
  }
  const previousDocument = globalThis.document;
  const elements = new Map();
  for (const id of ['color-dialog', 'color-sample', 'color-title', 'color-reset', 'color-note', 'color-palette',
    'color-r', 'color-g', 'color-b', 'color-r-val', 'color-g-val', 'color-b-val']) elements.set(id, new Element());
  elements.get('color-sample').children.set('.module-name', new Element());
  elements.get('color-sample').children.set('.module-id', new Element());
  globalThis.document = { getElementById: (id) => elements.get(id) };
  try {
    const palette = elements.get('color-palette');
    const slider = (channel) => elements.get(`color-${channel}`);
    const pointer = (type, x, buttons) => {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, { button: 0, clientX: x, buttons });
      palette.dispatchEvent(event);
    };
    const pending = openColorDialog({ id: 1, color: null, def: { type: 'OSC', color: '#ff0000' } });
    const initial = +palette.getAttribute('aria-valuenow');
    pointer('pointerdown', 64, 1);
    pointer('pointermove', 64 - 128 / 9, 1);
    pointer('pointerup', 64 - 128 / 9, 0);
    const dragged = (initial + 1) % MODULE_COLOR_PALETTE.length;
    assert.equal(+palette.getAttribute('aria-valuenow'), dragged);
    assert.deepEqual(['r', 'g', 'b'].map((c) => +slider(c).value), hexToRgb(MODULE_COLOR_PALETTE[dragged]));
    assert.match(palette.style.backgroundImage, new RegExp(MODULE_COLOR_PALETTE[dragged].slice(1)));
    assert.equal(palette.style.values.get('--palette-position'), '50%');

    const wheel = new Event('wheel', { cancelable: true });
    Object.assign(wheel, { deltaY: 1, deltaX: 0 });
    palette.dispatchEvent(wheel);
    assert.equal(+palette.getAttribute('aria-valuenow'), (dragged + 1) % MODULE_COLOR_PALETTE.length, 'scroll advances and wraps through colors');

    slider('r').value = '120';
    slider('r').oninput();
    const edited = rgbToHex(+slider('r').value, +slider('g').value, +slider('b').value);
    assert.equal(+palette.getAttribute('aria-valuenow'), nearestModuleColorIndex(edited), 'RGB edits move the palette marker');
    const next = new Event('keydown', { cancelable: true });
    next.key = 'ArrowRight';
    palette.dispatchEvent(next);
    assert.equal(+palette.getAttribute('aria-valuenow'), (nearestModuleColorIndex(edited) + 1) % MODULE_COLOR_PALETTE.length);
    const end = new Event('keydown', { cancelable: true });
    end.key = 'End';
    palette.dispatchEvent(end);
    const scrollForward = new Event('wheel', { cancelable: true });
    Object.assign(scrollForward, { deltaY: 1, deltaX: 0 });
    palette.dispatchEvent(scrollForward);
    assert.equal(+palette.getAttribute('aria-valuenow'), 0, 'scrolling past the last color wraps to the first');
    const scrollBack = new Event('wheel', { cancelable: true });
    Object.assign(scrollBack, { deltaY: -1, deltaX: 0 });
    palette.dispatchEvent(scrollBack);
    assert.equal(+palette.getAttribute('aria-valuenow'), 127, 'scrolling before the first color wraps to the last');
    end.key = 'End';
    palette.dispatchEvent(end);
    const wrap = new Event('keydown', { cancelable: true });
    wrap.key = 'ArrowRight';
    palette.dispatchEvent(wrap);
    assert.equal(+palette.getAttribute('aria-valuenow'), 0, 'keyboard navigation wraps at the end');
    elements.get('color-dialog').close('cancel');
    assert.equal(await pending, undefined, 'Cancel discards palette colors');

    const committed = openColorDialog({ id: 1, color: null, def: { type: 'OSC', color: '#ff0000' } });
    const selectEnd = new Event('keydown', { cancelable: true });
    selectEnd.key = 'End';
    palette.dispatchEvent(selectEnd);
    elements.get('color-dialog').close('ok');
    assert.equal(await committed, MODULE_COLOR_PALETTE[127], 'OK returns the chosen palette color');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

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
