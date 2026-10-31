import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { emptySong, addClip, addAutoClip, isAuto, cloneClip } from '../src/song.js';
import { createAutomationLane } from '../src/seq/automation.js';
import { createPianoRoll } from '../src/seq/pianoroll.js';
import { createArranger } from '../src/seq/arranger.js';
import { clipsOverlap } from '../src/seq/clipplacement.js';
import { createSequencer } from '../src/seq/index.js';
import { Transport } from '../src/transport.js';

const frames = [];
const resizes = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.ResizeObserver = class {
  constructor(fn) { this.fn = fn; }
  observe(target) { resizes.push(this.fn); if (target) target.resize = this.fn; }
};

class Canvas extends EventTarget {
  style = {};
  classList = { add() {}, remove() {} };
  drawing = [];
  context = Object.fromEntries([
    'setTransform', 'fillRect', 'strokeRect', 'beginPath', 'arc', 'fill', 'stroke',
    'save', 'rect', 'clip', 'setLineDash', 'moveTo', 'lineTo', 'restore',
    'fillText', 'arcTo', 'closePath', 'ellipse', 'roundRect', 'quadraticCurveTo',
  ].map((name) => [name, (...args) => this.drawing.push([name, ...args])]));
  constructor() {
    super();
    this.context.measureText = () => ({ width: 56 });
    this.context.fillRect = (...args) => this.drawing.push(['fillRect', ...args, this.context.fillStyle]);
    this.context.fill = () => this.drawing.push(['fill', this.context.fillStyle]);
    this.context.stroke = () => this.drawing.push(['stroke', this.context.strokeStyle, this.context.lineWidth]);
  }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  setPointerCapture() {}
  focus() { document.activeElement = this; }
}

globalThis.document = { createElement: () => new Canvas(), activeElement: null, addEventListener() {} };
globalThis.window = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
const flush = () => {
  while (resizes.length) resizes.shift()();
  while (frames.length) frames.shift()();
};
const fire = (cv, type, props = {}) => {
  const e = new Event(type, { cancelable: true });
  if ('timeStamp' in props) Object.defineProperty(e, 'timeStamp', { value: props.timeStamp });
  const { timeStamp: _, ...rest } = props;
  props = rest;
  Object.assign(e, {
    button: 0, buttons: 0, pointerId: 1, clientX: 0, clientY: 0,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...props,
  });
  cv.dispatchEvent(e);
  flush();
  return e;
};
const point = (cv, type, x, y, props) => fire(cv, type, { clientX: x, clientY: y, ...props });
// double-click as the curve editors see it: down, up, down (+ up)
const dbl = (cv, x, y) => {
  for (let i = 0; i < 2; i++) {
    point(cv, 'pointerdown', x, y, { buttons: 1 });
    point(cv, 'pointerup', x, y);
  }
};
const key = (cv, key, props) => fire(cv, 'keydown', { key, ...props });
const drag = (cv, x, y, toX, toY, props = {}, end = 'pointerup') => {
  point(cv, 'pointerdown', x, y, { buttons: 1, ...props });
  point(cv, 'pointermove', toX, toY, { buttons: 1, ...props });
  point(cv, end, toX, toY, props);
};
const click = (cv, x, y, props = {}) => {
  point(cv, 'pointerdown', x, y, { buttons: 1, ...props });
  point(cv, 'pointerup', x, y, props);
};
const holdRightClick = (cv, x, y) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    point(cv, 'pointerdown', x, y, { button: 2, buttons: 2 });
    mock.timers.tick(500);
    flush();
    point(cv, 'pointerup', x, y, { button: 2 });
  } finally {
    mock.timers.reset();
  }
};
const host = () => ({ clientWidth: 480, clientHeight: 400, append() {} });
const ROLL_WIDTH = 120 + 128 * 14;
const note = (pitch, start, length = 1, vel = 0.8) => ({ pitch, start, length, vel });

function setup({ snapVelocity = false } = {}) {
  const song = emptySong();
  const clip = addClip(song, { length: 16, target: 7 });
  song.selected = clip.id;
  let changes = 0;
  let previews = 0;
  const menus = [];
  const ctx = {
    menu: (opts) => menus.push(opts),
    song: () => song,
    clip: () => song.clips.find((c) => c.id === song.selected) ?? null,
    color: () => '#e76f51',
    targetLabel: () => 'test',
    defaultTarget: () => 7,
    transport: { playing: false, pos: 0, seek(t) { this.pos = t; } },
    changed() { changes++; },
    select(id) { song.selected = id; roll.reveal(); roll.redraw(); arranger.redraw(); },
    preview: { on() { previews++; return {}; }, off(h) { if (h) previews--; } },
  };
  const rollHost = { ...host(), clientWidth: ROLL_WIDTH };
  const roll = createPianoRoll(rollHost, ctx);
  const initialView = roll.getView();
  const initialSnap = initialView.snapVelocity;
  const arranger = createArranger(host(), ctx);
  roll.setView({ sy: 0, ppq: 48, snapVelocity });
  flush();
  return { song, clip, roll, rollHost, arranger, ctx, menus, initialSnap, initialView, changes: () => changes, previews: () => previews };
}
// runs the action of the last opened context menu's item with this label
const pick = (menus, label) => {
  const item = menus.at(-1).items.find((i) => i !== '-' && i.label === label);
  assert.ok(item, `menu item ${label}`);
  assert.ok(!item.disabled, `${label} enabled`);
  item.action();
  flush();
};
const labels = (menus) => menus.at(-1).items.filter((i) => i !== '-').map((i) => i.label);
const nx = (pitch) => 120 + pitch * 14 + 7;
const ny = (start) => start * 48;
const ax = (start) => 70 + start * 16;
const ay = (y) => 38 + y + 17;
const assertNoOverlap = (song) => {
  for (let i = 0; i < song.clips.length; i++) {
    for (let j = i + 1; j < song.clips.length; j++) assert.equal(clipsOverlap(song.clips[i], song.clips[j]), false);
  }
};

// The keyboard auditions white/black keys without inserting notes or changing the selection.
for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
  const { clip, roll, ctx, changes } = setup();
  const cv = roll.surface.cv;
  const calls = [];
  ctx.preview.on = (c, pitch) => { assert.equal(c, clip); calls.push(['on', pitch]); return pitch; };
  ctx.preview.off = (pitch) => { if (pitch !== null) calls.push(['off', pitch]); };
  clip.notes.push(note(65, 1));
  key(cv, 'a', { ctrlKey: true });
  point(cv, 'pointerdown', nx(60), 390, { buttons: 1 });
  assert.deepEqual(calls, [['on', 60]]);
  assert.ok(cv.drawing.some(([op, , y, , , color]) => op === 'fillRect' && y === 377 && color === '#ff916e'), 'held key highlighted');
  point(cv, 'pointermove', nx(60) + 1, 390, { buttons: 1 });
  assert.equal(calls.length, 1, 'same key is not retriggered');
  point(cv, 'pointerup', nx(60), 390, { pointerId: 2 });
  assert.equal(calls.length, 1, 'unrelated pointer cannot release the note');
  point(cv, 'pointermove', nx(61), 390, { buttons: 1 });
  assert.deepEqual(calls.slice(-2), [['off', 60], ['on', 61]], 'drag auditions adjacent black key');
  point(cv, ending, nx(61), 390);
  assert.deepEqual(calls.at(-1), ['off', 61]);
  point(cv, 'pointerup', nx(61), 390);
  assert.equal(calls.length, 4, 'released exactly once');
  assert.equal(changes(), 0);
  assert.deepEqual(clip.notes, [note(65, 1)]);
  key(cv, 'Backspace');
  assert.equal(clip.notes.length, 0, 'selection survived audition');
}
{
  const { clip, roll, previews, changes } = setup();
  const cv = roll.surface.cv;
  point(cv, 'pointerdown', nx(60), 390, { buttons: 1 });
  assert.equal(previews(), 1);
  point(cv, 'pointermove', nx(60), 350, { buttons: 1 });
  assert.equal(previews(), 0, 'leaving keyboard releases preview');
  point(cv, 'pointermove', nx(64), 390, { buttons: 1 });
  assert.equal(previews(), 1, 're-entering keyboard auditions again');
  window.dispatchEvent(new Event('blur'));
  assert.equal(previews(), 0, 'leaving window cannot leave a stuck note');
  point(cv, 'pointerup', nx(64), 390);
  assert.equal(previews(), 0);
  assert.equal(changes(), 0);
  assert.equal(clip.notes.length, 0);
}
{
  const { song, roll, previews } = setup();
  const cv = roll.surface.cv;
  point(cv, 'pointerdown', nx(60), 390, { buttons: 1 });
  song.selected = null;
  roll.redraw(); flush();
  assert.equal(previews(), 0, 'changing clip ends keyboard audition');
  click(cv, nx(60), 390);
  assert.equal(previews(), 0, 'no clip means no audition target');
}

// Marquee selects intersecting notes (including their bodies), in either direction.
for (const reverse of [false, true]) {
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 0, 2), note(64, 1), note(70, 1));
  const before = structuredClone(clip.notes);
  const a = [nx(59), ny(0.5)];
  const b = [nx(65), ny(2.5)];
  const [from, to] = reverse ? [b, a] : [a, b];
  point(cv, 'pointerdown', ...from, { buttons: 1, shiftKey: true });
  point(cv, 'pointermove', ...to, { buttons: 1, shiftKey: true });
  assert.ok(cv.drawing.some(([op, x, y, w, h]) =>
    op === 'fillRect' && x === a[0] && y === a[1] && w === b[0] - a[0] && h === b[1] - a[1]));
  point(cv, 'pointerup', ...to, { shiftKey: true });
  assert.deepEqual(clip.notes, before);
  assert.equal(changes(), 0);
  assert.ok(key(cv, 'Backspace').defaultPrevented);
  assert.deepEqual(clip.notes, [before[2]]);
  assert.equal(changes(), 1);
}

// Selection can start on a head, is cleared by an empty rectangle, and Escape clears it.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1), note(64, 1));
  drag(cv, nx(60), ny(1) + 5, nx(65), ny(2), { shiftKey: true });
  key(cv, 'Escape');
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 2);
  key(cv, 'a', { ctrlKey: true });
  drag(cv, nx(70), ny(4), nx(73), ny(5), { shiftKey: true });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 2);
  click(cv, nx(60), ny(1) + 5);
  key(cv, 'Delete');
  assert.deepEqual(clip.notes.map((n) => n.pitch), [64]);
}

