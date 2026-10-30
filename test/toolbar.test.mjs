import assert from 'node:assert/strict';
import { createHoverToolbar } from '../src/seq/toolbar.js';

let now = 0;
let nextFrame = 0;
const frames = new Map();
const observers = [];
globalThis.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.ResizeObserver = class {
  constructor(fn) { observers.push(fn); }
  observe() {}
};
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { activeElement: null, hidden: false });

class Bar extends EventTarget {
  clientWidth = 300;
  scrollWidth = 900;
  quantum = 0;
  position = 0;
  classes = new Set();
  classList = {
    toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
  };
  get scrollLeft() { return this.position; }
  set scrollLeft(value) {
    if (this.quantum) value = Math.round(value / this.quantum) * this.quantum;
    this.position = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, value));
  }
  getBoundingClientRect() { return { left: 100, right: 100 + this.clientWidth, width: this.clientWidth }; }
  contains(el) { return el?.bar === this; }
}
const bar = new Bar();
createHoverToolbar(bar, {});
const fire = (target, type, props = {}) => {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { buttons: 0, pointerType: 'mouse', clientX: 250, ...props });
  target.dispatchEvent(e);
  return e;
};
const move = (x, props) => fire(bar, 'pointermove', { clientX: x, ...props });
const advance = (ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    now += 16;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn(now));
  }
};
const pause = () => fire(bar, 'pointerleave');
const resize = () => observers.forEach((fn) => fn());

assert.equal(bar.classes.has('can-scroll-left'), false);
assert.equal(bar.classes.has('can-scroll-right'), true);
move(250);
advance(1000);
assert.equal(bar.scrollLeft, 0, 'middle does not pan');
move(399);
advance(2000);
assert.equal(bar.scrollLeft, 600, 'right edge reveals the final controls');
assert.equal(frames.size, 0, 'animation stops at the boundary');
assert.equal(bar.classes.has('can-scroll-right'), false);
assert.equal(bar.classes.has('can-scroll-left'), true);
move(101);
advance(2000);
assert.equal(bar.scrollLeft, 0, 'left edge reveals the first controls');
assert.equal(frames.size, 0);

// Slow edge motion must accumulate even when a browser rounds scrolling to whole pixels.
bar.quantum = 1;
move(337);
advance(1000);
assert.ok(bar.scrollLeft > 5);
pause();
bar.quantum = 0;
bar.scrollLeft = 0;

// Movement near the inside of an edge zone is gentler than at the outside.
move(340);
advance(160);
const slow = bar.scrollLeft;
pause();
bar.scrollLeft = 0;
move(399);
advance(160);
assert.ok(bar.scrollLeft > slow * 3);

// Clicking, leaving, typing, cancelling, wheeling and losing the window stop motion immediately.
for (const event of ['pointerdown', 'pointerleave', 'pointercancel', 'keydown', 'wheel']) {
  bar.scrollLeft = 100;
  move(399);
  advance(32);
  fire(bar, event);
  const stopped = bar.scrollLeft;
  advance(500);
  assert.equal(bar.scrollLeft, stopped, `${event} pauses pan`);
  assert.equal(frames.size, 0);
}
for (const props of [{ buttons: 1 }, { pointerType: 'touch' }]) {
  bar.scrollLeft = 100;
  move(399, props);
  advance(100);
  assert.equal(bar.scrollLeft, 100);
}
move(399);
advance(16);
fire(window, 'blur');
const blurred = bar.scrollLeft;
advance(100);
assert.equal(bar.scrollLeft, blurred);
move(399);
advance(16);
document.hidden = true;
fire(document, 'visibilitychange');
const hidden = bar.scrollLeft;
advance(100);
assert.equal(bar.scrollLeft, hidden);
document.hidden = false;

assert.ok(fire(bar, 'wheel', { deltaY: 100 }).defaultPrevented);
assert.ok(fire(bar, 'wheel', { deltaX: 100, shiftKey: true }).defaultPrevented);
assert.equal(fire(bar, 'wheel', { deltaY: 100, ctrlKey: true }).defaultPrevented, false);
assert.equal(fire(bar, 'wheel', { deltaY: 100, metaKey: true }).defaultPrevented, false);

// Keyboard focus reveals controls but locks out hover-panning during text entry.
bar.scrollLeft = 0;
const input = { bar, getBoundingClientRect: () => ({ left: 650, right: 750 }) };
document.activeElement = input;
const focus = new Event('focusin');
Object.defineProperty(focus, 'target', { value: input });
bar.dispatchEvent(focus);
assert.ok(bar.scrollLeft > 0);
const focused = bar.scrollLeft;
move(399);
advance(100);
assert.equal(bar.scrollLeft, focused);
document.activeElement = null;

// Resizing back to a fitting row clears scroll and indicators; new overflow works again.
bar.clientWidth = 1000;
resize();
assert.equal(bar.scrollLeft, 0);
assert.equal(bar.classes.has('can-scroll-left'), false);
assert.equal(bar.classes.has('can-scroll-right'), false);
move(1099);
advance(100);
assert.equal(bar.scrollLeft, 0);
bar.clientWidth = 300;
bar.scrollWidth = 1200;
resize();
assert.equal(bar.classes.has('can-scroll-right'), true);
move(399);
advance(2500);
assert.equal(bar.scrollLeft, 900);
bar.clientWidth = 0;
resize();
assert.equal(frames.size, 0);
move(100);
advance(100);
assert.equal(frames.size, 0);
bar.clientWidth = 500;
resize();
assert.equal(bar.scrollLeft, 700);
move(101);
advance(2500);
assert.equal(bar.scrollLeft, 0);

console.log('hover toolbar tests passed');
