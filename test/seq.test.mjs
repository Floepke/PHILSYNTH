import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setMaxListeners } from 'node:events';
import { emptySong, addClip, addAutoClip, isAuto, cloneClip, normalizeSong, setLaneMute, snapStep } from '../src/song.js';
import { createAutomationLane } from '../src/seq/automation.js';
import { createPianoRoll } from '../src/seq/pianoroll.js';
import { createArranger } from '../src/seq/arranger.js';
import { clipsOverlap } from '../src/seq/clipplacement.js';
import { createSequencer } from '../src/seq/index.js';
import { rightHold } from '../src/seq/surface.js';
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
    'fillText', 'strokeText', 'arcTo', 'closePath', 'ellipse', 'roundRect', 'quadraticCurveTo', 'translate', 'scale',
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
setMaxListeners(0, window); // Node never uncounts removed capture listeners
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
const ay = (y) => 50 + y + 17;
const assertNoOverlap = (song) => {
  for (let i = 0; i < song.clips.length; i++) {
    for (let j = i + 1; j < song.clips.length; j++) assert.equal(clipsOverlap(song.clips[i], song.clips[j]), false);
  }
};

// Free timing decouples piano-roll edits from the visual grid without changing other views.
{
  const { song, clip, roll, arranger } = setup();
  const cv = roll.surface.cv;
  const bands = () => cv.drawing.filter(c => c[0] === 'fillRect' && c.at(-1) === 'rgba(0, 0, 0, 0.10)');
  cv.drawing.length = 0;
  roll.redraw(); flush();
  const before = bands();
  assert.ok(before.length > 0, 'test observes the painted dark bands');
  song.snap.free = true;
  cv.drawing.length = 0;
  roll.redraw(); flush();
  assert.deepEqual(bands(), before, 'Free timing preserves the visual grid bands');
  drag(cv, nx(60), ny(1.37), nx(60), ny(1.49));
  assert.ok(Math.abs(clip.notes[0].start - 1.37) < 1e-6);
  assert.ok(Math.abs(clip.notes[0].length - 0.12) < 1e-6, 'free duration can be shorter than the grid step');
  point(cv, 'pointermove', nx(72), ny(3.17));
  assert.ok(Math.abs(roll.getPointerTime() - 3.17) < 1e-6);
  key(cv, 'c', { ctrlKey: true });
  key(cv, 'v', { ctrlKey: true });
  assert.ok(Math.abs(clip.notes[1].start - 3.17) < 1e-6, 'paste uses free time');
  key(cv, 'd', { ctrlKey: true });
  assert.ok(Math.abs(clip.notes[2].start - 3.29) < 1e-6, 'duplicate uses actual selection length');
  drag(cv, nx(60), ny(1.37) + 5, nx(62), ny(1.37) + 5 + 7);
  assert.equal(clip.notes[0].pitch, 62);
  assert.ok(Math.abs(clip.notes[0].start - (1.37 + 7 / 48)) < 1e-6, 'head movement is unsnapped');
  key(cv, 'q');
  assert.equal(clip.notes[0].start, 1.5, 'explicit Quantize still uses the grid');
  assert.equal(normalizeSong(song).snap.free, true, 'Free timing survives project normalization');
  assert.equal(normalizeSong({ snap: { free: 'true' } }).snap.free, undefined, 'old or invalid settings remain snapped');
  delete song.snap.free;
  drag(cv, nx(70), ny(5.37), nx(70), ny(5.69));
  assert.equal(clip.notes.at(-1).start, 5.25, 'switching back restores grid snapping');
  assert.equal(clip.notes.at(-1).length, 0.5);
  song.snap.free = true;
  point(arranger.surface.cv, 'dblclick', ax(7.37), ay(102));
  assert.equal(song.clips.at(-1).start, 7.25, 'timeline remains snapped in Free timing');
}

{
  const { song, clip, roll } = setup();
  const cv = roll.surface.cv;
  song.snap.free = true;
  clip.notes.push(note(60, 1, 2));
  drag(cv, nx(60), ny(2), nx(60), ny(2.73));
  assert.ok(Math.abs(clip.notes[0].length - 1.73) < 1e-6, 'body resize follows unsnapped pointer time');
  key(cv, 'a', { ctrlKey: true });
  const vx = v => 7 + v * 70;
  dbl(cv, vx(0.5), ny(2.17));
  assert.ok(Math.abs(clip.notes[0].vels[0].t - 1.17) < 1e-6, 'velocity point insertion is unsnapped');
  drag(cv, vx(0.5), ny(2.17), vx(0.6), ny(2.39));
  assert.ok(Math.abs(clip.notes[0].vels[0].t - 1.39) < 1e-6, 'velocity point movement is unsnapped');
}