// Ordinary insertion, duration edits and head moves still work; short right click deletes.
{
  const { clip, roll, previews, menus } = setup();
  const cv = roll.surface.cv;
  drag(cv, nx(60), ny(1), nx(60), ny(2));
  assert.deepEqual(clip.notes, [note(60, 1)]);
  drag(cv, nx(60), ny(1.5), nx(60), ny(2));
  assert.equal(clip.notes[0].length, 1.5);
  drag(cv, nx(60), ny(1) + 5, nx(62), ny(2) + 5);
  assert.deepEqual(clip.notes, [note(62, 2, 1.5)]);
  assert.equal(previews(), 0);
  click(cv, nx(62), ny(2) + 5, { button: 2 });
  assert.equal(clip.notes.length, 0);
  assert.equal(menus.length, 0);
}

// Hold-menu actions: cut + paste at the pressed position, copy, octave.
{
  const { clip, roll, menus } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1), note(64, 2));
  holdRightClick(cv, nx(60), ny(1) + 5);
  assert.equal(clip.notes.length, 2, 'release after opening a menu never deletes');
  assert.deepEqual(labels(menus).slice(0, 4), ['Cut', 'Copy', 'Paste', 'Delete']);
  pick(menus, 'Cut');
  assert.deepEqual(clip.notes.map((n) => n.pitch), [64]);
  holdRightClick(cv, nx(60), ny(6) + 5);
  pick(menus, 'Paste');
  assert.deepEqual(clip.notes.map((n) => [n.pitch, n.start]), [[64, 2], [60, 6]]);
  holdRightClick(cv, nx(64), ny(2) + 5);
  pick(menus, 'Octave up');
  assert.deepEqual(clip.notes.map((n) => n.pitch), [76, 60]);
  key(cv, 'Escape');
  holdRightClick(cv, nx(70), ny(4));
  assert.equal(menus.at(-1).items.find((i) => i.label === 'Copy').disabled, true);
}

// Exact hold threshold: menu appears while still pressed, never early and never twice.
{
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { clip, roll, menus, changes } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1), note(64, 2));
    point(cv, 'pointerdown', nx(60), ny(1) + 5, { button: 2, buttons: 2 });
    mock.timers.tick(499);
    assert.equal(menus.length, 0);
    assert.equal(clip.notes.length, 2, 'no deletion on press');
    mock.timers.tick(1); flush();
    assert.equal(menus.length, 1, 'menu opens at 500 ms before release');
    assert.equal(clip.notes.length, 2);
    mock.timers.tick(1000);
    assert.equal(menus.length, 1);
    point(cv, 'pointermove', nx(70), ny(3), { button: 2, buttons: 2 });
    point(cv, 'pointerup', nx(70), ny(3), { button: 2 });
    assert.equal(clip.notes.length, 2, 'moving/releasing after the menu opens cannot delete');
    assert.equal(changes(), 0);
    pick(menus, 'Delete');
    assert.deepEqual(clip.notes.map((n) => n.pitch), [64], 'menu actions remain usable');
  } finally {
    mock.timers.reset();
  }
}

// A quick right-click on either the head or body deletes only that note, even in a selection.
for (const y of [ny(1) + 5, ny(1.5)]) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { clip, roll, menus, changes } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1), note(64, 2));
    key(cv, 'a', { ctrlKey: true });
    point(cv, 'pointerdown', nx(60), y, { button: 2, buttons: 2 });
    mock.timers.tick(499);
    point(cv, 'pointerup', nx(60), y, { button: 2 });
    assert.deepEqual(clip.notes.map((n) => n.pitch), [64]);
    assert.equal(changes(), 1);
    mock.timers.tick(1000);
    assert.equal(menus.length, 0, 'release cancels the hold timer');
    key(cv, 'Delete');
    assert.equal(clip.notes.length, 0, 'other selected notes stay selected');
    click(cv, nx(70), ny(3), { button: 2 });
    mock.timers.tick(1000);
    assert.equal(menus.length, 0, 'quick right-click on empty space does nothing');
    assert.equal(changes(), 2);
  } finally {
    mock.timers.reset();
  }
}

// Even if the timer is delayed by a busy event loop, a 500 ms release is not a delete.
{
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { clip, roll, menus } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1));
    point(cv, 'pointerdown', nx(60), ny(1) + 5, { button: 2, buttons: 2, timeStamp: 1000 });
    point(cv, 'pointerup', nx(60), ny(1) + 5, { button: 2, timeStamp: 1500 });
    assert.equal(menus.length, 1);
    assert.equal(clip.notes.length, 1);
    mock.timers.tick(1000);
    assert.equal(menus.length, 1);
  } finally {
    mock.timers.reset();
  }
}

// Cancelling a pending hold cannot open a late menu or delete a note.
for (const cancel of ['pointercancel', 'lostpointercapture', 'blur', 'windowBlur', 'Escape', 'wheel', 'clipChange']) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { clip, roll, menus, song, changes } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1));
    point(cv, 'pointerdown', nx(60), ny(1) + 5, { button: 2, buttons: 2 });
    mock.timers.tick(250);
    if (cancel === 'windowBlur') window.dispatchEvent(new Event('blur'));
    else if (cancel === 'Escape') key(cv, 'Escape');
    else if (cancel === 'clipChange') { song.selected = null; roll.redraw(); flush(); }
    else point(cv, cancel, nx(60), ny(1) + 5, { button: 2, deltaX: 0, deltaY: 10, deltaMode: 0 });
    mock.timers.tick(1000);
    point(cv, 'pointerup', nx(60), ny(1) + 5, { button: 2 });
    assert.equal(menus.length, 0, cancel);
    assert.equal(clip.notes.length, 1, cancel);
    assert.equal(changes(), 0, cancel);
  } finally {
    mock.timers.reset();
  }
}

// Dragging before the hold threshold stays a marquee, even if the button remains down.
{
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { clip, roll, menus, changes } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1), note(64, 2));
    point(cv, 'pointerdown', nx(59), ny(0.5), { button: 2, buttons: 2 });
    mock.timers.tick(250);
    point(cv, 'pointermove', nx(61), ny(1.5), { button: 2, buttons: 2 });
    mock.timers.tick(1000);
    point(cv, 'pointerup', nx(61), ny(1.5), { button: 2 });
    assert.equal(menus.length, 0);
    assert.equal(changes(), 0);
    assert.equal(clip.notes.length, 2);
    key(cv, 'Delete');
    assert.deepEqual(clip.notes.map((n) => n.pitch), [64], 'marquee selected the first note');
  } finally {
    mock.timers.reset();
  }
}

// Right-drag draws a selection rectangle (no menu); dragging a selected note moves the whole group.
{
  const { clip, roll, menus, changes } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1), note(62, 2), note(70, 1));
  drag(cv, nx(59), ny(0.5), nx(63), ny(3.5), { button: 2, buttons: 2 });
  assert.equal(menus.length, 0);
  assert.equal(changes(), 0);
  drag(cv, nx(60), ny(1) + 5, nx(61), ny(3) + 5);
  assert.deepEqual(clip.notes.map((n) => [n.pitch, n.start]), [[61, 3], [63, 4], [70, 1]]);
  // body drag changes every selected note's length by the same amount
  drag(cv, nx(61), ny(3.5), nx(61), ny(4));
  assert.deepEqual(clip.notes.map((n) => n.length), [1.5, 1.5, 1]);
  // Shift + click toggles a note in the selection
  click(cv, nx(70), ny(1) + 5, { shiftKey: true });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 0);
}

// Ctrl/Cmd + D duplicates the selection right after itself; Q quantizes; new notes get the last length.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 0), note(62, 1));
  key(cv, 'a', { ctrlKey: true });
  key(cv, 'd', { ctrlKey: true });
  assert.deepEqual(clip.notes.map((n) => n.start), [0, 1, 2, 3]);
  clip.notes.length = 0;
  clip.notes.push(note(60, 0.3), note(62, 1.8));
  key(cv, 'q');
  assert.ok(clip.notes.every((n) => Number.isInteger(n.start * 4)), JSON.stringify(clip.notes));
  clip.notes.length = 0;
  drag(cv, nx(60), ny(4), nx(60), ny(6));
  assert.equal(clip.notes[0].length, 2);
  click(cv, nx(65), ny(0.5));
  assert.equal(clip.notes[1].length, 2);
}

// Alt-drag clones from head OR body, without modifying the source or its duration/velocity.
for (const offset of [5, 24]) {
  const { clip, roll, previews } = setup();
  const cv = roll.surface.cv;
  const original = note(60, 1, 1.5, 0.43);
  clip.notes.push(original);
  click(cv, nx(60), ny(1) + offset, { altKey: true });
  assert.equal(clip.notes.length, 1);
  drag(cv, nx(60), ny(1) + offset, nx(63), ny(2) + offset, { altKey: true });
  assert.equal(clip.notes.length, 2);
  assert.deepEqual(original, note(60, 1, 1.5, 0.43));
  assert.deepEqual(clip.notes[1], note(63, 2, 1.5, 0.43));
  assert.notEqual(clip.notes[1], original);
  key(cv, 'Backspace');
  assert.deepEqual(clip.notes, [original]);
  drag(cv, nx(60), ny(1) + offset, nx(65), ny(3) + offset, { altKey: true }, 'pointercancel');
  assert.deepEqual(clip.notes, [original]);
  assert.equal(previews(), 0);
}

// Copy/cut/paste use snapshots, preserve offsets and pitches, snap at the pointer even over a note.
for (const modifier of ['ctrlKey', 'metaKey']) {
  const { song, clip, roll, ctx } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60.5, 1, 1.25, 0.3), note(64, 1.5, 0.75, 0.9));
  key(cv, 'a', { [modifier]: true });
  key(cv, 'C', { [modifier]: true });
  clip.notes[0].vel = 0.7;
  point(cv, 'pointermove', nx(60.5), ny(1.3));
  key(cv, 'v', { [modifier]: true });
  assert.deepEqual(clip.notes.slice(2), [note(60.5, 1.25, 1.25, 0.3), note(64, 1.75, 0.75, 0.9)]);
  key(cv, 'x', { [modifier]: true });
  assert.equal(clip.notes.length, 2);
  const destination = addClip(song, { length: 16 });
  ctx.select(destination.id);
  key(cv, 'Backspace'); // old note selection must never carry into another clip
  point(cv, 'pointermove', nx(75), ny(3.13) - roll.getView().sy);
  key(cv, 'v', { [modifier]: true });
  assert.deepEqual(destination.notes, [note(60.5, 3, 1.25, 0.3), note(64, 3.5, 0.75, 0.9)]);
  key(cv, 'v', { [modifier]: true });
  assert.notEqual(destination.notes[0], destination.notes[2]);
  key(cv, 'Delete');
  assert.equal(destination.notes.length, 2);
  assert.equal(clip.notes.length, 2);
  fire(cv, 'pointerleave');
  key(cv, 'v', { [modifier]: true });
  assert.equal(destination.notes.length, 2);
}

