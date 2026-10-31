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
assert.equal(bar.scrollLeft, 300, 'middle reveals the middle of the overflow');
move(400);
advance(2000);
assert.equal(bar.scrollLeft, 600, 'right edge reveals the final controls');
assert.equal(frames.size, 0, 'animation stops at the boundary');
assert.equal(bar.classes.has('can-scroll-right'), false);
assert.equal(bar.classes.has('can-scroll-left'), true);
move(100);
advance(2000);
assert.equal(bar.scrollLeft, 0, 'left edge reveals the first controls');
assert.equal(frames.size, 0);

// The full pointer journey maps to the full scroll range, without edge-only zones.
for (const [x, expected] of [[100, 0], [160, 120], [220, 240], [280, 360], [340, 480], [400, 600], [250, 300], [100, 0]]) {
  move(x);
  advance(16);
  assert.equal(bar.scrollLeft, expected);
  assert.equal(frames.size, 0, 'a stationary pointer never keeps scrolling');
}
// Pointer positions outside the row clamp to the endpoints.
move(450);
advance(16);
assert.equal(bar.scrollLeft, 600);
move(50);
advance(16);
assert.equal(bar.scrollLeft, 0);

// Rounded scroll positions remain tied to pointer position, not accumulated speed.
bar.quantum = 1;
move(250.25);
advance(16);
assert.equal(bar.scrollLeft, 301);
advance(1000);
assert.equal(bar.scrollLeft, 301, 'holding still does not drift');
pause();
bar.quantum = 0;
bar.scrollLeft = 0;

// Rapid pointer moves are coalesced into the latest position for the next paint.
move(160);
move(340);
assert.equal(frames.size, 1);
advance(16);
assert.equal(bar.scrollLeft, 480);

// Clicking, leaving, typing, cancelling, wheeling and losing the window stop motion immediately.
for (const event of ['pointerdown', 'pointerleave', 'pointercancel', 'keydown', 'wheel']) {
  bar.scrollLeft = 100;
  move(399);
  advance(32);
  move(150);
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
move(400);
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
move(100);
advance(2500);
assert.equal(bar.scrollLeft, 0);

console.log('hover toolbar tests passed');