// Playback uses the same floor-snapped time as note insertion, in absolute song quarters.
{
  const { song, clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.start = 8.25;
  assert.equal(roll.getPointerTime(), null);
  point(cv, 'pointermove', nx(60), ny(1.4));
  assert.equal(roll.getPointerTime(), 9.5);
  clip.notes.push(note(60, 1.25));
  roll.redraw();
  flush();
  assert.equal(roll.getPointerTime(), 9.5, 'hovering a note still gives the pointer time');
  song.snap.div = 2;
  assert.equal(roll.getPointerTime(), 9.625, 'snap changes apply without moving the pointer');
  roll.setView({ sy: 96, ppq: 96 });
  flush();
  assert.equal(roll.getPointerTime(), 9.875, 'uses the current scroll and zoom');
  point(cv, 'pointermove', nx(60), 390);
  assert.equal(roll.getPointerTime(), null, 'keyboard is not a time position');
  point(cv, 'pointermove', nx(60), ny(1));
  point(cv, 'pointerleave', nx(60), ny(1));
  assert.equal(roll.getPointerTime(), null, 'leaving the roll clears the start position');
  song.selected = null;
  point(cv, 'pointermove', nx(60), ny(1));
  assert.equal(roll.getPointerTime(), null, 'no selected note clip');
}

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
// The on-screen keyboard plays the live MIDI module (preview.key), not the clip's target.
{
  const { roll, ctx } = setup();
  const cv = roll.surface.cv;
  const calls = [];
  ctx.preview.on = () => { calls.push('clip target'); return {}; };
  ctx.preview.key = (pitch) => { calls.push(['key', pitch]); return pitch; };
  ctx.preview.off = (h) => { if (h !== null) calls.push(['off', h]); };
  point(cv, 'pointerdown', nx(60), 390, { buttons: 1 });
  point(cv, 'pointermove', nx(62), 390, { buttons: 1 });
  point(cv, 'pointerup', nx(62), 390);
  assert.deepEqual(calls, [['key', 60], ['off', 60], ['key', 62], ['off', 62]]);
}
// ...also with no clip selected (or an automation clip): the keys still play the live module.
{
  const { song, roll, ctx } = setup();
  const cv = roll.surface.cv;
  song.selected = null;
  roll.redraw(); flush();
  const calls = [];
  ctx.preview.key = (pitch) => { calls.push(['key', pitch]); return pitch; };
  ctx.preview.off = (h) => { if (h !== null) calls.push(['off', h]); };
  point(cv, 'pointerdown', nx(64), 390, { buttons: 1 });
  point(cv, 'pointerup', nx(64), 390);
  assert.deepEqual(calls, [['key', 64], ['off', 64]]);
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
  assert.equal(key(cv, 'Escape').defaultPrevented, true, 'Escape clears the note selection first');
  assert.equal(key(cv, 'Escape').defaultPrevented, false, 'next Escape reaches the global exit shortcut');
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

// A focused timeline releases Escape to the exit shortcut once its selection is empty.
{
  const { song, clip, arranger, roll } = setup();
  const cv = arranger.surface.cv;
  cv.focus();
  assert.equal(song.selected, clip.id);
  assert.equal(key(cv, 'Escape').defaultPrevented, true, 'first Escape clears the selected timeline clip');
  assert.equal(song.selected, null);
  assert.equal(document.activeElement, cv, 'timeline remains focused');
  for (let i = 0; i < 3; i++) {
    assert.equal(key(cv, 'Escape').defaultPrevented, false, 'an empty timeline selection never traps Escape');
  }
  assert.equal(key(roll.surface.cv, 'Escape').defaultPrevented, false, 'empty piano roll also lets Escape reach exit');
  song.selected = clip.id;
  assert.equal(key(cv, 'Escape').defaultPrevented, true, 'reselecting a clip restores selection dismissal');
  assert.equal(key(cv, 'Escape').defaultPrevented, false);
}

// Ordinary insertion, duration edits and head moves still work; short right click deletes.
{
  const { clip, roll, previews, menus } = setup();
  const cv = roll.surface.cv;
  drag(cv, nx(60), ny(1), nx(60), ny(2));
  assert.deepEqual(clip.notes, [note(60, 1)]);
  drag(cv, nx(60), ny(1.5), nx(60), ny(2.5));
  assert.equal(clip.notes[0].length, 1.5, 'the end jumps to the snapped pointer');
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
    mock.timers.tick(249);
    assert.equal(menus.length, 0);
    assert.equal(clip.notes.length, 2, 'no deletion on press');
    mock.timers.tick(1); flush();
    assert.equal(menus.length, 1, 'menu opens at 250 ms before release');
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
    mock.timers.tick(249);
    point(cv, 'pointerup', nx(60), y, { button: 2 });
    assert.deepEqual(clip.notes.map((n) => n.pitch), [64]);
    assert.equal(changes(), 1);
    mock.timers.tick(1000);
    assert.equal(menus.length, 0, 'release cancels the hold timer');
    key(cv, 'Delete');
    assert.equal(clip.notes.length, 0, 'other selected notes stay selected');
    click(cv, nx(70), ny(3), { button: 2 });
    mock.timers.tick(1000);
    assert.equal(menus.length, 0, 'quick right-click on empty space opens no menu');
    assert.equal(changes(), 2);
  } finally {
    mock.timers.reset();
  }
}

// A quick right-click on empty space deselects all notes (without deleting anything).
{
  const { clip, roll, menus, changes } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1), note(64, 2));
  key(cv, 'a', { ctrlKey: true });
  click(cv, nx(70), ny(4), { button: 2 });
  assert.equal(menus.length, 0);
  assert.equal(clip.notes.length, 2, 'no notes deleted');
  assert.equal(changes(), 0);
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 2, 'the selection is empty, so Delete removes nothing');
}

// Even if the timer is delayed by a busy event loop, a 250 ms release is not a delete.
{
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { clip, roll, menus } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1));
    point(cv, 'pointerdown', nx(60), ny(1) + 5, { button: 2, buttons: 2, timeStamp: 1000 });
    point(cv, 'pointerup', nx(60), ny(1) + 5, { button: 2, timeStamp: 1250 });
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
    mock.timers.tick(249);
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
    mock.timers.tick(249);
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
  drag(cv, nx(61), ny(3.5), nx(61), ny(4.5));
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

// Selecting a clip while stopped parks the playhead at its start; while playing it is left alone.
{
  const { song, clip, arranger, ctx, menus } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const other = addClip(song, { start: 8, length: 4, y: 34, target: 7 });
  ctx.transport.pos = 3;
  click(cv, ax(9), ay(34));
  assert.equal(song.selected, other.id);
  assert.equal(ctx.transport.pos, 8, 'click on a clip parks the playhead at its start');
  click(cv, ax(1), ay(0));
  assert.equal(ctx.transport.pos, 0);
  ctx.transport.pos = 5;
  click(cv, ax(1), ay(0));
  assert.equal(ctx.transport.pos, 0, 'also when the clip was already selected');
  click(cv, ax(9), ay(34), { ctrlKey: true });
  assert.equal(ctx.transport.pos, 8, 'Ctrl/Cmd + click adds the clip and parks there');
  drag(cv, ax(9), ay(34), ax(11), ay(34));
  assert.equal(other.start, 10);
  assert.equal(ctx.transport.pos, 10, 'moving a clip parks the playhead at its new start');
  assert.equal(clip.start, 2, 'the selection moved together');
  click(cv, ax(20), ay(200)); // empty: clears the selection, the playhead stays
  assert.equal(song.selected, null);
  assert.equal(ctx.transport.pos, 10);
  holdRightClick(cv, ax(3), ay(0));
  assert.equal(ctx.transport.pos, 2, 'the menu selects the clip too');
  assert.ok(menus.length);
  ctx.transport.pos = 3;
  ctx.transport.playing = true;
  click(cv, ax(11), ay(34));
  assert.equal(song.selected, other.id);
  assert.equal(ctx.transport.pos, 3, 'while playing the selection does not move the playhead');
  ctx.transport.playing = false;
}

// The ruler: a click sets the play position, a drag selects the loop region, right-click removes it.
{
  const { song, arranger, ctx, changes } = setup();
  const cv = arranger.surface.cv;
  const RY = 27; // bar number row
  click(cv, ax(5.37), RY);
  assert.equal(ctx.transport.pos, 5.25);
  assert.equal(song.loop, null, 'a click is no region');
  const c0 = changes();
  drag(cv, ax(4.1), RY, ax(8.05), RY);
  assert.deepEqual(song.loop, { start: 4, end: 8 });
  assert.equal(ctx.transport.pos, 4, 'stopped: the playhead goes to the region start');
  assert.equal(changes(), c0 + 1, 'one undo step');
  drag(cv, ax(12), RY, ax(10), RY); // right to left
  assert.deepEqual(song.loop, { start: 10, end: 12 });
  drag(cv, ax(12), RY, ax(12.05), RY); // zero width after snapping: keeps the region
  assert.deepEqual(song.loop, { start: 10, end: 12 });
  drag(cv, ax(2), RY, ax(6), RY, {}, 'pointercancel');
  assert.deepEqual(song.loop, { start: 10, end: 12 }, 'cancel restores the region');
  point(cv, 'pointerdown', ax(5), RY, { button: 2, buttons: 2 });
  point(cv, 'pointerup', ax(5), RY, { button: 2 });
  assert.ok(song.loop, 'right-click beside the region keeps it');
  const c1 = changes();
  point(cv, 'pointerdown', ax(11), RY, { button: 2, buttons: 2 });
  point(cv, 'pointerup', ax(11), RY, { button: 2 });
  assert.equal(song.loop, null, 'right-click on the region removes it');
  assert.equal(changes(), c1 + 1);
}