// Paste recomputes grid position after zoom/scroll, and selection handles scrolled coordinates.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1));
  key(cv, 'a', { ctrlKey: true });
  key(cv, 'c', { ctrlKey: true });
  roll.setView({ sy: 96, ppq: 96 });
  flush();
  point(cv, 'pointermove', 300, 116);
  key(cv, 'v', { ctrlKey: true });
  assert.equal(clip.notes[1].start, 2);
  drag(cv, nx(59), 96 + 5, nx(61), 2.5 * 96 - 96, { shiftKey: true });
  key(cv, 'Delete');
  assert.deepEqual(clip.notes, [note(60, 1)]);
}

// Clip clipboard preserves names, target, duration and independent note objects with fresh IDs.
for (const modifier of ['ctrlKey', 'metaKey']) {
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.name = 'Phrase';
  clip.notes.push(note(60, -0.5, 1.5, 0.25), note(64, 1));
  const source = structuredClone(clip);
  click(cv, ax(1), ay(clip.y));
  key(cv, 'c', { [modifier]: true });
  clip.notes[0].pitch = 62;
  point(cv, 'pointermove', ax(6.37), ay(80));
  key(cv, 'v', { [modifier]: true });
  const copy = ctx.clip();
  assert.notEqual(copy.id, clip.id);
  assert.equal(copy.name, 'Phrase');
  assert.equal(copy.start, 6.25);
  assert.equal(copy.y, 68, 'pasted on the lane under the pointer');
  assert.equal(copy.length, 4);
  assert.equal(copy.target, 7);
  assert.deepEqual(copy.notes, source.notes);
  assert.notEqual(copy.notes[0], clip.notes[0]);
  key(cv, 'x', { [modifier]: true });
  assert.equal(song.clips.length, 1);
  assert.equal(song.selected, null);
  point(cv, 'pointermove', ax(8.4), ay(120));
  key(cv, 'v', { [modifier]: true });
  const pasted = ctx.clip();
  assert.equal(pasted.start, 8.25);
  assert.equal(pasted.y, 136);
  assert.notEqual(pasted.id, copy.id);
  assert.deepEqual(pasted.notes, source.notes);
  key(cv, 'v', { [modifier]: true });
  assert.equal(new Set(song.clips.map((c) => c.id)).size, 3);
  assert.notEqual(pasted.notes[0], ctx.clip().notes[0]);
  key(cv, 'Backspace');
  assert.equal(song.clips.length, 2);
  fire(cv, 'pointerleave');
  key(cv, 'v', { [modifier]: true });
  assert.equal(song.clips.length, 2);
}

// Clipboard/deletion commands during a drag must not mutate the captured objects.
{
  const { song, clip, roll, arranger } = setup();
  clip.length = 4;
  clip.notes.push(note(60, 1));
  const cv = roll.surface.cv;
  point(cv, 'pointerdown', nx(60), ny(1) + 5, { buttons: 1 });
  key(cv, 'x', { ctrlKey: true });
  key(cv, 'Backspace');
  assert.equal(clip.notes.length, 1);
  point(cv, 'pointerup', nx(60), ny(1) + 5);
  const acv = arranger.surface.cv;
  point(acv, 'pointerdown', ax(1), ay(0), { buttons: 1 });
  key(acv, 'x', { ctrlKey: true });
  key(acv, 'Delete');
  assert.equal(song.clips.length, 1);
  point(acv, 'pointerup', ax(1), ay(0));
  key(acv, 'Delete');
  assert.equal(song.clips.length, 0);
}

// Existing arranger move, edge resize, duplication and ruler seek remain intact.
{
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.notes.push(note(60, 1));
  drag(cv, ax(1), ay(0), ax(3), ay(40));
  assert.equal(clip.start, 2);
  assert.equal(clip.y, 34, 'vertical moves snap to lanes');
  drag(cv, ax(6) - 1, ay(40), ax(7) - 1, ay(40));
  assert.equal(clip.length, 5);
  drag(cv, ax(2) + 1, ay(40), ax(3) + 1, ay(40));
  assert.equal(clip.start, 3);
  assert.equal(clip.notes[0].start, 0);
  assert.equal(clip.length, 4);
  click(cv, ax(4), ay(40), { altKey: true });
  assert.equal(song.clips.length, 1);
  drag(cv, ax(4), ay(40), ax(9), ay(100), { altKey: true });
  assert.equal(song.clips.length, 2);
  assert.equal(ctx.clip().start, 8);
  assert.equal(ctx.clip().y, 102);
  click(cv, ax(5.37), 27);
  assert.equal(ctx.transport.pos, 5.25);
}

// Clipboard placement follows the current triplet grid and scrolled arranger coordinates.
{
  const { song, clip, roll, arranger, ctx } = setup();
  song.snap = { base: 4, div: 3 };
  clip.notes.push(note(60, -0.5, 0.5, 0.6), note(64, 0, 1, 0.9));
  const cv = roll.surface.cv;
  key(cv, 'a', { ctrlKey: true });
  key(cv, 'c', { ctrlKey: true });
  point(cv, 'pointermove', nx(70), ny(1.4));
  key(cv, 'v', { ctrlKey: true });
  assert.deepEqual(clip.notes.slice(2).map((n) => n.start), [1.333333333, 1.833333333]);
  const acv = arranger.surface.cv;
  key(acv, 'c', { ctrlKey: true });
  clip.y = 350;
  arranger.setView({ sx: 80, sy: 20, ppq: 32 });
  flush();
  point(acv, 'pointermove', 210, 135);
  key(acv, 'v', { ctrlKey: true });
  assert.equal(ctx.clip().start, 6.666666667);
  assert.equal(ctx.clip().y, 102);
}

// Cancelling a marquee restores selection; panning releases its keyboard-edit guard.
{
  const { clip, roll, arranger, song } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1), note(64, 1));
  click(cv, nx(60), ny(1) + 5);
  drag(cv, nx(63), ny(1), nx(65), ny(2), { shiftKey: true }, 'pointercancel');
  key(cv, 'Delete');
  assert.deepEqual(clip.notes.map((n) => n.pitch), [64]);
  key(cv, 'a', { ctrlKey: true });
  drag(cv, 300, 300, 280, 280, { button: 1, buttons: 4 });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 0);
  const acv = arranger.surface.cv;
  drag(acv, 300, 300, 280, 280, { button: 1, buttons: 4 });
  key(acv, 'Delete');
  assert.equal(song.clips.length, 0);
}

// Replacing a clip with the same ID must not retain stale selection references.
{
  const { song, clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1));
  key(cv, 'a', { ctrlKey: true });
  song.clips = [structuredClone(clip)];
  key(cv, 'Delete');
  assert.equal(song.clips[0].notes.length, 1);
}

// A clone must be clear of its source immediately, not only after releasing the drag.
{
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.notes.push(note(60, 1, 0.5, 0.4));
  point(cv, 'pointerdown', ax(1), ay(0), { buttons: 1, altKey: true });
  const copy = ctx.clip();
  assert.notEqual(copy, clip);
  assert.equal(copy.start, 0);
  assert.equal(copy.y, 34);
  point(cv, 'pointermove', ax(1.25), ay(0), { buttons: 1, altKey: true });
  assert.equal(copy.start, 0.25);
  assert.equal(copy.y, 34);
  point(cv, 'pointerup', ax(1.25), ay(0), { altKey: true });
  assert.equal(song.clips.length, 2);
  assert.equal(clip.start, 0);
  assert.equal(clip.y, 0);
  assert.deepEqual(copy.notes, clip.notes);
  assert.notEqual(copy.notes[0], clip.notes[0]);
  assertNoOverlap(song);
}

// Moving snaps at the nearest edge during the drag and follows the original pointer offset.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const moving = addClip(song, { start: 6, length: 4 });
  point(cv, 'pointerdown', ax(7), ay(0), { buttons: 1 });
  point(cv, 'pointermove', ax(4.5), ay(0), { buttons: 1 });
  assert.equal(moving.start, 4);
  assert.equal(moving.y, 0);
  assertNoOverlap(song);
  point(cv, 'pointermove', ax(1), ay(0), { buttons: 1 });
  assert.equal(moving.start, 0);
  assert.equal(moving.y, 34);
  assertNoOverlap(song);
  point(cv, 'pointermove', ax(8), ay(0), { buttons: 1 });
  assert.equal(moving.start, 7);
  assert.equal(moving.y, 0);
  point(cv, 'pointerup', ax(8), ay(0));
  assertNoOverlap(song);
  assert.equal(clip.start, 0);
  assert.equal(clip.y, 0);
}

// Paste checks the entire footprint, including other clips outside the pointer's hit box.
{
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const blocker = addClip(song, { start: 6, length: 4 });
  key(cv, 'c', { ctrlKey: true });
  point(cv, 'pointermove', ax(3), ay(0));
  key(cv, 'v', { ctrlKey: true });
  const copy = ctx.clip();
  assert.equal(copy.start, 3);
  assert.equal(copy.y, 34);
  assertNoOverlap(song);
  key(cv, 'v', { ctrlKey: true });
  assertNoOverlap(song);
  assert.equal(blocker.start, 6);
  assert.equal(blocker.y, 0);
}

// TimeLine: rectangle selection, group move, delete; a click on empty space clears the selection.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const b = addClip(song, { start: 6, length: 4 });
  const c = addClip(song, { start: 20, length: 4 });
  drag(cv, ax(0.5), ay(60), ax(7), ay(0));
  point(cv, 'pointerdown', ax(1), ay(0), { buttons: 1 });
  point(cv, 'pointermove', ax(3), ay(0), { buttons: 1 });
  point(cv, 'pointerup', ax(3), ay(0));
  assert.deepEqual([clip.start, b.start, c.start], [2, 8, 20]);
  assertNoOverlap(song);
  key(cv, 'Delete');
  assert.deepEqual(song.clips, [c]);
}

// Ctrl/Cmd + click toggles; Alt + drag copies keep the name (no " copy" suffix).
{
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.name = 'Riff';
  const b = addClip(song, { start: 6, length: 4 });
  click(cv, ax(1), ay(0));
  click(cv, ax(7), ay(0), { ctrlKey: true });
  drag(cv, ax(1), ay(0), ax(1), ay(40), { altKey: true });
  assert.equal(song.clips.length, 4);
  assert.ok(song.clips.every((c) => !c.name.includes('copy')));
  assert.equal(song.clips.filter((c) => c.name === 'Riff').length, 2);
  assert.equal(clip.start, 0);
  assert.equal(b.start, 6);
  assertNoOverlap(song);
  assert.notEqual(ctx.clip(), clip);
}

