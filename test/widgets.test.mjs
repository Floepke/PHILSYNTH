import assert from 'node:assert/strict';
import { initWidgets } from '../src/widgets.js';

class Element extends EventTarget {
  constructor(tagName) {
    super();
    Object.assign(this, { tagName, children: [], attributes: {}, disabled: false, readOnly: false });
  }
  append(...children) { this.children.push(...children); }
  before(el) { this.wrapper = el; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) { return selector.split(', ').includes(this.tagName); }
  closest(selector) { return selector === 'dialog' && this.dialog ? this.dialog : null; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = body; }
  select() { this.textSelected = true; }
}

class NumberInput extends Element {
  constructor({ step = '1', min = '0', max = '64', value = '1' } = {}) {
    super('input');
    Object.assign(this, { id: 'number', step, min, max, value, validity: { badInput: false }, title: '', labels: [{ textContent: 'Count' }] });
  }
  get value() { return this.current; }
  set value(value) { this.current = String(value); }
  get valueAsNumber() { return this.value === '' ? NaN : +this.value; }
  stepUp(steps) { this.value = Math.max(+this.min, Math.min(+this.max, +this.value + steps * (+this.step || 1))); }
  stepDown(steps) { this.stepUp(-steps); }
  reportValidity() { this.reportedInvalid = true; }
}

class Select extends Element {
  constructor() {
    super('select');
    this.index = 1;
    this.pickerCalls = 0;
    const select = this;
    this.options = Array.from({ length: 4 }, (_, index) => ({
      value: String(index), disabled: false, hidden: false,
      get selected() { return select.index === index; },
      set selected(value) { if (value) select.index = index; },
    }));
  }
  get selectedOptions() { return [this.options[this.index]]; }
  showPicker() { this.pickerCalls++; }
}

const body = new Element('body');
const canvas = new Element('canvas');
globalThis.document = { activeElement: canvas, createElement: (tag) => new Element(tag) };
const select = new Select();
const integer = new NumberInput();
const time = new NumberInput({ step: 'any', max: '', value: '1.5' });
const root = { querySelectorAll: (selector) => selector === 'select' ? [select] : [integer, time] };
initWidgets(root, { numberStep: () => 0.25 });
const fire = (el, type, props = {}) => {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { button: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...props });
  el.dispatchEvent(e);
  return e;
};
const up = (input) => input.wrapper.children[1].children[0];
const down = (input) => input.wrapper.children[1].children[1];

// Native picker opens without the closed select taking focus, even if no value is changed.
assert.ok(fire(select, 'mousedown').defaultPrevented);
assert.equal(select.pickerCalls, 1);
assert.equal(document.activeElement, canvas);
fire(select, 'change');
assert.equal(document.activeElement, canvas);
const button = new Element('button');
button.focus();
fire(select, 'mousedown');
assert.equal(document.activeElement, body);
select.focus();
fire(select, 'keydown', { key: 'ArrowDown' });
fire(select, 'change');
assert.equal(document.activeElement, select, 'Tab/keyboard navigation retains focus');

// Wheel skips unavailable options, clamps at both ends and emits both standard value events.
let inputs = 0;
let changes = 0;
select.addEventListener('input', () => inputs++);
select.addEventListener('change', () => changes++);
select.options[2].disabled = true;
canvas.focus();
assert.ok(fire(select, 'wheel', { deltaY: 100 }).defaultPrevented);
assert.equal(select.index, 3);
assert.equal(document.activeElement, canvas);
fire(select, 'wheel', { deltaY: 100 });
assert.equal(changes, 1);
fire(select, 'wheel', { deltaY: -100 });
assert.equal(select.index, 1);
fire(select, 'wheel', { deltaY: -300 });
assert.equal(select.index, 0);
assert.equal(changes, 3);
assert.equal(inputs, 3);
assert.equal(fire(select, 'wheel', { deltaY: 100, ctrlKey: true }).defaultPrevented, false);
select.disabled = true;
assert.equal(fire(select, 'wheel', { deltaY: 100 }).defaultPrevented, false);
select.disabled = false;
select.options[1].parentElement = { disabled: true };
fire(select, 'wheel', { deltaY: 100 });
assert.equal(select.index, 3);
select.options[1].parentElement.disabled = false;
select.options[1].hidden = true;
fire(select, 'wheel', { deltaY: -100 });
assert.equal(select.index, 0);
select.options[1].hidden = false;

// Small trackpad deltas accumulate rather than skipping entries on every event.
for (let i = 0; i < 5; i++) fire(select, 'wheel', { deltaY: 20 });
assert.equal(select.index, 1);

// Mouse click does not focus a number. Double-click and Tab still allow explicit editing.
canvas.focus();
assert.ok(fire(integer, 'mousedown').defaultPrevented);
assert.equal(document.activeElement, canvas);
fire(integer, 'dblclick');
assert.equal(document.activeElement, integer);
assert.equal(integer.textSelected, true);
assert.equal(fire(integer, 'mousedown').defaultPrevented, false);
fire(integer, 'keydown', { key: 'Enter' });
assert.equal(document.activeElement, body);
integer.focus();
fire(integer, 'keydown', { key: 'Escape' });
assert.equal(document.activeElement, body);

// The larger custom arrows never submit a form or take focus and use native numeric bounds.
let countChanges = 0;
integer.addEventListener('change', () => countChanges++);
canvas.focus();
assert.equal(up(integer).type, 'button');
assert.equal(up(integer).tabIndex, -1);
assert.equal(up(integer).getAttribute('aria-label'), 'Increase Count');
assert.equal(integer.getAttribute('aria-label'), 'Count');
assert.ok(fire(up(integer), 'mousedown').defaultPrevented);
assert.ok(fire(up(integer), 'click').defaultPrevented);
assert.equal(integer.value, '2');
assert.equal(document.activeElement, canvas);
fire(down(integer), 'click');
assert.equal(integer.value, '1');
integer.value = '64';
fire(up(integer), 'click');
assert.equal(integer.value, '64');
assert.equal(countChanges, 2);
integer.value = '0';
fire(down(integer), 'click');
assert.equal(integer.value, '0');
integer.disabled = true;
fire(up(integer), 'click');
assert.equal(integer.value, '0');
integer.disabled = false;
integer.validity.badInput = true;
fire(up(integer), 'click');
assert.equal(integer.reportedInvalid, true);
assert.equal(integer.value, '0');
integer.validity.badInput = false;

// Free-form time fields step by the sequencer grid; wheel edits release stale text/button focus.
button.focus();
fire(time, 'wheel', { deltaY: -100 });
assert.equal(document.activeElement, body);
assert.equal(time.value, '1.75');
fire(down(time), 'click');
assert.equal(time.value, '1.5');
time.value = '';
fire(up(time), 'click');
assert.equal(time.value, '0.25');
time.value = '0.1';
fire(down(time), 'click');
assert.equal(time.value, '0');
time.readOnly = true;
fire(up(time), 'click');
assert.equal(time.value, '0');
assert.equal(fire(time, 'wheel', { deltaY: -100 }).defaultPrevented, false);

console.log('widget interaction tests passed');