// The overview map scrolls the TimeLine horizontally by click or drag.
{
  const { arranger } = setup();
  const cv = arranger.surface.cv;
  const mapY = 44;
  click(cv, 450, mapY);
  assert.ok(arranger.getView().sx > 0, 'clicking the map navigates toward later time');
  drag(cv, 300, mapY, 100, mapY);
  assert.ok(arranger.getView().sx < 0, 'dragging the map viewport navigates toward earlier time');
}

// The mouse wheel scrolls the TimeLine sideways over time; Shift + wheel scrolls the lanes.
{
  const { song, arranger } = setup();
  const cv = arranger.surface.cv;
  addClip(song, { start: 0, length: 4, y: 400 });
  arranger.setView({ sx: 0, sy: 0 }); flush();
  fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaX: 0, deltaY: 40, deltaMode: 0 }); flush();
  assert.equal(arranger.getView().sx, 40, 'a plain wheel scrolls toward later time');
  assert.equal(arranger.getView().sy, 0, 'a plain wheel leaves the lanes alone');
  fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaX: 0, deltaY: -20, deltaMode: 0 }); flush();
  assert.equal(arranger.getView().sx, 20, 'wheeling back scrolls toward earlier time');
  fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true }); flush();
  assert.equal(arranger.getView().sx, 20);
  assert.equal(arranger.getView().sy, 30, 'Shift + wheel scrolls the lanes');
  drag(cv, 200, 100, 180, 100, { button: 1 }); flush();
  assert.equal(arranger.getView().sx, 40, 'middle-drag still pans');
}

// The mouse wheel scrolls the piano roll by exactly one snap step per wheel event.
{
  const { song, roll } = setup();
  const cv = roll.surface.cv;
  const wheel = (deltaY, deltaMode = 0) => { fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaX: 0, deltaY, deltaMode }); flush(); };
  const st = snapStep(song.snap);
  wheel(3);
  assert.equal(roll.getView().sy, st * 48, 'a tiny wheel delta still moves one snap step');
  wheel(400);
  assert.equal(roll.getView().sy, 2 * st * 48, 'a large delta moves one snap step too');
  wheel(-1, 1);
  assert.equal(roll.getView().sy, st * 48, 'wheeling up moves one step back');
  song.snap = { base: 4, div: 3 };
  wheel(10);
  assert.equal(roll.getView().sy, st * 48 + snapStep(song.snap) * 48, 'follows the selected snap');
}

// Lane mute buttons (M) left of the lane numbers: a click toggles one lane, dragging over more
// buttons gives them the same state in one gesture; muted lanes are saved with the song.
{
  const { song, arranger, changes } = setup();
  const cv = arranger.surface.cv;
  arranger.setView({ sx: 0, sy: 0 }); flush();
  const my = (lane) => ay(lane * 34);
  click(cv, 15, my(1));
  assert.deepEqual(song.mutes, [1]);
  assert.equal(changes(), 1);
  click(cv, 15, my(1));
  assert.deepEqual(song.mutes, [], 'a second click unmutes');
  point(cv, 'pointerdown', 15, my(0), { buttons: 1 });
  point(cv, 'pointermove', 15, my(4), { buttons: 1 }); // a fast move fills the lanes in between
  point(cv, 'pointerup', 15, my(4));
  assert.deepEqual(song.mutes, [0, 1, 2, 3, 4]);
  assert.equal(changes(), 3, 'one change per gesture');
  point(cv, 'pointerdown', 15, my(2), { buttons: 1 }); // starting on a muted lane unmutes
  point(cv, 'pointermove', 15, my(3), { buttons: 1 });
  point(cv, 'pointermove', 15, my(6), { buttons: 1 });
  point(cv, 'pointerup', 15, my(6));
  assert.deepEqual(song.mutes, [0, 1]);
  cv.drawing.length = 0;
  arranger.redraw(); flush();
  assert.ok(cv.drawing.some((op) => op[0] === 'fillText' && op[1] === 'M'), 'the buttons show an M');
  assert.ok(cv.drawing.some((op) => op[0] === 'fill' && op[1] === '#d9a521'), 'a muted lane has a lit button');
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(song))).mutes, [0, 1]);
  assert.deepEqual(normalizeSong({ mutes: [3, -1, 1.5, 'x', 3, 0] }).mutes, [0, 3]);
}

// S buttons next to the M buttons solo lanes (toggle, drag over the column for many); silenced
// clips are dimmed and their editor shows the big M.
{
  const { song, clip, roll, arranger, changes } = setup();
  const cv = arranger.surface.cv;
  arranger.setView({ sx: 0, sy: 0 }); flush();
  const sy = (lane) => ay(lane * 34);
  click(cv, 33, sy(2));
  assert.deepEqual(song.solos, [2]);
  assert.deepEqual(song.mutes, [], 'the S column does not touch mutes');
  click(cv, 33, sy(2));
  assert.deepEqual(song.solos, []);
  point(cv, 'pointerdown', 33, sy(1), { buttons: 1 });
  point(cv, 'pointermove', 33, sy(3), { buttons: 1 });
  point(cv, 'pointerup', 33, sy(3));
  assert.deepEqual(song.solos, [1, 2, 3]);
  assert.equal(changes(), 3);
  cv.drawing.length = 0;
  arranger.redraw(); flush();
  assert.ok(cv.drawing.some((op) => op[0] === 'fillText' && op[1] === 'S'), 'the buttons show an S');
  assert.ok(cv.drawing.some((op) => op[0] === 'fill' && op[1] === '#3fa7e0'), 'a soloed lane has a lit button');
  const rc = roll.surface.cv;
  rc.drawing.length = 0;
  roll.redraw(); flush();
  assert.equal(clip.y, 0);
  assert.ok(rc.drawing.some((op) => op[0] === 'fill' && op[1] === '#000'), 'a clip outside the solo shows the big M');
  click(cv, 33, sy(0));
  rc.drawing.length = 0;
  roll.redraw(); flush();
  assert.ok(!rc.drawing.some((op) => op[0] === 'fill' && op[1] === '#000'), 'soloed: no M');
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(song))).solos, [0, 1, 2, 3]);
}