// Shift + drag makes a linked clone that shares the notes; the menu detaches it again.
{
  const { song, clip, arranger, menus } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.notes.push(note(60, 1));
  drag(cv, ax(1), ay(0), ax(7), ay(0), { shiftKey: true });
  assert.equal(song.clips.length, 2);
  const clone = song.clips.find((c) => c !== clip);
  assert.equal(clone.notes, clip.notes, 'clones share one note array');
  assert.ok(clip.link && clone.link === clip.link);
  clip.notes.push(note(62, 2));
  assert.equal(clone.notes.length, 2);
  click(cv, ax(clone.start + 1), ay(0), { button: 2 });
  assert.ok(labels(menus).includes('Detach clone'), labels(menus).join());
  pick(menus, 'Detach clone');
  assert.notEqual(clone.notes, clip.notes);
  assert.deepEqual(clone.notes, clip.notes);
  assert.equal(clone.link, undefined);
  assert.equal(clip.link, undefined, 'a group of one is no link');
  // menu Clone on the original creates a new linked clone
  click(cv, ax(1), ay(0), { button: 2 });
  pick(menus, 'Clone (linked)');
  assert.equal(song.clips.length, 3);
  const again = song.clips.at(-1);
  assert.equal(again.notes, clip.notes);
  assertNoOverlap(song);
  // empty-space menu: Paste disabled until something was copied
  click(cv, ax(40), ay(80), { button: 2 });
  assert.equal(menus.at(-1).items.find((i) => i.label === 'Paste').disabled, true);
}

// Clips can be dragged before time zero and the view scrolls there; lanes are numbered in the gutter.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  drag(cv, ax(1), ay(0), ax(-3), ay(0)); // the pointer may leave the time area to the left
  assert.equal(clip.start, -4);
  arranger.setView({ sx: -12 * 16, sy: 0, ppq: 16 });
  flush();
  assert.equal(arranger.getView().sx, -12 * 16, 'scrolling before zero is allowed');
  arranger.setView({ sx: -100 * 16, sy: 0, ppq: 16 });
  flush();
  assert.equal(arranger.getView().sx, -(4 + 16) * 16, 'down to 4 bars before the earliest clip');
  const texts = cv.drawing.filter(([op]) => op === 'fillText').map(([, t]) => t);
  assert.ok(texts.includes('1') && texts.includes('2') && texts.includes('3'), 'lane numbers');
  assert.ok(texts.includes('before start · not played'));
  assert.ok(texts.includes('-2') && texts.includes('0'), 'bars before zero are numbered 0, -1, -2, ...');
  // double-click inserts on the lane under the pointer
  arranger.setView({ sx: 0, sy: 0, ppq: 16 });
  flush();
  point(cv, 'dblclick', ax(8), 38 + 34 * 2 + 3);
  assert.equal(song.clips.at(-1).y, 68);
}

// Clones are hatched; a selected clone shows a dashed arrow to its source; the menu jumps there.
{
  const { song, clip, arranger, menus } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.y = 68;
  drag(cv, ax(1), ay(68), ax(9), ay(68), { shiftKey: true });
  const clone = song.clips.find((c) => c !== clip);
  assert.equal(song.selected, clone.id);
  const redraw = () => { cv.drawing.length = 0; arranger.redraw(); flush(); };
  redraw();
  assert.ok(cv.drawing.some(([op]) => op === 'quadraticCurveTo'), 'arrow from the selected clone');
  assert.equal(cv.drawing.filter(([op, , w]) => op === 'stroke' && w === 4).length, 1, 'only the clone is hatched');
  click(cv, ax(1), ay(68));
  redraw();
  assert.ok(!cv.drawing.some(([op]) => op === 'quadraticCurveTo'), 'no arrow when the source is selected');
  click(cv, ax(clone.start + 1), ay(68), { button: 2 });
  pick(menus, 'Go to source');
  assert.equal(song.selected, clip.id);
  click(cv, ax(1), ay(68), { button: 2 });
  assert.equal(menus.at(-1).items.find((i) => i.label === 'Go to source').disabled, true);
}

// Velocity strip: drag a note's handle, then shape one shared curve for several notes.
{
  const { clip, roll, changes, menus } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  clip.notes.push(note(60, 0, 1, 0.5), note(62, 2, 2, 0.5), note(64, 0, 1, 0.3));
  flush();
  // drag the first note's handle: it becomes the selection and its velocity follows
  drag(cv, vx(0.5), ny(0), vx(0.9), ny(0.3));
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9);
  assert.equal(clip.notes[1].vel, 0.5, 'other notes unchanged');
  assert.equal(clip.notes[2].vel, 0.3);
  key(cv, 'Backspace');
  assert.equal(clip.notes.length, 2, 'the dragged note was selected');
  const a = clip.notes.find((n) => n.start === 0); // 0..1, velocity 0.3
  const b = clip.notes.find((n) => n.start === 2); // 2..4, velocity 0.5
  // select both (one curve, two points as they differ), move the first point to 0.5: flat
  key(cv, 'a', { ctrlKey: true });
  drag(cv, vx(0.3), ny(0), vx(0.5), ny(0));
  assert.ok(Math.abs(a.vel - 0.5) < 1e-9);
  // double-click inside the selection adds a point at the snapped time; drag it to 1
  dbl(cv, vx(0.5), ny(3.05));
  assert.deepEqual(b.vels?.map((p) => p.t), [1], 'shared point at t=3 lands inside the second note');
  assert.equal(b.vels[0].r, 1, 'new points start fully rounded');
  drag(cv, vx(b.vels[0].v), ny(3), vx(1), ny(3));
  assert.equal(b.vels[0].v, 1);
  assert.equal(b.vel, 0.5, 'the shared point at t=2 keeps the start of the second note');
  assert.equal('vels' in a, false, 'flat before t=2: the first note stays constant');
  // move the t=2 point up to t=0.5 (it stays after the first point): now the first note ramps too
  drag(cv, vx(0.5), ny(2), vx(0.5), ny(0.5));
  assert.equal(a.vel, 0.5);
  assert.deepEqual(a.vels?.map((p) => p.t), [0.5, 1], 'first note follows the line until its end');
  assert.ok(b.vel > 0.5 && b.vel < 1, 'second note starts on the line');
  // wheel rounds the point; right click offers deletion without deleting immediately
  point(cv, 'wheel', vx(1), ny(3), { deltaY: -100 });
  assert.equal(b.vels[0].r, 1, 'already at maximum rounding');
  point(cv, 'wheel', vx(1), ny(3), { deltaY: 100 });
  assert.equal(b.vels[0].r, 0.95);
  point(cv, 'pointerdown', vx(1), ny(3), { button: 2 });
  point(cv, 'pointerup', vx(1), ny(3), { button: 2 });
  assert.ok(b.vels);
  pick(menus, 'Delete point');
  assert.equal('vels' in b, false);
  assert.ok(changes() > 4);
}

// Velocity snapping: all sixteen intervals, including both endpoints, without a drawn grid.
for (const value of [-0.1, ...Array.from({ length: 17 }, (_, i) => (i + 0.2) / 16), 0.531249, 0.53125, 0.531251, 1.2]) {
  const { clip, roll } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 3, 0.5));
  drag(cv, 7 + 0.5 * 70, ny(1), 7 + value * 70, ny(1));
  assert.equal(clip.notes[0].vel, Math.round(Math.max(0, Math.min(1, value)) * 16) / 16);
}
{
  const { clip, roll, menus, changes, initialSnap, song } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  assert.equal(initialSnap, true, 'new piano rolls enable snapping by default');
  clip.notes.push(note(60, 1, 3, 0.53));
  const before = structuredClone(clip.notes);
  point(cv, 'pointerdown', 35, ny(5), { button: 2 });
  assert.deepEqual(labels(menus), ['Snap velocity values'], 'blank lane offers the toggle');
  assert.equal(menus.at(-1).items[0].checked, true);
  pick(menus, 'Snap velocity values');
  assert.equal(roll.getView().snapVelocity, false);
  assert.deepEqual(clip.notes, before, 'toggling does not quantize existing values');
  assert.equal(changes(), 1, 'toggle schedules persistence');
  drag(cv, vx(0.53), ny(1), vx(0.9), ny(1));
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'disabled toggle restores free editing');
  point(cv, 'pointerdown', 35, ny(5), { button: 2 });
  assert.equal(menus.at(-1).items[0].checked, false);
  pick(menus, 'Snap velocity values');
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'enabling leaves old values untouched too');
  drag(cv, vx(0.9), ny(1), vx(0.6), ny(1), {}, 'pointercancel');
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'cancellation restores the original unsnapped value');
  // Fine movement is still snapped.
  drag(cv, vx(0.9), ny(1), vx(0.6), ny(1), { shiftKey: true });
  assert.equal(clip.notes[0].vel, 0.875);
  drag(cv, vx(0.875), ny(1), vx(0.6), ny(1), {}, 'pointercancel');
  assert.equal(clip.notes[0].vel, 0.875);
  const saved = roll.getView();
  roll.setView({ ...saved, snapVelocity: false });
  roll.setView(saved);
  assert.equal(roll.getView().snapVelocity, true, 'roll view round-trip');
  roll.setView({ ...saved, snapVelocity: false });
  const off = roll.getView();
  roll.setView(null);
  assert.equal(roll.getView().snapVelocity, true, 'new / older projects use the default');
  roll.setView(off);
  assert.equal(roll.getView().snapVelocity, false, 'saved false survives restoring');
  song.selected = null;
  point(cv, 'pointerdown', 35, ny(5), { button: 2 });
  assert.equal(menus.at(-1).items[0].checked, false, 'setting is available without a selected clip');
  cv.drawing.length = 0;
  roll.redraw(); flush();
  for (const x of [7.5, 42.5, 77.5]) {
    assert.equal(cv.drawing.some(([op, px, py]) => op === 'lineTo' && px === x && py === 376), false, 'no velocity grid lines');
  }
}
{
  const { clip, roll, menus } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  clip.notes.push(note(60, 1, 3, 0.5), note(64, 1, 3, 0.5));
  key(cv, 'a', { ctrlKey: true });
  dbl(cv, vx(0.71), ny(2));
  for (const n of clip.notes) {
    assert.equal(n.vel, 0.5);
    assert.equal(n.vels[0].v, 0.6875, 'new shared curve point snaps');
    assert.equal(n.vels[0].t, 1, 'time snapping unchanged');
  }
  drag(cv, vx(0.6875), ny(2), vx(0.91), ny(2.5));
  for (const n of clip.notes) {
    assert.equal(n.vels[0].v, 0.9375, 'existing curve point snaps');
    assert.equal(n.vels[0].t, 1.5);
  }
  dbl(cv, vx(0.31), ny(2.5));
  for (const n of clip.notes) {
    assert.equal(n.vels.length, 1);
    assert.equal(n.vels[0].v, 0.3125, 'replacing a point at the same time also snaps');
  }
  point(cv, 'pointerdown', vx(0.5), ny(1), { button: 2 });
  const firstMenu = menus.at(-1).items;
  assert.equal(firstMenu.find((i) => i.label === 'Delete point').disabled, true, 'cannot delete the start point');
  point(cv, 'pointerdown', vx(0.3125), ny(2.5), { button: 2 });
  assert.ok(clip.notes[0].vels, 'opening menu does not delete');
  pick(menus, 'Delete point');
  assert.ok(clip.notes.every((n) => !n.vels), 'deletion still works for shared curves');
}

// Double right-click on empty TimeLine space inserts an automation clip.
{
  const { song, arranger, ctx } = setup();
  ctx.defaultAutoTarget = () => 3;
  const cv = arranger.surface.cv;
  point(cv, 'pointerdown', ax(20), ay(100), { button: 2 });
  assert.equal(song.clips.length, 1, 'a single right-click inserts nothing');
  point(cv, 'pointerdown', ax(20), ay(100), { button: 2 });
  assert.equal(song.clips.length, 2);
  const a = ctx.clip();
  assert.ok(isAuto(a));
  assert.equal(a.target, 3);
  assert.equal(a.controller, 0);
  assert.equal(a.start, 20);
  // far apart presses are no double click; right-clicking a clip does not insert
  point(cv, 'pointerdown', ax(40), ay(100), { button: 2 });
  point(cv, 'pointerdown', ax(60), ay(100), { button: 2 });
  point(cv, 'pointerdown', ax(1), ay(0), { button: 2 });
  point(cv, 'pointerdown', ax(1), ay(0), { button: 2 });
  assert.equal(song.clips.length, 2);
}

// Automation lane: insert, drag (snapped, between neighbours), round, delete.
{
  const song = emptySong();
  const a = addAutoClip(song, { length: 8, target: 1, controller: 0 });
  song.selected = a.id;
  let changes = 0;
  const lane = createAutomationLane(host(), {
    song: () => song, clip: () => a, color: () => '#e76f51', transport: { playing: false, pos: 0 },
    changed() { changes++; }, autoParam: () => ({ p: {}, format: (v) => `${Math.round(v * 100)}` }),
  });
  flush();
  const cv = lane.surface.cv;
  const lx = (v) => 48 + v * 420;
  const ly = (t) => t * 48;
  dbl(cv, lx(0.25), ly(1.1));
  assert.deepEqual(a.points, [{ t: 1, v: 0.25, r: 1 }], 'time snaps to the grid, new points start fully rounded');
  dbl(cv, lx(0.75), ly(3));
  dbl(cv, lx(0.5), ly(2));
  assert.deepEqual(a.points.map((p) => p.t), [1, 2, 3], 'kept in time order');
  dbl(cv, lx(0.5), ly(2));
  assert.equal(a.points.length, 3, 'double-clicking a point adds nothing');
  // drag the middle point: value follows, time snaps and stays between its neighbours
  drag(cv, lx(0.5), ly(2), lx(1), ly(5));
  assert.equal(a.points[1].v, 1);
  assert.equal(a.points[1].t, 3);
  drag(cv, lx(1), ly(3), lx(0.5), ly(2.4));
  assert.equal(a.points[1].t, 2.5);
  assert.equal(a.points[1].v, 0.5);
  // wheel rounds the corner (down = sharper, capped at full rounding)
  point(cv, 'wheel', lx(0.5), ly(2.5), { deltaY: 100 });
  point(cv, 'wheel', lx(0.5), ly(2.5), { deltaY: 100 });
  assert.equal(a.points[1].r, 0.9);
  point(cv, 'wheel', lx(0.5), ly(2.5), { deltaY: -100 });
  point(cv, 'wheel', lx(0.5), ly(2.5), { deltaY: -100 });
  point(cv, 'wheel', lx(0.5), ly(2.5), { deltaY: -100 });
  assert.equal(a.points[1].r, 1);
  // right click deletes, Backspace deletes the selected point
  point(cv, 'pointerdown', lx(0.75), ly(3), { button: 2 });
  assert.deepEqual(a.points.map((p) => p.t), [1, 2.5]);
  click(cv, lx(0.25), ly(1));
  key(cv, 'Backspace');
  assert.deepEqual(a.points.map((p) => p.t), [2.5]);
  assert.ok(changes >= 8);
  assert.deepEqual(Object.keys(lane.getView()).sort(), ['ppq', 'sy']);
  // down-up-DOWN inserts on the second press, and that press keeps dragging the new point
  point(cv, 'pointerdown', lx(0.5), ly(6), { buttons: 1 });
  point(cv, 'pointerup', lx(0.5), ly(6));
  point(cv, 'pointerdown', lx(0.5), ly(6), { buttons: 1 });
  assert.deepEqual(a.points.map((p) => p.t), [2.5, 6], 'inserted before the second release');
  point(cv, 'pointermove', lx(0.8), ly(7), { buttons: 1 });
  point(cv, 'pointerup', lx(0.8), ly(7));
  assert.equal(a.points[1].t, 7);
  assert.ok(Math.abs(a.points[1].v - 0.8) < 1e-9, 'the held press drags it');
  // slow presses are two clicks, not a double-click
  point(cv, 'pointerdown', lx(0.5), ly(9), { buttons: 1, timeStamp: 0 });
  point(cv, 'pointerup', lx(0.5), ly(9));
  point(cv, 'pointerdown', lx(0.5), ly(9), { buttons: 1, timeStamp: 1000 });
  point(cv, 'pointerup', lx(0.5), ly(9));
  assert.equal(a.points.length, 2);
}

// An empty double-click location can still produce a clip whose tail overlaps a neighbour.
{
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  clip.start = 4;
  clip.length = 4;
  point(cv, 'dblclick', ax(1), ay(0));
  assert.equal(song.clips.length, 2);
  assert.equal(ctx.clip().start, 0);
  assert.equal(ctx.clip().y, 0);
  assertNoOverlap(song);
}

// Resizing stops at off-grid neighbours without moving the clip or its stationary edge.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.start = 4;
  clip.length = 4;
  clip.notes.push(note(60, 1));
  const left = addClip(song, { start: 1, length: 2.3, y: 20 });
  const right = addClip(song, { start: 9.1, length: 4, y: 20 });
  drag(cv, ax(8) - 1, ay(0), ax(12) - 1, ay(0));
  assert.equal(clip.start, 4);
  assert.equal(clip.length, 5.1);
  assert.equal(clip.y, 0);
  assertNoOverlap(song);
  drag(cv, ax(4) + 1, ay(0), ax(2) + 1, ay(0));
  assert.equal(clip.start, 3.3);
  assert.equal(clip.length, 5.8);
  assert.equal(clip.notes[0].start, 1.7);
  assert.equal(clip.y, 0);
  assert.equal(left.length, 2.3);
  assert.equal(right.start, 9.1);
  assertNoOverlap(song);
}

// Toolbar editing APIs share the collision rules, and separate rows may play concurrently.
{
  const { song, clip, arranger } = setup();
  clip.length = 4;
  const other = addClip(song, { start: 6, length: 4 });
  arranger.setLength(clip, 10);
  assert.equal(clip.length, 6);
  arranger.place(other, { start: 5 });
  assert.equal(other.start, 6);
  arranger.place(other, { start: 0 });
  assert.equal(other.start, 0);
  assert.equal(other.y, 34);
  arranger.setLength(other, 20);
  assert.equal(other.length, 20);
  assertNoOverlap(song);
}

// Very fine snap steps remain available when resizing.
{
  const { song, clip, arranger } = setup();
  song.snap = { base: 128, div: 64 };
  clip.length = 0.01;
  arranger.setView({ ppq: 200 });
  flush();
  const cv = arranger.surface.cv;
  drag(cv, 71.9, ay(0), 68, ay(0));
  assert.equal(clip.length, 4 / 128 / 64);
}

// Alt-click and cancelled cloning leave no extra clip after previewing a free placement.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  click(cv, ax(1), ay(0), { altKey: true });
  assert.equal(song.clips.length, 1);
  drag(cv, ax(1), ay(0), ax(1.25), ay(0), { altKey: true }, 'pointercancel');
  assert.equal(song.clips.length, 1);
  assert.equal(song.selected, clip.id);
  assertNoOverlap(song);
}

// The keyboard stays below the grid and cannot insert/paste/delete notes.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1));
  key(cv, 'a', { ctrlKey: true });
  key(cv, 'c', { ctrlKey: true });
  const before = structuredClone(clip.notes);
  click(cv, nx(60), 380);
  key(cv, 'v', { ctrlKey: true });
  click(cv, nx(60), 380, { button: 2 });
  assert.deepEqual(clip.notes, before);
  assert.ok(cv.drawing.some(([op, x, y, w, h]) => op === 'fillRect' && x === 0 && y === 376 && w === ROLL_WIDTH && h === 24));
  assert.ok(cv.drawing.some(([op, x, y, w, h]) => op === 'roundRect' && x === nx(60) - 7.5 && y === 48 && w === 15 && h === 48));
  assert.ok(cv.drawing.some(([op, x, y, rx, ry, tilt]) => op === 'ellipse' && x === nx(60) && rx > ry && tilt < 0));
  assert.ok(cv.drawing.some(([op, color]) => op === 'fill' && color === '#65b4ff'));
  assert.ok(cv.drawing.some(([op, color, width]) => op === 'stroke' && color === '#5d606a' && width === 2));
  assert.ok(cv.drawing.some(([op, color, width]) => op === 'stroke' && color === '#a1a7b3' && width === 4));
  click(cv, nx(70), 0);
  assert.equal(clip.notes.at(-1).start, 0);
  point(cv, 'pointermove', nx(72), 96);
  const atPointer = (96 + roll.getView().sy) / roll.getView().ppq;
  fire(cv, 'wheel', { clientX: nx(72), clientY: 96, deltaY: -100, deltaMode: 0, ctrlKey: true });
  assert.ok(Math.abs((96 + roll.getView().sy) / roll.getView().ppq - atPointer) < 1e-9);
}