// A clip on a muted lane shows a big M across the piano roll / automation editor, centred in the
// visible grid; muting from the TimeLine updates the roll while the gesture is still going.
{
  const { song, clip, roll, rollHost, arranger, ctx } = setup();
  let live = 0;
  ctx.live = () => { live++; roll.redraw(); };
  const rc = roll.surface.cv;
  // the big M: a black filled outline; returns [centre x, centre y] of each one drawn
  const marks = (cv) => {
    const out = [];
    let pts = [];
    for (const op of cv.drawing) {
      if (op[0] === 'beginPath') pts = [];
      else if (op[0] === 'moveTo' || op[0] === 'lineTo') pts.push(op.slice(1, 3));
      else if (op[0] === 'fill' && op[1] === '#000' && pts.length === 12) {
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        out.push([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
      }
    }
    return out;
  };
  const bigM = () => marks(rc);
  rc.drawing.length = 0;
  roll.redraw(); flush();
  assert.equal(bigM().length, 0, 'unmuted: no M');
  const cv = arranger.surface.cv;
  arranger.setView({ sx: 0, sy: 0 }); flush();
  rc.drawing.length = 0;
  point(cv, 'pointerdown', 15, ay(clip.y), { buttons: 1 });
  assert.ok(live > 0 && bigM().length === 1, 'the roll shows the M during the mute gesture');
  point(cv, 'pointerup', 15, ay(clip.y));
  rc.drawing.length = 0;
  roll.redraw(); flush();
  const [x, y] = bigM()[0];
  const LEFT = 84 + 36; // velocity strip + ruler
  assert.ok(Math.abs(x - (LEFT + (rollHost.clientWidth - LEFT) / 2)) < 1, 'centred horizontally');
  assert.ok(Math.abs(y - (400 - 24) / 2) < 1, 'centred vertically');
  roll.setView({ sy: 2000 }); rc.drawing.length = 0; roll.redraw(); flush();
  assert.deepEqual(bigM()[0], [x, y], 'stays centred while scrolling');
  song.mutes = [];
  rc.drawing.length = 0;
  roll.redraw(); flush();
  assert.equal(bigM().length, 0);
  const a = addAutoClip(song, { length: 8, target: 1, controller: 0, y: 68 });
  const lane = createAutomationLane(host(), {
    song: () => song, clip: () => a, color: () => '#e76f51', transport: { playing: false, pos: 0 },
    changed() {}, autoParam: () => ({ p: {}, format: (v) => `${Math.round(v * 100)}` }),
  });
  flush();
  const lc = lane.surface.cv;
  setLaneMute(song, 2, true);
  lc.drawing.length = 0;
  lane.redraw(); flush();
  assert.equal(marks(lc).length, 1, 'the automation editor shows it too');
}

// The border of the selected clip pulses at 50 BPM: 600 ms white, 600 ms a darker grey.
{
  const { arranger } = setup();
  const cv = arranger.surface.cv;
  const realNow = performance.now;
  try {
    const white = (ms) => {
      performance.now = () => ms;
      cv.drawing.length = 0;
      arranger.redraw(); flush();
      const strokes = cv.drawing.filter((op) => op[0] === 'stroke').map((op) => op[1]);
      assert.ok(strokes.includes('#f2f2f4') !== strokes.includes('#a9a9b0'), 'white or grey, always a border');
      return strokes.includes('#f2f2f4');
    };
    assert.equal(white(600000), true, 'on in the first half of a beat');
    assert.equal(white(600599), true);
    assert.equal(white(600600), false, 'grey in the second half');
    assert.equal(white(601199), false);
    assert.equal(white(601200), true, 'white again on the next beat');
  } finally {
    performance.now = realNow;
  }
}

// Dragging a clip close to an edge of the time area auto-scrolls the TimeLine, carrying the clip.
{
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const { song, clip, arranger, changes } = setup();
    const cv = arranger.surface.cv;
    clip.length = 4;
    addClip(song, { start: 0, length: 4, y: 400 });
    arranger.setView({ sx: 0, sy: 0 }); flush();
    point(cv, 'pointerdown', ax(1), ay(0), { buttons: 1 });
    point(cv, 'pointermove', 478, ay(0), { buttons: 1 });
    const before = clip.start;
    mock.timers.tick(1000); flush();
    const { sx } = arranger.getView();
    assert.ok(sx > 100, `the view scrolled right (${sx})`);
    assert.ok(clip.start > before + 4, `the clip travelled with the view (${clip.start})`);
    point(cv, 'pointermove', 300, ay(0), { buttons: 1 }); // back inside: scrolling stops
    mock.timers.tick(1000); flush();
    assert.equal(arranger.getView().sx, sx);
    point(cv, 'pointermove', 478, ay(0), { buttons: 1 });
    point(cv, 'pointerup', 478, ay(0));
    const after = arranger.getView().sx;
    mock.timers.tick(1000); flush();
    assert.equal(arranger.getView().sx, after, 'releasing stops the auto-scroll');
    assert.ok(changes() > 0);
    const cx = 70 + (clip.start + 1) * 16 - after; // grab the clip where it now is
    assert.ok(cx > 70 && cx < 480);
    point(cv, 'pointerdown', cx, ay(0), { buttons: 1 }); // and leftwards
    point(cv, 'pointermove', 72, ay(0), { buttons: 1 });
    mock.timers.tick(300); flush();
    assert.ok(arranger.getView().sx < after, 'the view scrolls back left');
    point(cv, 'pointerup', 72, ay(0));
  } finally {
    mock.timers.reset();
  }
}

// Context menu: Consolidate the selected clips of one lane, Split at the playhead; the signature
// row sets / scrubs the play position.
{
  const { song, clip, arranger, ctx, menus, changes } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.notes.push(note(60, 1));
  const b = addClip(song, { start: 6, length: 2, target: 9 });
  b.notes.push(note(64, 0.5));
  const lower = addClip(song, { start: 0, length: 2, y: 34, target: 7 });
  holdRightClick(cv, ax(1), ay(0));
  assert.ok(menus.at(-1).items.find((i) => i.label === 'Consolidate').disabled, 'one clip: nothing to consolidate');
  click(cv, ax(7), ay(0), { ctrlKey: true });
  click(cv, ax(1), ay(34), { ctrlKey: true });
  holdRightClick(cv, ax(7), ay(0));
  assert.ok(menus.at(-1).items.find((i) => i.label === 'Consolidate').disabled, 'clips on different lanes');
  click(cv, ax(1), ay(34), { ctrlKey: true }); // drop the lower clip again
  holdRightClick(cv, ax(7), ay(0));
  const c0 = changes();
  pick(menus, 'Consolidate');
  assert.equal(changes(), c0 + 1);
  assert.equal(song.clips.length, 2);
  const merged = ctx.clip();
  assert.deepEqual([merged.start, merged.length, merged.target], [0, 8, 7]);
  assert.deepEqual(merged.notes.map((n) => [n.pitch, n.start]), [[60, 1], [64, 6.5]]);
  assert.equal(ctx.transport.pos, 0, 'stopped: playhead at the new clip');
  assert.ok(song.clips.includes(lower));

  // split at the playhead (set in the signature row)
  click(cv, ax(3.1), 8);
  assert.equal(ctx.transport.pos, 3, 'a click in the signature row sets the play position');
  drag(cv, ax(3.1), 8, ax(5.1), 8);
  assert.equal(ctx.transport.pos, 5, 'dragging there scrubs');
  assert.equal(song.loop, null, 'and makes no loop region');
  holdRightClick(cv, ax(1), ay(0));
  pick(menus, 'Split at playhead');
  assert.equal(song.clips.length, 3);
  const right = ctx.clip();
  assert.deepEqual([merged.length, right.start, right.length, right.y], [5, 5, 3, 0]);
  assert.deepEqual(right.notes.map((n) => [n.pitch, n.start]), [[64, 1.5]]);
  assert.equal(ctx.transport.pos, 5, 'the playhead stays at the cut');
  holdRightClick(cv, ax(1), ay(34));
  assert.ok(menus.at(-1).items.find((i) => i.label === 'Split at playhead').disabled, 'playhead outside the clip');
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
  holdRightClick(cv, ax(clone.start + 1), ay(0));
  assert.ok(labels(menus).includes('Detach clone'), labels(menus).join());
  pick(menus, 'Detach clone');
  assert.notEqual(clone.notes, clip.notes);
  assert.deepEqual(clone.notes, clip.notes);
  assert.equal(clone.link, undefined);
  assert.equal(clip.link, undefined, 'a group of one is no link');
  // menu Clone on the original creates a new linked clone
  holdRightClick(cv, ax(1), ay(0));
  pick(menus, 'Clone (linked)');
  assert.equal(song.clips.length, 3);
  const again = song.clips.at(-1);
  assert.equal(again.notes, clip.notes);
  const duplicateItem = menus.at(-1).items.find((i) => i.label === 'Duplicate');
  const cloneItem = menus.at(-1).items.find((i) => i.label === 'Clone (linked)');
  assert.equal(duplicateItem.shortcut, undefined, 'Duplicate has no keyboard shortcut in the menu');
  assert.ok(cloneItem.shortcut, 'the linked clone menu item shows Ctrl/Cmd+D');
  assertNoOverlap(song);
  // empty-space menu: Paste disabled until something was copied
  holdRightClick(cv, ax(40), ay(80));
  assert.equal(menus.at(-1).items.find((i) => i.label === 'Paste').disabled, true);
}

// Ctrl/Cmd+D makes a linked clone; Ctrl/Cmd+Shift+D makes an independent duplicate.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.notes.push(note(60, 1));
  click(cv, ax(1), ay(0));
  key(cv, 'd', { ctrlKey: true });
  assert.equal(song.clips.length, 2);
  assert.equal(song.clips.at(-1).notes, clip.notes);
  key(cv, 'd', { ctrlKey: true, shiftKey: true });
  assert.equal(song.clips.length, 3);
  assert.notEqual(song.clips.at(-1).notes, clip.notes);
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
  point(cv, 'dblclick', ax(8), 50 + 34 * 2 + 3);
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
  holdRightClick(cv, ax(clone.start + 1), ay(68));
  pick(menus, 'Go to source');
  assert.equal(song.selected, clip.id);
  holdRightClick(cv, ax(1), ay(68));
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
  holdRightClick(cv, vx(1), ny(3));
  assert.ok(b.vels, 'releasing after the menu opened does not delete');
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
  holdRightClick(cv, 35, ny(5));
  assert.deepEqual(labels(menus), ['Snap velocity values'], 'blank lane offers the toggle');
  assert.equal(menus.at(-1).items[0].checked, true);
  pick(menus, 'Snap velocity values');
  assert.equal(roll.getView().snapVelocity, false);
  assert.deepEqual(clip.notes, before, 'toggling does not quantize existing values');
  assert.equal(changes(), 1, 'toggle schedules persistence');
  drag(cv, vx(0.53), ny(1), vx(0.9), ny(1));
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'disabled toggle restores free editing');
  holdRightClick(cv, 35, ny(5));
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
  holdRightClick(cv, 35, ny(5));
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
  holdRightClick(cv, vx(0.5), ny(1));
  const firstMenu = menus.at(-1).items;
  assert.equal(firstMenu.find((i) => i.label === 'Delete point').disabled, true, 'cannot delete the start point');
  holdRightClick(cv, vx(0.3125), ny(2.5));
  assert.ok(clip.notes[0].vels, 'opening menu does not delete');
  pick(menus, 'Delete point');
  assert.ok(clip.notes.every((n) => !n.vels), 'deletion still works for shared curves');
}

// Double right-click on empty TimeLine space inserts an automation clip.
{
  const { song, arranger, ctx } = setup();
  ctx.defaultAutoTarget = () => 3;
  const cv = arranger.surface.cv;
  click(cv, ax(20), ay(100), { button: 2 });
  assert.equal(song.clips.length, 1, 'a single right-click inserts nothing');
  click(cv, ax(20), ay(100), { button: 2 });
  assert.equal(song.clips.length, 2);
  const a = ctx.clip();
  assert.ok(isAuto(a));
  assert.equal(a.target, 3);
  assert.equal(a.controller, 0);
  assert.equal(a.start, 20);
  // far apart presses are no double click; right-clicking a clip does not insert
  click(cv, ax(40), ay(100), { button: 2 });
  click(cv, ax(60), ay(100), { button: 2 });
  click(cv, ax(1), ay(0), { button: 2 });
  click(cv, ax(1), ay(0), { button: 2 });
  assert.equal(song.clips.length, 2);
}

// Duration drags put the note end at the snapped pointer: a long note becomes short with a small drag.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 32), note(64, 1, 8));
  drag(cv, nx(60), ny(2.6), nx(60), ny(2.6) + 5);
  assert.equal(clip.notes[0].length, 1.75, 'end snaps to the 16th grid under the pointer');
  drag(cv, nx(60), ny(1.5), nx(60), ny(0.2));
  assert.equal(clip.notes[0].length, 0.25, 'never shorter than one snap step');
  key(cv, 'a', { ctrlKey: true });
  drag(cv, nx(64), ny(5), nx(64), ny(4));
  assert.deepEqual(clip.notes.map((n) => n.length), [0.25, 3], 'selection keeps the anchor\'s delta (minimum one step)');
}

// Right-button hold threshold: under 5 px still opens the menu, 5 px cancels.
{
  const cv = new Canvas();
  let holds = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const [dx, want] of [[3, 1], [4.9, 1], [5, 0]]) {
      holds = 0;
      rightHold(cv, point(cv, 'pointerdown', 10, 10, { button: 2 }), { onHold: () => holds++ });
      point(cv, 'pointermove', 10 + dx, 10, { button: 2 });
      mock.timers.tick(500);
      point(cv, 'pointerup', 10 + dx, 10, { button: 2 });
      assert.equal(holds, want, `move ${dx} px`);
    }
  } finally {
    mock.timers.reset();
  }
  const { clip, roll, menus } = setup();
  const rc = roll.surface.cv;
  clip.notes.push(note(60, 1));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    point(rc, 'pointerdown', nx(60), ny(1) + 5, { button: 2, buttons: 2 });
    point(rc, 'pointermove', nx(60) + 4, ny(1) + 5, { button: 2, buttons: 2 });
    mock.timers.tick(500);
    point(rc, 'pointerup', nx(60) + 4, ny(1) + 5, { button: 2 });
    assert.equal(menus.length, 1, 'piano roll: 4 px still holds');
    point(rc, 'pointerdown', nx(60), ny(1) + 5, { button: 2, buttons: 2 });
    point(rc, 'pointermove', nx(60) + 5, ny(1) + 5, { button: 2, buttons: 2 });
    mock.timers.tick(500);
    point(rc, 'pointerup', nx(60) + 5, ny(1) + 5, { button: 2 });
    assert.equal(menus.length, 1, 'piano roll: 5 px becomes a selection drag');
    assert.equal(clip.notes.length, 1);
  } finally {
    mock.timers.reset();
  }
}