// Arrow keys transpose/move just the selection, preserving timing, intervals, lengths and velocities.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const a = note(60, 1, 0.5, 0.3);
  const b = note(64, 1.5, 0.75, 0.9);
  const outside = note(70, 3);
  clip.notes.push(a, b, outside);
  drag(cv, nx(59), ny(0.8), nx(65), ny(2.5), { shiftKey: true });
  assert.ok(key(cv, 'ArrowRight').defaultPrevented);
  assert.deepEqual([a.pitch, b.pitch, outside.pitch], [61, 65, 70]);
  key(cv, 'ArrowLeft');
  assert.deepEqual([a.pitch, b.pitch], [60, 64]);
  key(cv, 'ArrowUp');
  assert.deepEqual([a.start, b.start], [0.75, 1.25]);
  key(cv, 'ArrowDown', { repeat: true });
  assert.deepEqual([a.start, b.start, outside.start], [1, 1.5, 3]);
  assert.deepEqual([a.length, b.length, a.vel, b.vel], [0.5, 0.75, 0.3, 0.9]);
  assert.equal(changes(), 4);
  key(cv, 'c', { ctrlKey: true });
  key(cv, 'ArrowRight');
  point(cv, 'pointermove', nx(75), ny(4));
  key(cv, 'v', { ctrlKey: true });
  assert.deepEqual(clip.notes.slice(-2).map((n) => [n.pitch, n.start]), [[60, 4], [64, 4.5]]);
}

// Exact snap increments (including triplets) and group boundaries never distort a selection.
{
  const { song, clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(0.5, 0.1), note(126.5, 0.6));
  key(cv, 'a', { ctrlKey: true });
  const before = structuredClone(clip.notes);
  key(cv, 'ArrowLeft');
  key(cv, 'ArrowRight');
  key(cv, 'ArrowUp');
  assert.deepEqual(clip.notes, before);
  assert.equal(changes(), 0);
  song.snap = { base: 4, div: 3 };
  key(cv, 'ArrowDown');
  assert.deepEqual(clip.notes.map((n) => n.start), [0.433333333, 0.933333333]);
  key(cv, 'ArrowUp');
  assert.deepEqual(clip.notes, before);
  clip.notes[0].start = 0;
  key(cv, 'ArrowUp');
  assert.equal(clip.notes[0].start, 0);
}

// Unselected clips, modified arrows and in-progress drags are not edited by arrow commands.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1));
  key(cv, 'ArrowRight');
  assert.equal(clip.notes[0].pitch, 60);
  key(cv, 'a', { ctrlKey: true });
  for (const props of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(key(cv, 'ArrowRight', props).defaultPrevented, false);
  }
  assert.equal(changes(), 0);
  point(cv, 'pointerdown', nx(60), ny(1) + 5, { buttons: 1 });
  key(cv, 'ArrowDown');
  assert.equal(clip.notes[0].start, 1);
  point(cv, 'pointerup', nx(60), ny(1) + 5);
}

// Chromatic chords use darker fills for black keys, including selected notes after transposition.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  for (let pitch = 60; pitch < 72; pitch++) clip.notes.push(note(pitch, 1, 2));
  const fills = () => cv.drawing.flatMap((op, i) => op[0] === 'roundRect' ? [cv.drawing[i + 1][1]] : []);
  cv.drawing.length = 0;
  roll.redraw();
  flush();
  const white = 'color-mix(in srgb, #e76f51 75%, #fff)';
  const black = `color-mix(in srgb, ${white} 86%, #000)`;
  const pattern = [false, true, false, true, false, false, true, false, true, false, true, false];
  assert.deepEqual(fills(), pattern.map((b) => b ? black : white));
  cv.drawing.length = 0;
  key(cv, 'a', { ctrlKey: true });
  assert.deepEqual(fills(), pattern.map((b) => b ? 'color-mix(in srgb, #65b4ff 86%, #000)' : '#65b4ff'));
  cv.drawing.length = 0;
  key(cv, 'ArrowRight');
  assert.deepEqual(fills(), [...pattern.slice(1), pattern[0]].map((b) => b ? 'color-mix(in srgb, #65b4ff 86%, #000)' : '#65b4ff'));

  // Keep a genuinely dark canvas without inverting the stave, and retain strong selection contrast.
  const rgb = (hex) => hex.slice(1).match(/../g).map((c) => parseInt(c, 16));
  const luminance = (rgb) => rgb.map((v) => v / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05)
    / (Math.min(luminance(a), luminance(b)) + 0.05);
  const background = rgb(cv.drawing.find(([op, x, y, w, h]) =>
    op === 'fillRect' && x === 0 && y === 0 && w === ROLL_WIDTH && h === 400)[5]);
  const stave = rgb(cv.drawing.find(([op, color]) => op === 'stroke' && color === '#111216')[1]);
  const selection = rgb(fills().find((color) => color[0] === '#'));
  assert.ok(luminance(background) < 0.08);
  assert.ok(luminance(stave) < luminance(background));
  assert.ok(contrast(stave, background) >= 1.8);
  assert.ok(contrast(selection, background) >= 4);
  assert.ok(contrast(selection.map((v) => v * 0.86), background) >= 3);
  assert.ok(contrast(rgb('#c3c7d0'), rgb('#292b31')) >= 4.5);
}

// The A#0/A#7 time grid scales with the viewport; saved manual horizontal zoom is ignored.
for (const width of [240, 480, 1000, 1912, 3000]) {
  const { roll, clip, rollHost } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(20, 1), note(108, 1));
  rollHost.clientWidth = width;
  rollHost.resize();
  cv.drawing.length = 0;
  roll.setView({ sx: 4676, kw: 40 });
  flush();
  const kw = (width - 120) / 128;
  const left = 120 + 22.5 * kw;
  const right = 120 + 106.5 * kw;
  const bands = cv.drawing.filter(([op, , , , , color]) => op === 'fillRect' && color === 'rgba(0, 0, 0, 0.06)');
  assert.ok(bands.length > 0);
  assert.ok(bands.every((b) => b[1] === left && b[3] === right - left));
  const lines = cv.drawing.flatMap(([op, color], i) => {
    const from = cv.drawing[i - 2];
    const to = cv.drawing[i - 1];
    if (op !== 'stroke' || !['#5d606a', '#797d88', '#a1a7b3'].includes(color)
      || from?.[0] !== 'moveTo' || to?.[0] !== 'lineTo' || to[1] === 120) return [];
    return [[from, to]];
  });
  assert.ok(lines.length > 0);
  assert.ok(lines.every(([from, to]) => from[1] === left && to[1] === right));
  const bodies = cv.drawing.filter(([op]) => op === 'roundRect');
  assert.equal(bodies.length, 2, 'notes outside the grid bounds are still drawn');
  assert.ok(bodies[0][1] < left && bodies[1][1] > right);
}

// Every MIDI pitch is editable and both end keys audition at real, narrow viewport widths.
for (const width of [300, 480, 900, 1912]) {
  const { clip, roll, rollHost, ctx } = setup();
  const cv = roll.surface.cv;
  rollHost.clientWidth = width;
  rollHost.resize();
  flush();
  const kw = (width - 120) / 128;
  const center = (pitch) => 120 + (pitch + 0.5) * kw;
  for (let pitch = 0; pitch < 128; pitch++) {
    cv.drawing.length = 0;
    click(cv, center(pitch), ny(1));
  }
  assert.deepEqual(clip.notes.map((n) => n.pitch), Array.from({ length: 128 }, (_, i) => i), `all pitches at width ${width}`);
  assert.ok(clip.notes.every((n) => n.start === 1));
  const keys = cv.drawing.filter(([op, , y, , h]) => op === 'fillRect' && y === 377 && h === 22).slice(-128);
  assert.equal(keys.length, 128);
  assert.ok(keys[0][1] >= 120 && keys.at(-1)[1] + keys.at(-1)[3] <= width + 1e-9, 'whole keyboard fits');
  const head = cv.drawing.find(([op, x]) => op === 'ellipse' && Math.abs(x - center(1)) < 1e-9);
  assert.ok(head);
  click(cv, center(0), ny(1) + 10, { button: 2 });
  click(cv, center(127), ny(1) + 10, { button: 2 });
  assert.deepEqual(clip.notes.map((n) => n.pitch), Array.from({ length: 126 }, (_, i) => i + 1), 'edge hit-testing deletes only the intended notes');
  drag(cv, center(1), head[2], center(2), head[2]);
  assert.equal(clip.notes[0].pitch, 2, 'one-column drag works even below three pixels');
  const played = [];
  const on = ctx.preview.on;
  ctx.preview.on = (c, pitch) => { played.push(pitch); return on(c, pitch); };
  click(cv, center(0), 390);
  click(cv, center(127), 390);
  assert.deepEqual(played, [0, 127], 'keys outside the 88-key range also audition');
  assert.equal(clip.notes.length, 126, 'audition never inserts notes');
}

// Resizing derives fresh geometry; neither old saved zoom nor Alt-scroll can crop the pitches.
{
  const { clip, roll, rollHost } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(0, 1), note(127, 1));
  const before = structuredClone(clip.notes);
  for (const width of [480, 1000, 260, 1500]) {
    cv.drawing.length = 0;
    rollHost.clientWidth = width;
    rollHost.resize();
    const centers = cv.drawing.filter(([op]) => op === 'ellipse').map((op) => op[1]);
    const kw = (width - 120) / 128;
    assert.deepEqual(centers, [120 + kw / 2, 120 + 127.5 * kw]);
    roll.setView({ sx: 4000, kw: 40, sy: 0, ppq: 48 });
    flush();
    fire(cv, 'wheel', { clientX: 200, clientY: 150, deltaX: 100, deltaY: 0, deltaMode: 0 });
    fire(cv, 'wheel', { clientX: 200, clientY: 150, deltaX: 0, deltaY: -100, deltaMode: 0, altKey: true });
    drag(cv, 200, 150, 250, 150, { button: 1 });
    roll.setView({ sy: 0 });
    cv.drawing.length = 0;
    roll.redraw(); flush();
    assert.deepEqual(cv.drawing.filter(([op]) => op === 'ellipse').map((op) => op[1]), centers);
    assert.deepEqual(clip.notes, before, 'resizing and scrolling do not alter the notes');
    assert.deepEqual(Object.keys(roll.getView()).sort(), ['ppq', 'snapVelocity', 'sy'], 'horizontal geometry is not persisted');
  }
}