// A normal right-click opens the TimeLine menu at once (no 250 ms hold).
{
  const { song, arranger, menus, clip } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    point(cv, 'pointerdown', ax(1), ay(0), { button: 2, buttons: 2 });
    assert.equal(menus.length, 1, 'the press opens the menu');
    assert.ok(labels(menus).includes('Cut'));
    mock.timers.tick(500);
    point(cv, 'pointerup', ax(1), ay(0), { button: 2 });
    assert.equal(menus.length, 1, 'holding / releasing adds nothing');
    click(cv, ax(40), ay(100), { button: 2 });
    assert.equal(menus.length, 2, 'empty space: menu too');
    assert.ok(labels(menus).includes('Insert automation clip'));
    assert.equal(song.clips.length, 1);
    // a time signature change: a short right-click removes it, a hold does not
    song.sigs = [{ at: 0, num: 4, den: 4 }, { at: 16, num: 3, den: 4 }];
    arranger.redraw(); flush();
    point(cv, 'pointerdown', ax(16) + 6, 8, { button: 2, buttons: 2 });
    mock.timers.tick(500);
    point(cv, 'pointerup', ax(16) + 6, 8, { button: 2 });
    assert.equal(song.sigs.length, 2, 'holding keeps the signature');
    click(cv, ax(16) + 6, 8, { button: 2 });
    assert.equal(song.sigs.length, 1, 'short right-click removes the signature');
  } finally {
    mock.timers.reset();
  }
}

// rightHold: overdue release, Escape, wheel and blur cancel; the velocity lane opens its menu on a normal right-click.
{
  const cv = new Canvas();
  const log = [];
  const opts = { onShort: () => log.push('short'), onHold: () => log.push('hold'), onEnd: () => log.push('end') };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    rightHold(cv, point(cv, 'pointerdown', 0, 0, { button: 2, timeStamp: 1000 }), opts);
    point(cv, 'pointerup', 0, 0, { button: 2, timeStamp: 1500 });
    assert.deepEqual(log.splice(0), ['hold', 'end'], 'a late timer still opens the menu');
    for (const cancel of ['Escape', 'wheel', 'blur']) {
      rightHold(cv, point(cv, 'pointerdown', 0, 0, { button: 2 }), opts);
      if (cancel === 'Escape') key(window, 'Escape');
      else if (cancel === 'wheel') point(cv, 'wheel', 0, 0, { deltaY: 10 });
      else fire(window, 'blur');
      mock.timers.tick(600);
      point(cv, 'pointerup', 0, 0, { button: 2 });
      assert.deepEqual(log.splice(0), ['end'], `${cancel} cancels`);
    }
  } finally {
    mock.timers.reset();
  }
  const { clip, roll, menus } = setup();
  const rc = roll.surface.cv;
  clip.notes.push(note(60, 1, 3, 0.5));
  click(rc, 7 + 0.5 * 70, ny(1));
  dbl(rc, 7 + 0.9 * 70, ny(2));
  assert.equal(clip.notes[0].vels.length, 1);
  click(rc, 7 + 0.9 * 70, ny(2), { button: 2 });
  assert.equal(menus.length, 1, 'a normal right-click opens the velocity menu');
  assert.equal(clip.notes[0].vels.length, 1, 'and deletes nothing by itself');
  menus[0].items.find((it) => it.label === 'Delete point').action();
  assert.equal('vels' in clip.notes[0], false, 'Delete point removes it');
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
  // noteheads: tilted ovals stretched 1.25× along time, with a thick (unstretched) outline
  const ei = cv.drawing.findIndex(([op, x, y, rx, ry, tilt]) => op === 'ellipse' && x === 0 && y === 0 && rx > ry && tilt < 0);
  assert.ok(ei > 1);
  assert.deepEqual(cv.drawing[ei - 1], ['scale', 1, 1.25]);
  assert.equal(cv.drawing[ei - 2][0], 'translate');
  assert.equal(cv.drawing[ei - 2][1], nx(60));
  assert.ok(cv.drawing.some(([op, color, width]) => op === 'stroke' && color === '#111216' && width === 3), 'outline twice as thick');
  assert.ok(cv.drawing.some(([op, color]) => op === 'fill' && color === '#65b4ff'));
  assert.ok(cv.drawing.some(([op, color, width]) => op === 'stroke' && color === '#111216' && width === 4));
  assert.ok(cv.drawing.some(([op, color, width]) => op === 'stroke' && color === '#111216' && width === 8));
  assert.ok(cv.drawing.some(([op, ...dash]) => op === 'setLineDash' && JSON.stringify(dash[0]) === '[12,12]'));
  {
    let startLine = false;
    for (let i = 0; i < cv.drawing.length; i++) {
      const [op, color, width] = cv.drawing[i];
      if (op !== 'stroke' || color !== '#111216') continue;
      const to = cv.drawing[i - 1];
      const from = cv.drawing[i - 2];
      if (from?.[0] !== 'moveTo' || to?.[0] !== 'lineTo' || from[1] < nx(22) || from[2] !== 0.5 || to[2] !== 0.5) continue;
      assert.equal(width, 4, 'first barline matches normal barline thickness');
      startLine = true;
    }
    assert.ok(startLine, 'first barline is drawn');
  }
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
  const bands = cv.drawing.filter(([op, , , , , color]) => op === 'fillRect' && color === 'rgba(0, 0, 0, 0.10)');
  assert.ok(bands.length > 0);
  assert.ok(bands.every((b) => b[1] === left && b[3] === right - left));
  const lines = cv.drawing.flatMap(([op, color], i) => {
    const from = cv.drawing[i - 2];
    const to = cv.drawing[i - 1];
    if (op !== 'stroke' || color !== '#111216'
      || from?.[0] !== 'moveTo' || to?.[0] !== 'lineTo' || from[2] !== to[2] || to[1] === 120) return [];
    return [[from, to]];
  });
  assert.ok(lines.length > 0);
  assert.ok(lines.every(([from, to]) => from[2] === to[2] && from[1] >= left && to[1] <= right));
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
  const head = cv.drawing.find(([op, x]) => op === 'translate' && Math.abs(x - center(1)) < 1e-9); // notehead centre
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

// The bar ruler is a divider: dragging it widens the velocity strip and the note grid scales.
{
  const { clip, roll, ctx, changes } = setup();
  const cv = roll.surface.cv;
  let viewChanges = 0;
  ctx.viewChanged = () => viewChanges++;
  clip.notes.push(note(0, 1), note(127, 1));
  const before = structuredClone(clip.notes);
  const centers = () => {
    cv.drawing.length = 0;
    roll.redraw(); flush();
    return cv.drawing.filter(([op]) => op === 'translate').map((op) => op[1]);
  };
  assert.equal(roll.getView().velW, 84, 'default width');
  drag(cv, 100, 50, 200, 50);
  assert.equal(roll.getView().velW, 184, 'dragged 100 px wider');
  const kw = (ROLL_WIDTH - 220) / 128;
  assert.deepEqual(centers(), [220 + kw / 2, 220 + 127.5 * kw], 'the grid scales into the rest');
  assert.equal(viewChanges, 1, 'saved as a view change');
  assert.equal(changes(), 0, 'no undo step');
  assert.deepEqual(clip.notes, before, 'notes untouched');
  drag(cv, 200, 50, 99999, 50);
  assert.equal(roll.getView().velW, ROLL_WIDTH * 0.6, 'at most 60 % of the roll');
  drag(cv, ROLL_WIDTH * 0.6 + 10, 50, -500, 50);
  assert.equal(roll.getView().velW, 48, 'at least 48 px');
  point(cv, 'pointerdown', 60, 50, { buttons: 1, detail: 2 });
  point(cv, 'pointerup', 60, 50);
  assert.equal(roll.getView().velW, 84, 'double-click resets');
  roll.setView({ ...roll.getView(), velW: 150 });
  assert.equal(roll.getView().velW, 150, 'restored from the project view');
  roll.setView(undefined);
  assert.equal(roll.getView().velW, 84, 'new project: default');
  roll.setView({ sy: 0, ppq: 48 });
  assert.equal(roll.getView().velW, 84, 'older projects: default');
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
    const centers = cv.drawing.filter(([op]) => op === 'translate').map((op) => op[1]);
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
    assert.deepEqual(cv.drawing.filter(([op]) => op === 'translate').map((op) => op[1]), centers);
    assert.deepEqual(clip.notes, before, 'resizing and scrolling do not alter the notes');
    assert.deepEqual(Object.keys(roll.getView()).sort(), ['ppq', 'snapVelocity', 'sy', 'velW'], 'horizontal geometry is not persisted (only the velocity strip width)');
  }
}

// Barlines leave half a semitone on either side of crossed notes, including tolerant endpoints.
for (const notes of [
  [note(60, 3, 2)],
  [note(60, 4 + 5e-8, 1)],
  [note(60, 3, 1 - 5e-8)],
  [note(60, 3, 2), note(61, 4, 1)],
  [note(0, 3, 2), note(127, 3, 2)],
  [note(60, 4 + 2e-7, 1)],
]) {
  const { roll, clip } = setup();
  clip.notes.push(...notes);
  const cv = roll.surface.cv;
  cv.drawing.length = 0;
  roll.redraw(); flush();
  const y = 4 * 48 + 0.5;
  const paths = [];
  let path = [];
  for (const op of cv.drawing) {
    if (op[0] === 'beginPath') path = [];
    else if (op[0] === 'moveTo' || op[0] === 'lineTo') path.push(op);
    else if (op[0] === 'stroke' && op[1] === '#111216' && op[2] === 4
      && path.length && path.every(p => p[2] === y)) paths.push(path);
  }
  assert.equal(paths.length, 1, 'no underlying beat line fills the barline gaps');
  const bar = paths[0];
  const segments = [];
  for (let i = 0; i < bar.length; i += 2) segments.push([bar[i][1], bar[i + 1][1]]);
  const gaps = notes.filter(n => n.start <= 4 + 1e-7 && n.start + n.length >= 4 - 1e-7)
    .map(n => [nx(n.pitch) - 7.5 - 7, nx(n.pitch) + 7.5 + 7]);
  for (const [left, right] of gaps) {
    assert.ok(segments.every(([a, b]) => b <= left || a >= right), 'no barline segment enters note gap');
  }
  if (notes[0].pitch === 60 && gaps.length) {
    assert.equal(segments[0][1], gaps[0][0], 'gap starts exactly half a semitone before the note edge');
    assert.equal(segments.at(-1)[0], Math.max(...gaps.map(g => g[1])), 'merged gap ends half a semitone after the last note edge');
  } else {
    assert.equal(segments.length, 1, 'non-crossing or out-of-grid notes do not cut the barline');
  }
}