// Top overscroll is a bounded, blank margin shared by notes, stave, ruler and velocity lane.
{
  const { clip, roll, initialView } = setup();
  const cv = roll.surface.cv;
  assert.equal(initialView.sy, -32, 'new rolls start with a little space above beat zero');
  fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaY: -10000, deltaX: 0, deltaMode: 0 });
  assert.equal(roll.getView().sy, -32, 'upward scrolling stops at the margin');
  click(cv, nx(60), 16);
  assert.equal(clip.notes.length, 0, 'blank margin is not note-entry space');
  cv.drawing.length = 0;
  point(cv, 'pointermove', nx(60), 16);
  assert.equal(cv.drawing.some(([op]) => op === 'ellipse'), false, 'no note preview in the margin');
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'moveTo' && x === nx(61) && y === 32), 'stave starts at beat zero, not at the canvas edge');
  assert.equal(cv.drawing.some(([op, x, y]) => op === 'moveTo' && x === nx(61) && y === 0), false);
  clip.notes.push(note(60, 0, 1, 0.5));
  cv.drawing.length = 0;
  roll.redraw(); flush();
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'arc' && x === 42 && y === 32), 'velocity handle aligns with beat zero');
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'roundRect' && x === nx(60) - 7.5 && y === 32), 'note starts below the margin');
  drag(cv, nx(59), 8, nx(61), 60, { shiftKey: true });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 0, 'selection can start in the margin to catch the first note');
  fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaY: 16, deltaX: 0, deltaMode: 0 });
  assert.equal(roll.getView().sy, -16, 'margin scrolls away naturally');
  roll.reveal(); flush();
  assert.equal(roll.getView().sy, -32, 'revealing a clip restores the margin');
  const saved = JSON.parse(JSON.stringify(roll.getView()));
  roll.setView({ sy: 80, ppq: 96 });
  roll.setView(saved); flush();
  assert.deepEqual(roll.getView(), saved, 'negative scroll offset survives a saved view');
}

// Collapsed panes and sub-pixel key widths must never produce negative radii or NaN geometry.
{
  const { clip, roll, rollHost } = setup();
  clip.notes.push(note(0, 1), note(127, 1));
  for (const width of [0, 80, 120, 121, 180, 480]) {
    rollHost.clientWidth = width;
    const cv = roll.surface.cv;
    cv.drawing.length = 0;
    assert.doesNotThrow(() => rollHost.resize());
    for (const op of cv.drawing) {
      assert.ok(op.filter((v) => typeof v === 'number').every(Number.isFinite), `finite drawing at width ${width}`);
      if (op[0] === 'ellipse') assert.ok(op[3] >= 0 && op[4] >= 0);
    }
  }
}