// Top overscroll is a bounded, blank margin shared by notes, stave, ruler and velocity lane.
{
  const { song, clip, roll, initialView } = setup();
  const cv = roll.surface.cv;
  assert.equal(initialView.sy, -128, 'new rolls start with four times the original 32px margin above beat zero');
  for (let i = 0; i < 20; i++) fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaY: -10000, deltaX: 0, deltaMode: 0 });
  assert.equal(roll.getView().sy, -128, 'upward scrolling stops at the margin');
  click(cv, nx(60), 16);
  assert.equal(clip.notes.length, 0, 'blank margin is not note-entry space');
  cv.drawing.length = 0;
  point(cv, 'pointermove', nx(60), 16);
  assert.equal(cv.drawing.some(([op]) => op === 'ellipse'), false, 'no note preview in the margin');
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'moveTo' && x === nx(61) && y === 128), 'stave starts at beat zero, not at the canvas edge');
  assert.equal(cv.drawing.some(([op, x, y]) => op === 'moveTo' && x === nx(61) && y === 0), false);
  clip.notes.push(note(60, 0, 1, 0.5));
  cv.drawing.length = 0;
  roll.redraw(); flush();
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'arc' && x === 42 && y === 128), 'velocity handle aligns with beat zero');
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'roundRect' && x === nx(60) - 7.5 && y === 128), 'note starts below the margin');
  drag(cv, nx(59), 8, nx(61), 156, { shiftKey: true });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 0, 'selection can start in the margin to catch the first note');
  fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaY: 16, deltaX: 0, deltaMode: 0 });
  assert.equal(roll.getView().sy, -128 + snapStep(song.snap) * 48, 'margin scrolls away one snap step');
  roll.reveal(); flush();
  assert.equal(roll.getView().sy, -128, 'revealing a clip restores the margin');
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
    children = [];
    append(child) { this.children.push(child); }
    add() {}
    setAttribute(name, value) { this.attributes.set(name, value); }
    replaceChildren() {}
    contains(el) { return el === this; }
    blur() { document.activeElement = null; }
    closest(selector) { return this.kind !== 'div' && selector.includes(this.kind) ? this : null; }
  }
  const elements = new Map();
  const inputIds = ['seq-name', 'seq-snap-div', 'seq-free-time'];
  for (const id of ['seq', 'seq-bar', 'seq-bar-content', 'seq-play', 'seq-pos', 'seq-target', 'seq-snap-base', 'seq-ctl', 'seq-ctl-field', 'seq-target-field', ...inputIds,
    'workspace', 'patcher', 'roll', 'arranger', 'seq-split', 'seq-hsplit', 'panel', 'panel-split', 'status']) {
    elements.set(id, new Element(inputIds.includes(id) ? 'input' : id === 'seq-play' ? 'button' : 'div'));
  }
  document.getElementById = (id) => elements.get(id);
  document.body = new Element();
  globalThis.Option = class { constructor(label, value) { this.label = label; this.value = value; } };
  globalThis.window = Object.assign(new EventTarget(), { devicePixelRatio: 1 });
  setMaxListeners(0, window);
  const song = emptySong();
  const clip = addClip(song, { start: 4.25, length: 0.5 });
  song.selected = clip.id;
  const transport = new Transport({
    getSong: () => song, getBpm: () => 120, getTarget: () => null, now: () => 0,
    ticker: () => ({ start() {}, stop() {} }),
  });
  let viewChanges = 0;
  let panics = 0;
  const engine = { song, resume() {}, panic() { panics++; }, root: { modules: new Map(), listeners: new Set() } };
  const seq = createSequencer({
    engine,
    transport, getTarget: () => null, defaultTarget: () => null, onChange() { viewChanges++; },
  });
  seq.reload();
  flush();
  const free = elements.get('seq-free-time');
  assert.equal(free.checked, false, 'Free timing defaults off');
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
  assert.equal(panics, 0, 'a single stop is no panic');
  press("'");
  assert.equal(panics, 1, "a second ' in a row is a panic");
  assert.match(elements.get('status').textContent, /Panic/);
  press("'");
  assert.equal(panics, 2, 'more presses keep panicking');
  press('.');
  press("'");
  assert.equal(panics, 2, 'playing in between: stop again, no panic');
  assert.equal(transport.playing, false);
  for (const props of [{ repeat: true }, { ctrlKey: true }]) press("'", props);
  assert.equal(panics, 2, 'ignored key presses do not count');
  press('/');
  press("'");
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
  const rollCanvas = elements.get('roll').children[0];
  seq.applyView({ roll: { sy: 0, ppq: 48 } });
  flush();
  point(rollCanvas, 'pointermove', 200, ny(0.37));
  assert.ok(press(' ', {}, rollCanvas).defaultPrevented);
  assert.equal(transport.pos, 4.5, 'Space starts at clip start plus floor-snapped mouse time');
  assert.equal(transport.clipId, null, 'Space plays the song, not a clip loop');
  transport.tick(200);
  assert.ok(transport.pos > clip.start + clip.length, 'song playback continues past the selected clip end');
  press(' ', {}, rollCanvas);
  assert.equal(transport.pos, clip.start, 'Space still stops and parks at the clip start');
  press('/');
  assert.equal(transport.pos, clip.start, 'slash ignores the mouse time');
  assert.equal(transport.clipId, clip.id);
  transport.tick(250);
  assert.ok(transport.pos < clip.start + clip.length, 'only slash loops the selected clip');
  press(' ');
  point(rollCanvas, 'pointerleave', 200, ny(0.37));
  press(' ');
  assert.equal(transport.pos, clip.start, 'outside the roll, Space uses the parked playhead');
  press(' ');
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
    const { top, bottom } = seq.viewState();
    return { left, right: left + 24, width: 24, top: 124 + top * 500, height: (bottom - top) * 500 };
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

  // The toolbar is on the divider: it does not reserve space in the piano-roll pane.
  const bar = elements.get('seq-bar');
  bar.getBoundingClientRect = () => ({ top: 100, height: 50 });
  seq.applyView({ top: 0.4, bottom: 0.75 });
  drag(upper, 300, 310, 300, -1000);
  near(seq.viewState().top, 0);
  assert.ok(workspace.classes.has('roll-collapsed'), 'the piano roll collapses completely');
  drag(lower, 300, 510, 300, -1000);
  assert.deepEqual(positions(), [0, 0], 'the lower divider can push it all the way to the top');
  key(upper, 'Home');
  near(seq.viewState().top, 0);
  seq.applyView({ top: 0.4, bottom: 0.75 });
  drag(upper, 300, 310, 300, -1000);
  drag(lower, 300, 510, 300, 1000);
  press('s');
  near(positions()[0], 0);
  assert.equal(positions()[1], 0.75, 'dragged to the top + bottom: S restores the last visible layout');
  press('s');
  assert.deepEqual(positions(), [0, 1], 'S maximizes the patcher while the divider toolbar stays visible');
  press('s');
  near(positions()[0], 0);
  delete bar.getBoundingClientRect;

  for (const kind of ['button', 'input', 'select', 'label', '.spinbox']) {
    const target = new Element(kind);
    const down = new Event('pointerdown', { cancelable: true });
    Object.assign(down, { button: 0, pointerId: 1, clientX: 300, clientY: 310 });
    Object.defineProperty(down, 'target', { value: target });
    upper.dispatchEvent(down);
    assert.equal(down.defaultPrevented, false, 'divider does not capture toolbar controls');
    const arrow = new Event('keydown', { cancelable: true });
    Object.assign(arrow, { key: 'ArrowDown' });
    Object.defineProperty(arrow, 'target', { value: target });
    upper.dispatchEvent(arrow);
    assert.equal(arrow.defaultPrevented, false, 'widget navigation never resizes the divider');
  }

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

  // The controller divider picks a boundary at grab time, relative to its centred grip.
  const controllerY = (offset) => {
    const rect = controller.getBoundingClientRect();
    return rect.top + rect.height / 2 + offset;
  };
  for (const [offset, expected] of [[-10, [0.5, 0.75]], [10, [0.4, 0.85]], [0, [0.5, 0.75]]]) {
    seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
    const y = controllerY(offset);
    const before = viewChanges;
    point(controller, 'pointerdown', 292, y);
    assert.deepEqual(positions(), [0.4, 0.75], 'grabbing either half does not jump');
    point(controller, 'pointermove', 412, y + 50);
    assert.equal(seq.viewState().panelWidth, 400, 'both halves also resize controller width');
    near(seq.viewState().top, expected[0]);
    near(seq.viewState().bottom, expected[1]);
    point(controller, 'pointerup', 412, y + 50);
    assert.equal(viewChanges, before + 1, 'each controller drag saves once');
  }
  seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
  let y = controllerY(10);
  point(controller, 'pointerdown', 292, y);
  point(controller, 'pointermove', 292, y - 250);
  assert.deepEqual(positions(), [0.25, 0.25], 'lower-half grab pushes the upper boundary on collision');
  point(controller, 'pointermove', 292, y - 100);
  near(seq.viewState().top, 0.25);
  near(seq.viewState().bottom, 0.55);
  point(controller, 'pointercancel', 292, y - 100);
  point(controller, 'pointermove', 292, y + 100);
  near(seq.viewState().bottom, 0.55, 'cancelled lower-half drag stops moving');
  const savedLowerDrag = JSON.parse(JSON.stringify(seq.viewState()));
  seq.applyView(null);
  seq.applyView(savedLowerDrag);
  near(seq.viewState().bottom, 0.55, 'lower-half resize survives saving/restoring');

  seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
  y = controllerY(10);
  drag(controller, 292, y, 292, y + 500);
  assert.deepEqual(positions(), [0.4, 1], 'lower half collapses the TimeLine without moving the upper divider');
  y = controllerY(10);
  drag(controller, 292, y, 292, y - 50);
  near(seq.viewState().bottom, 0.9, 'lower half reopens the TimeLine');

  // Upper-half grabs retain the existing behaviour and both grab offsets.
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
  free.checked = true;
  free.dispatchEvent(new Event('change'));
  assert.equal(engine.song.snap.free, true);
  assert.equal(free.checked, true);
  free.checked = false;
  free.dispatchEvent(new Event('change'));
  assert.equal(engine.song.snap.free, undefined);
}

// playback never scrolls the piano roll or the TimeLine
{
  const { roll, arranger, ctx } = setup();
  const sy0 = roll.getView().sy;
  const sx0 = arranger.getView().sx;
  for (const pos of [0, 6, 10, 40]) {
    Object.assign(ctx.transport, { playing: true, pos });
    roll.redraw();
    arranger.redraw();
    flush();
    assert.equal(roll.getView().sy, sy0, `piano roll stays put at ${pos}`);
    assert.equal(arranger.getView().sx, sx0, 'the TimeLine stays put');
  }
}

console.log('sequencer interaction tests passed');