// Transport shortcuts use the real sequencer handler and keep editable controls/native keys intact.
{
  class Element extends Canvas {
    constructor(kind = 'div') {
      super();
      this.kind = kind;
      this.style.setProperty = (name, value) => { this.style[name] = value; };
      this.classes = new Set();
      this.classList.toggle = (name, value) => value ? this.classes.add(name) : this.classes.delete(name);
      this.attributes = new Map();
      this.clientWidth = 480;
      this.clientHeight = 400;
      this.scrollWidth = 480;
      this.scrollLeft = 0;
    }
    append() {}
    add() {}
    setAttribute(name, value) { this.attributes.set(name, value); }
    replaceChildren() {}
    contains(el) { return el === this; }
    blur() { document.activeElement = null; }
    closest(selector) { return this.kind !== 'div' && selector.includes(this.kind) ? this : null; }
  }
  const elements = new Map();
  const inputIds = ['seq-name', 'seq-start', 'seq-length', 'seq-snap-div'];
  for (const id of ['seq', 'seq-bar', 'seq-bar-content', 'seq-play', 'seq-pos', 'seq-target', 'seq-snap-base', 'seq-ctl', 'seq-ctl-field', 'seq-target-field', ...inputIds,
    'workspace', 'patcher', 'roll', 'arranger', 'seq-split', 'seq-hsplit', 'panel', 'panel-split', 'status']) {
    elements.set(id, new Element(inputIds.includes(id) ? 'input' : id === 'seq-play' ? 'button' : 'div'));
  }
  document.getElementById = (id) => elements.get(id);
  document.body = new Element();
  globalThis.Option = class { constructor(label, value) { this.label = label; this.value = value; } };
  globalThis.window = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
  const song = emptySong();
  const clip = addClip(song, { start: 4.25, length: 0.5 });
  song.selected = clip.id;
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: () => null, now: () => 0,
    ticker: () => ({ start() {}, stop() {} }),
  });
  let viewChanges = 0;
  const engine = { song, resume() {}, root: { modules: new Map(), listeners: new Set() } };
  const seq = createSequencer({
    engine,
    transport, getTarget: () => null, defaultTarget: () => null, onChange() { viewChanges++; },
  });
  seq.reload();
  flush();
  assert.equal(seq.viewState().roll.snapVelocity, true);
  seq.applyView({ roll: { snapVelocity: false } });
  const snapView = JSON.parse(JSON.stringify(seq.viewState()));
  seq.applyView(null);
  assert.equal(seq.viewState().roll.snapVelocity, true, 'new project resets the toggle');
  seq.applyView(snapView);
  assert.equal(seq.viewState().roll.snapVelocity, false, 'project view restores unchecked state');
  seq.applyView({ roll: { sx: 0, sy: 0 } });
  assert.equal(seq.viewState().roll.snapVelocity, true, 'old projects default to snapping');
  const press = (key, props = {}, target = elements.get('arranger')) => {
    const e = new Event('keydown', { cancelable: true });
    Object.assign(e, { key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...props });
    Object.defineProperty(e, 'target', { value: target });
    window.dispatchEvent(e);
    return e;
  };
  transport.seek(2);
  assert.ok(press('.').defaultPrevented);
  assert.equal(transport.playing, true);
  assert.equal(transport.pos, 2);
  assert.equal(transport.clipId, null);
  press('.');
  assert.equal(transport.playing, true);
  for (const props of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(press(',', props).defaultPrevented, false);
    assert.equal(transport.pos, 2);
  }
  assert.ok(press('/').defaultPrevented);
  assert.equal(transport.pos, 4.25);
  assert.equal(transport.clipId, clip.id);
  assert.match(elements.get('seq-play').title, /Stop clip loop/);
  transport.seek(4.5);
  press('/', { shiftKey: true }); // layouts where slash requires Shift
  assert.equal(transport.pos, 4.25);
  assert.ok(press(',').defaultPrevented);
  assert.equal(transport.clipId, null);
  assert.equal(transport.pos, 0);
  assert.equal(transport.playing, true);
  for (const kind of ['input', 'textarea', 'select', 'dialog', '[contenteditable]']) {
    for (const key of ['/', "'", '.', ',', ' ']) assert.equal(press(key, {}, new Element(kind)).defaultPrevented, false);
    assert.equal(transport.playing, true);
    assert.equal(transport.pos, 0);
  }
  const button = elements.get('seq-play');
  assert.equal(press(' ', {}, button).defaultPrevented, false);
  assert.ok(press("'", {}, button).defaultPrevented);
  assert.equal(transport.playing, false);
  press('/');
  press("'");
  assert.equal(transport.playing, false);
  assert.equal(transport.clipId, null);
  press(' ');
  assert.equal(transport.playing, true);
  transport.seek(1.5);
  press(' ');
  assert.equal(transport.playing, false);
  assert.equal(transport.pos, clip.start, 'Space pause parks the playhead at the selected clip start');
  press(' ');
  assert.equal(transport.pos, clip.start, 'next Space plays from the clip start');
  const selected = song.selected;
  song.selected = null;
  transport.seek(1.5);
  press(' ');
  assert.equal(transport.pos, 1.5, 'without a selected clip the playhead stays put');
  song.selected = selected;
  elements.get('seq-play').onclick();
  assert.equal(transport.playing, true);
  elements.get('seq-play').onclick();
  assert.equal(transport.pos, clip.start, 'the stop button does the same');
  song.selected = null;
  press('/');
  assert.equal(transport.playing, false);
  assert.match(elements.get('status').textContent, /Select a clip/);
  song.clips = [];
  press('.');
  assert.equal(transport.playing, false);
  assert.match(elements.get('status').textContent, /Nothing to play/);
  flush();

  // Ctrl/Cmd + Z / Shift + Z undo and redo recorded song edits (the clip removal above is recorded here).
  elements.get('seq-name').dispatchEvent(new Event('change'));
  const undoKey = (props) => {
    const e = new Event('keydown', { cancelable: true });
    Object.assign(e, { key: 'z', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...props });
    Object.defineProperty(e, 'target', { value: elements.get('arranger') });
    elements.get('seq').dispatchEvent(e);
    return e;
  };
  song.selected = clip.id;
  assert.ok(undoKey({ metaKey: true }).defaultPrevented);
  assert.equal(engine.song.clips.length, 1);
  assert.equal(engine.song.clips[0].start, 4.25);
  assert.equal(engine.song.selected, clip.id, 'the selection survives when the clip exists again');
  undoKey({ ctrlKey: true });
  assert.match(elements.get('status').textContent, /Nothing to undo/);
  undoKey({ ctrlKey: true, shiftKey: true });
  assert.equal(engine.song.clips.length, 0);
  undoKey({ ctrlKey: true, key: 'y' });
  assert.match(elements.get('status').textContent, /Nothing to undo/);
  engine.song = song;
  flush();

  // Send to and the automation controller are shared by linked clones
  {
    const src = addClip(song, { start: 0, length: 1 });
    src.target = 3;
    const clones = [cloneClip(song, src), cloneClip(song, src)];
    const other = addClip(song, { start: 8, length: 1 });
    other.target = 3;
    song.selected = clones[0].id;
    elements.get('seq-target').value = '7';
    elements.get('seq-target').dispatchEvent(new Event('change'));
    assert.deepEqual([src, ...clones].map((c) => c.target), [7, 7, 7], 'changing a clone changes its source and every clone');
    assert.equal(other.target, 3, 'unlinked clips keep theirs');
    song.selected = src.id;
    elements.get('seq-target').value = '';
    elements.get('seq-target').dispatchEvent(new Event('change'));
    assert.deepEqual([src, ...clones].map((c) => c.target), [null, null, null]);
    song.clips = [];
    song.selected = null;
    flush();
  }

  // S maximizes the middle patcher and restores both horizontal boundaries.
  seq.applyView({ top: 0.37, bottom: 0.81 });
  press('S');
  assert.equal(seq.viewState().top, 0);
  assert.equal(seq.viewState().bottom, 1);
  press('s');
  assert.equal(seq.viewState().top, 0.37);
  assert.equal(seq.viewState().bottom, 0.81);
  for (const props of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(press('s', props).defaultPrevented, false);
    assert.equal(seq.viewState().top, 0.37);
  }
  assert.equal(press('s', {}, new Element('input')).defaultPrevented, false);
  press('s');
  const hidden = JSON.parse(JSON.stringify(seq.viewState()));
  seq.applyView({ top: 0.8, bottom: 0.9 });
  seq.applyView(hidden);
  press('s');
  assert.equal(seq.viewState().top, 0.37, 'both restore positions survive saving/restoring');
  assert.equal(seq.viewState().bottom, 0.81);

  // Older side-by-side layouts migrate to the same relative pane areas.
  seq.applyView({ width: 0.5, split: 0.6 });
  assert.equal(seq.viewState().top, 0.3);
  assert.equal(seq.viewState().bottom, 0.8);
  assert.equal('width' in seq.viewState(), false);
  assert.equal('split' in seq.viewState(), false);
  seq.applyView({ open: false, width: 0.4, split: 0.5 });
  assert.equal(seq.viewState().top, 0);
  assert.equal(seq.viewState().bottom, 1);
  press('s');
  assert.equal(seq.viewState().top, 0.2);
  assert.equal(seq.viewState().bottom, 0.8);
  seq.applyView({ width: 0, restoreWidth: 0.8, split: 0.5 });
  press('s');
  assert.equal(seq.viewState().top, 0.4);
  assert.equal(seq.viewState().bottom, 0.6);
  seq.applyView(null);
  assert.equal(seq.viewState().top, 0.4, 'new projects reset the layout');
  assert.equal(seq.viewState().bottom, 0.75);

  window.innerWidth = 1000;
  const workspace = elements.get('workspace');
  workspace.getBoundingClientRect = () => ({ top: 100, height: 548 });
  elements.get('patcher').getBoundingClientRect = () => ({ left: 0, width: window.innerWidth });
  const upper = elements.get('seq-split');
  const lower = elements.get('seq-hsplit');
  const controller = elements.get('panel-split');
  controller.getBoundingClientRect = () => {
    const left = Math.min(seq.viewState().panelWidth, window.innerWidth - 24);
    return { left, right: left + 24, width: 24 };
  };
  upper.getBoundingClientRect = () => ({ top: 100 + seq.viewState().top * 500, height: 24 });
  lower.getBoundingClientRect = () => ({ top: 124 + seq.viewState().bottom * 500, height: 24 });
  const positions = () => [seq.viewState().top, seq.viewState().bottom];
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);
  const changesBeforeStackDrag = viewChanges;
  drag(upper, 300, 310, 900, 310);
  assert.deepEqual(positions(), [0.4, 0.75], 'sideways motion cannot move either horizontal boundary');
  assert.equal(seq.viewState().panelWidth, 880, 'upper divider also controls the controller width');
  drag(upper, 300, 310, 300, 360);
  near(seq.viewState().top, 0.5);
  assert.equal(seq.viewState().bottom, 0.75);
  assert.equal(viewChanges, changesBeforeStackDrag + 2, 'save once per drag');

  // Once the patcher is collapsed, either divider pushes the other, without crossing.
  drag(upper, 300, 360, 300, 560);
  near(seq.viewState().top, 0.9);
  near(seq.viewState().bottom, 0.9);
  assert.ok(workspace.classes.has('patcher-collapsed'));
  drag(upper, 300, 560, 300, 900);
  assert.deepEqual(positions(), [1, 1], 'upper divider can push the lower one to the bottom edge');
  assert.ok(workspace.classes.has('arranger-collapsed'));
  drag(upper, 300, 610, 300, 510);
  near(seq.viewState().top, 0.8);
  assert.equal(seq.viewState().bottom, 1, 'pulling back reopens only the patcher');
  seq.applyView({ top: 0.4, bottom: 0.75 });
  drag(lower, 300, 510, 900, 260);
  assert.deepEqual(positions(), [0.25, 0.25], 'lower divider pushes the upper one upward');
  drag(lower, 300, 260, 300, -500);
  assert.deepEqual(positions(), [0, 0], 'lower divider can push the upper one to the top edge');
  assert.ok(workspace.classes.has('roll-collapsed'));
  drag(lower, 300, 136, 300, 336);
  assert.deepEqual(positions(), [0, 0.4], 'collapsed patcher can be reopened');

  // Reversing a drag after a collision leaves the pushed divider in its new position.
  seq.applyView({ top: 0.4, bottom: 0.75 });
  point(lower, 'pointerdown', 300, 510);
  point(lower, 'pointermove', 300, 260);
  point(lower, 'pointermove', 300, 410);
  point(lower, 'pointerup', 300, 410);
  near(seq.viewState().top, 0.25);
  near(seq.viewState().bottom, 0.55);

  // Collapsing both sequencer panes by dragging keeps the last visible layout for S.
  seq.applyView({ top: 0.4, bottom: 0.75 });
  drag(upper, 300, 310, 300, -1000);
  drag(lower, 300, 510, 300, 1000);
  assert.deepEqual(positions(), [0, 1]);
  press('s');
  assert.deepEqual(positions(), [0, 0.75]);
  for (const [top, bottom] of [[0, 0], [0, 1], [1, 1], [0.3, 0.3], [0.2, 0.9]]) {
    seq.applyView({ top, bottom });
    const saved = JSON.parse(JSON.stringify(seq.viewState()));
    seq.applyView({ top: 0.4, bottom: 0.75 });
    seq.applyView(saved);
    assert.deepEqual(positions(), [top, bottom], 'all collapsed and open states survive saving/restoring');
  }
  // Fractional positions survive viewport changes; a new drag uses the current height.
  workspace.getBoundingClientRect = () => ({ top: 100, height: 1048 });
  drag(upper, 300, 310, 300, 410);
  near(seq.viewState().top, 0.3);
  assert.equal(seq.viewState().bottom, 0.9);
  workspace.getBoundingClientRect = () => ({ top: 100, height: 48 });
  const beforeZero = positions();
  drag(lower, 300, 510, 300, 200);
  assert.deepEqual(positions(), beforeZero, 'zero available height never creates invalid fractions');
  workspace.getBoundingClientRect = () => ({ top: 100, height: 548 });

  seq.applyView({ top: 0.4, bottom: 0.75 });
  key(lower, 'ArrowUp', { shiftKey: true });
  near(seq.viewState().bottom, 0.65);
  key(lower, 'Home');
  assert.deepEqual(positions(), [0, 0], 'keyboard resizing also pushes the other divider');
  assert.equal(upper.attributes.get('aria-valuenow'), '0');
  key(upper, 'End');
  assert.deepEqual(positions(), [1, 1]);
  assert.equal(lower.attributes.get('aria-valuenow'), '100');
  seq.applyView({ top: 0.4, bottom: 0.75 });
  key(upper, 'ArrowDown');
  near(seq.viewState().top, 0.42);
  const beforeCancel = viewChanges;
  drag(upper, 300, 310, 300, 360, {}, 'pointercancel');
  near(seq.viewState().top, 0.52);
  point(upper, 'pointermove', 300, 500);
  near(seq.viewState().top, 0.52);
  assert.equal(viewChanges, beforeCancel + 1);
  for (const bad of [NaN, Infinity, 'invalid']) {
    seq.applyView({ top: bad, bottom: bad, restoreTop: bad, restoreBottom: bad });
    near(seq.viewState().top, 0.52);
    assert.equal(seq.viewState().bottom, 0.75);
  }
  seq.applyView({ top: 5, bottom: -1 });
  assert.deepEqual(positions(), [1, 1], 'loaded boundaries remain ordered and clamped');

  // Either horizontal divider controls panel width while moving its own vertical boundary.
  seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
  drag(lower, 300, 510, 420, 560);
  assert.equal(seq.viewState().panelWidth, 400);
  near(seq.viewState().bottom, 0.85);
  assert.equal(seq.viewState().top, 0.4);
  drag(upper, 300, 310, 200, 360);
  assert.equal(seq.viewState().panelWidth, 300);
  near(seq.viewState().top, 0.5);
  near(seq.viewState().bottom, 0.85);

  // The controller divider also moves the upper boundary, keeping both grab offsets.
  seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
  assert.equal(seq.viewState().panelWidth, 280, 'legacy layouts keep the original panel width');
  const changesBefore = viewChanges;
  drag(controller, 292, 200, 292, 250);
  assert.equal(seq.viewState().panelWidth, 280, 'vertical motion does not change panel width');
  assert.deepEqual(positions(), [0.5, 0.75], 'controller divider moves the upper boundary vertically');
  drag(controller, 292, 200, 412, 200);
  assert.equal(seq.viewState().panelWidth, 400);
  assert.deepEqual(positions(), [0.5, 0.75]);
  assert.equal(viewChanges, changesBefore + 2);
  drag(controller, 412, 200, 0, 200);
  assert.equal(seq.viewState().panelWidth, 0);
  const collapsed = JSON.parse(JSON.stringify(seq.viewState()));
  drag(controller, 12, 200, 292, 200);
  assert.equal(seq.viewState().panelWidth, 280, 'the collapsed handle reopens the panel');
  seq.applyView(collapsed);
  assert.equal(seq.viewState().panelWidth, 0, 'collapse survives saving/restoring');
  seq.applyView({ panelWidth: 280 });
  const expanded = JSON.parse(JSON.stringify(seq.viewState()));
  drag(controller, 292, 200, 1000, 200);
  assert.equal(seq.viewState().panelWidth, 976, 'controller handle remains on screen');
  drag(upper, 988, 310, 988, 310);
  assert.deepEqual(positions(), [0.5, 0.75], 'grabbing a horizontal divider does not jump after controller resizing');
  seq.applyView({ top: 0, bottom: 1, panelWidth: 280 });
  drag(controller, 292, 200, 1000, 200);
  assert.equal(seq.viewState().panelWidth, 976, 'resizes with the sequencer hidden too');
  seq.applyView(expanded);
  assert.equal(seq.viewState().panelWidth, 280, 'expanded width survives saving/restoring');
  for (const panelWidth of [NaN, Infinity, 'invalid']) {
    seq.applyView({ panelWidth });
    assert.equal(seq.viewState().panelWidth, 280);
  }
  seq.applyView({ panelWidth: -10 });
  assert.equal(seq.viewState().panelWidth, 0);
  seq.applyView(expanded);
  drag(controller, 292, 200, 350, 200, {}, 'pointercancel');
  assert.equal(seq.viewState().panelWidth, 338);
  point(controller, 'pointermove', 600, 200);
  assert.equal(seq.viewState().panelWidth, 338, 'cancelled drag releases the handle');
  seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
  drag(controller, 292, 200, 392, 450);
  assert.equal(seq.viewState().panelWidth, 380);
  assert.deepEqual(positions(), [0.9, 0.9], 'controller divider can push both horizontal dividers');
  seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 2000 });
  drag(lower, 300, 510, 300, 560);
  assert.equal(seq.viewState().panelWidth, 2000, 'vertical motion preserves a saved width clamped by the viewport');
  drag(lower, 300, 560, 200, 560);
  assert.equal(seq.viewState().panelWidth, 876, 'horizontal drag starts from the rendered, clamped controller width');
}

console.log('sequencer interaction tests passed');
