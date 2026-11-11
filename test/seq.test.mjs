import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setMaxListeners } from 'node:events';
import { notePitchAt, setSig, emptySong, addClip, addAutoClip, isAuto, cloneClip, normalizeSong, setLaneMute, snapStep, clipFileText, parseClipFile } from '../src/song.js';
import { createAutomationLane } from '../src/seq/automation.js';
import { createPianoRoll, TOP_MARGIN, GRID_MIN_PX } from '../src/seq/pianoroll.js';
import { createArranger } from '../src/seq/arranger.js';
import { CLIP_H, clipsOverlap } from '../src/seq/clipplacement.js';
import { createSequencer } from '../src/seq/index.js';
import { createSurface, rightHold, rulerDrag } from '../src/seq/surface.js';
import { Transport } from '../src/transport.js';
import { initMouseNavigation } from '../src/mousebuttons.js';
import { createPreferencesManager } from '../src/preferences.js';
import { registerTimelinePreferences, SHOW_INPUT_GRID_ID, SHOW_VERTICAL_BARLINES_ID } from '../src/timelinepreferences.js';

{
  const target = new EventTarget();
  let backs = 0;
  initMouseNavigation(target, () => backs++);
  const dispatch = (type, button) => {
    const event = new Event(type, { cancelable: true });
    event.button = button;
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.ok(dispatch('pointerdown', 3));
  assert.ok(dispatch('pointerup', 3));
  assert.ok(dispatch('mouseup', 3));
  assert.equal(backs, 1, 'pointer navigation works without mousedown and does not repeat on mouseup');
  dispatch('mousedown', 3);
  dispatch('mouseup', 3);
  assert.equal(backs, 2, 'mouse-only navigation still works');
  dispatch('pointerdown', 3);
  dispatch('mousedown', 3);
  dispatch('pointerup', 3);
  dispatch('mouseup', 3);
  assert.equal(backs, 3, 'compatibility events go up exactly one level');
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) assert.ok(dispatch(type, 4), `${type}: Forward navigation suppressed`);
  assert.equal(backs, 3, 'Forward never navigates up');
  dispatch('pointerdown', 3);
  target.dispatchEvent(new Event('pointercancel'));
  dispatch('pointerup', 3);
  assert.equal(backs, 3, 'cancelled Back presses do not navigate');
  assert.equal(dispatch('auxclick', 0), false, 'ordinary buttons remain unchanged');
}

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
    this.context.measureText = () => ({ width: 56, actualBoundingBoxAscent: 18, actualBoundingBoxDescent: 6 });
    this.context.fillRect = (...args) => this.drawing.push(['fillRect', ...args, this.context.fillStyle]);
    this.context.fill = () => this.drawing.push(['fill', this.context.fillStyle]);
    this.context.stroke = () => this.drawing.push(['stroke', this.context.strokeStyle, this.context.lineWidth]);
  }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  setPointerCapture() {}
  focus() { document.activeElement = this; }
}

globalThis.document = { createElement: () => new Canvas(), activeElement: null, addEventListener() {}, removeEventListener() {} };
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
const ROLL_SB = 32; // the piano roll's vertical scrollbar, right of the keys
const ROLL_WIDTH = 120 + 128 * 14 + ROLL_SB;
const note = (pitch, start, length = 1, vel = 0.8) => ({ pitch, start, length, vel });

function setup({ snapVelocity = false } = {}) {
  const song = emptySong();
  const clip = addClip(song, { length: 16, target: 7 });
  song.selected = clip.id;
  let changes = 0;
  let previews = 0;
  const menus = [];
  const ctx = {
    pianorollPreferences: { snapVelocity },
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
  const initialSnap = ctx.pianorollPreferences.snapVelocity;
  const arrangerHost = host();
  const arranger = createArranger(arrangerHost, ctx);
  roll.setView({ sy: 0, ppq: 48 });
  flush();
  return { song, clip, roll, rollHost, arranger, arrangerHost, ctx, menus, initialSnap, initialView, changes: () => changes, previews: () => previews };
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
const ay = (y) => 2 * CLIP_H + y + CLIP_H / 2;

// Resize notifications and playback redraws share one paint, using the latest viewport.
{
  const container = host();
  const sizes = [];
  const paints = [];
  const surface = createSurface(container, (_g, w, h) => paints.push([w, h]), {
    onResize: (w, h) => sizes.push([w, h]),
  });
  flush();
  paints.length = sizes.length = 0;
  surface.redraw();
  container.clientWidth = 500;
  container.resize();
  container.clientWidth = 600;
  container.resize();
  assert.equal(paints.length, 0, 'ResizeObserver must not synchronously paint');
  flush();
  assert.deepEqual(paints, [[600, 400]], 'one paint for the latest size, not each notification');
  assert.deepEqual(sizes, [[600, 400]], 'viewport bookkeeping is coalesced with the paint');
  assert.equal(surface.cv.width, 600);
  assert.equal(surface.cv.style.width, '600px');

  paints.length = 0;
  container.resize();
  flush();
  assert.equal(paints.length, 0, 'an unchanged observer notification does not repaint');
  // A queued playback paint can run before ResizeObserver delivers the new dimensions.
  surface.redraw();
  container.clientHeight = 300;
  flush();
  assert.deepEqual(paints, [[600, 300]], 'playback paint picks up a pending resize');
  container.resize();
  flush();
  assert.equal(paints.length, 1, 'subsequent observer notification does not paint twice');

  paints.length = 0;
  window.devicePixelRatio = 2;
  container.resize();
  flush();
  assert.equal(surface.cv.width, 1200, 'device scale changes still resize the bitmap');
  assert.equal(surface.cv.height, 600);
  assert.deepEqual(paints, [[600, 300]]);
  window.devicePixelRatio = 1;
  container.clientHeight = 0;
  container.resize();
  flush();
  assert.equal(paints.length, 1, 'collapsed views do not paint');
  container.clientHeight = 300;
  container.resize();
  flush();
  assert.equal(paints.length, 2, 'restoring the view paints it again');
}

{
  const originalDocument = document;
  const doc = Object.assign(new EventTarget(), { pointerLockElement: null });
  globalThis.document = doc;
  const cv = new Canvas();
  let exits = 0;
  doc.exitPointerLock = () => { doc.pointerLockElement = null; exits++; doc.dispatchEvent(new Event('pointerlockchange')); };
  cv.requestPointerLock = () => {
    doc.pointerLockElement = cv;
    doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  const movements = [];
  const releases = [];
  rulerDrag(cv, { pointerId: 1, clientX: 100, clientY: 150 }, (x, y) => movements.push([x, y]), e => releases.push(e.type));
  assert.equal(doc.pointerLockElement, null, 'web browsers never request pointer lock even when supported');
  cv.dispatchEvent(Object.assign(new Event('pointermove'), { pointerId: 1, clientX: 120, clientY: 140 }));
  assert.deepEqual(movements, [[20, -10]], 'web dragging applies both axes using cursor coordinates');
  cv.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
  assert.deepEqual(releases, ['pointerup'], 'web dragging finishes normally');
  assert.equal(exits, 0, 'web dragging does not lock or unlock the cursor');
  movements.length = releases.length = 0;
  const originalFiles = window.modsynthFiles;
  window.modsynthFiles = {};
  rulerDrag(cv, { pointerId: 1, clientX: 100, clientY: 150 }, (x, y) => movements.push([x, y]), e => releases.push(e.type));
  assert.equal(doc.pointerLockElement, null, 'desktop clicks do not lock the cursor, preserving double-clicks');
  cv.dispatchEvent(Object.assign(new Event('pointermove'), { pointerId: 1, clientX: 100, clientY: 150 }));
  assert.equal(doc.pointerLockElement, null, 'stationary pointer events do not begin a drag');
  cv.dispatchEvent(Object.assign(new Event('pointermove'), { pointerId: 1, clientX: 103, clientY: 150 }));
  movements.length = 0;
  doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: -518, movementY: -249 }));
  assert.deepEqual(movements, [], 'Firefox pointer-lock recentering does not jump the view');
  for (const [movementX, movementY] of [[20, -10], [-5, 4]]) {
    doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX, movementY }));
  }
  assert.deepEqual(movements, [[23, -10], [18, -6]], 'locked dragging accumulates relative mouse movement');
  doc.dispatchEvent(new Event('mouseup'));
  assert.equal(exits, 1, 'release unlocks the cursor');
  assert.deepEqual(releases, ['mouseup']);
  doc.dispatchEvent(Object.assign(new Event('mousemove'), { movementX: 50, movementY: 50 }));
  assert.equal(movements.length, 2, 'release removes drag listeners');
  await Promise.resolve();
  if (originalFiles === undefined) delete window.modsynthFiles;
  else window.modsynthFiles = originalFiles;
  globalThis.document = originalDocument;
}

{
  const { arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  let changes = 0;
  ctx.viewChanged = () => changes++;
  const before = arranger.getView();
  const x = ax(10), y = 1.5 * CLIP_H;
  ctx.transport.pos = 2.5;
  point(cv, 'pointerdown', x, y, { buttons: 1 });
  point(cv, 'pointermove', x + 32, y - 48, { buttons: 1 });
  assert.ok(Math.abs(arranger.getView().ppq - before.ppq * 1.15) < 1e-9);
  assert.ok(Math.abs(arranger.getView().sx - (10 * arranger.getView().ppq - (x - 70) - 32)) < 1e-9);
  point(cv, 'pointerup', x + 32, y - 48);
  assert.equal(changes, 1, 'combined ruler zoom and pan are saved on release');
  assert.equal(ctx.transport.pos, 2.5, 'ruler navigation leaves the playhead unchanged');
  const saved = arranger.getView();
  point(cv, 'pointerdown', x, y, { buttons: 1 });
  point(cv, 'pointermove', x - 20, y + 48, { buttons: 1 });
  key(cv, 'Escape');
  assert.deepEqual(arranger.getView(), saved, 'Escape restores timeline ruler navigation');
  assert.equal(ctx.transport.pos, 2.5, 'cancelled ruler navigation leaves the playhead unchanged');
}

// Both timeline header rows match clip-lane height, with larger centered labels.
{
  const { arranger } = setup();
  const cv = arranger.surface.cv;
  for (const [x, y, cursor] of [[ax(1), 17, 'text'], [ax(10), 17, 'text'],
    [ax(1), 1.5 * CLIP_H, 'grab'], [200, 384, 'zoom-in']]) {
    point(cv, 'pointermove', x, y);
    assert.equal(cv.style.cursor, cursor);
  }
}

// Both timeline header rows match clip-lane height, with larger centered labels.
{
  const { arranger } = setup();
  const cv = arranger.surface.cv;
  const texts = [];
  cv.context.fillText = (text, x, y) => texts.push({ text, x, y, font: cv.context.font });
  cv.drawing.length = 0;
  arranger.redraw(); flush();
  const signature = texts.find(t => t.text === '4/4');
  const bar = texts.find(t => t.text === '1' && t.x > 70 && t.y === 1.5 * CLIP_H);
  assert.equal(signature.y, CLIP_H / 2 + 0.5);
  assert.ok(signature.font.includes('20px'));
  assert.ok(bar.font.includes('20px'));
  assert.ok(cv.drawing.some(([op, , y, , height, color]) =>
    op === 'fillRect' && color === '#4b3a78' && y === 2 && height === CLIP_H - 3), 'signature flag fits full-height row');
}
const assertNoOverlap = (song) => {
  for (let i = 0; i < song.clips.length; i++) {
    for (let j = i + 1; j < song.clips.length; j++) assert.equal(clipsOverlap(song.clips[i], song.clips[j]), false);
  }
};

// Clip type symbols fit the visible clip height and leave room for the name.
{
  const { song, clip, arranger, ctx } = setup();
  const auto = addAutoClip(song, { start: 0, length: 16, y: CLIP_H, name: 'Curve' });
  const linked = cloneClip(song, clip);
  linked.y = 2 * CLIP_H;
  const cv = arranger.surface.cv;
  const texts = [];
  cv.context.measureText = (text) => {
    const size = Number(/([\d.]+)px/.exec(cv.context.font)[1]);
    const wave = text === '∿';
    return { width: size * 0.6, actualBoundingBoxAscent: size * (wave ? 0.3 : 0.7), actualBoundingBoxDescent: size * 0.1 };
  };
  cv.context.fillText = (text, x, y) => texts.push({ text, x, y, font: cv.context.font, baseline: cv.context.textBaseline });
  for (const ppq of [16, 2]) {
    texts.length = 0;
    arranger.setView({ ppq });
    flush();
    for (const [c, symbol] of [[clip, '♫'], [auto, '∿'], [linked, '♫']]) {
      const top = 2 * CLIP_H + c.y;
      const icon = texts.find((t) => t.text === symbol && t.y >= top && t.y < top + CLIP_H);
      assert.ok(icon, `${symbol} is drawn separately from the clip name at zoom ${ppq}`);
      assert.equal(icon.baseline, 'alphabetic');
      cv.context.font = icon.font;
      const metrics = cv.context.measureText(symbol);
      assert.ok(Math.abs(icon.y - metrics.actualBoundingBoxAscent - (top + 2)) < 1e-9, 'glyph has 2px top padding');
      assert.ok(Math.abs(icon.y + metrics.actualBoundingBoxDescent - (top + CLIP_H - 2)) < 1e-9, 'glyph has 2px bottom padding');
      const label = texts.find((t) => t.y === top + CLIP_H / 2);
      assert.ok(label.text.includes(`${c.name}  ${ctx.targetLabel(c)}`), 'name and target are preserved');
      assert.equal(label.baseline, 'middle', 'label is vertically centered');
      assert.ok(label.x >= icon.x + metrics.width + 4, 'label does not overlap the icon');
      assert.equal(label.x, icon.x + metrics.width + 4, 'label starts immediately after the icon');
      if (c === clip) assert.ok(label.text.startsWith('⧉ '), 'linked source marker is preserved');
      if (c === linked) assert.ok(!label.text.startsWith('⧉ '), 'clone keeps its existing label');
    }
  }
}

// Labels follow the viewport's left edge, but are clipped to the visible part of their clip.
{
  const { song, clip, arranger, ctx } = setup();
  const auto = addAutoClip(song, { start: 0, length: 16, y: CLIP_H, name: 'Curve' });
  const cv = arranger.surface.cv;
  const texts = [];
  cv.context.fillText = (text, x, y) => texts.push({ text, x, y, align: cv.context.textAlign });
  for (const sx of [0, 40, 120, 250, -100]) {
    cv.drawing.length = 0;
    texts.length = 0;
    arranger.setView({ sx, ppq: 16 }); flush();
    for (const c of [clip, auto]) {
      const label = texts.find(t => t.text === `${c.name}  ${ctx.targetLabel(c)}`);
      assert.ok(label, 'both MIDI and automation names are drawn');
      const x = ax(c.start) - sx;
      const iconEnd = x + 8 + 56 * (CLIP_H - 4) / 24;
      assert.equal(label.x, Math.max(iconEnd, 74), 'label is as far left as possible without overlapping the icon');
      assert.equal(label.align, 'left');
      const left = Math.max(x + 2, 70);
      const right = Math.min(x + c.length * 16 - 2, 480 - 32);
      assert.ok(cv.drawing.some(([op, rx, ry, rw, rh]) =>
        op === 'rect' && rx === left && ry === 2 * CLIP_H + c.y && rw === Math.max(0, right - left) && rh === CLIP_H),
      'label clipping never extends beyond the clip or viewport, including a narrow remaining sliver');
    }
  }
}

// Timeline display preferences hide lane decorations, never ruler marks or snapping.
{
  const { song, arranger, ctx, changes } = setup();
  setSig(song, 8, 3, 4);
  const originalSnap = { ...song.snap };
  const cv = arranger.surface.cv;
  let saved = null;
  const manager = createPreferencesManager({ storage: {
    load: async () => saved, save: async (text) => { saved = text; },
  } });
  ctx.timelineDisplay = registerTimelinePreferences(manager, () => arranger.redraw());
  await manager.load();
  const paint = () => {
    cv.drawing.length = 0;
    arranger.redraw(); flush();
    return {
      bands: cv.drawing.filter(([op, , , , , color]) => op === 'fillRect' && color === 'rgba(255, 255, 255, 0.022)').length,
      bars: cv.drawing.filter(([op, color]) => op === 'stroke' && color === '#2a2a2f').length,
      signatures: cv.drawing.filter(([op, color]) => op === 'stroke' && color === '#4b3a78').length,
      ruler: cv.drawing.filter(([op, color]) => op === 'stroke' && color === '#3a3a40').length,
    };
  };
  const defaults = paint();
  assert.ok(defaults.bands > 0 && defaults.bars > 0 && defaults.signatures > 0 && defaults.ruler > 0);
  for (const grid of [true, false]) for (const bars of [true, false]) {
    manager.preview(SHOW_INPUT_GRID_ID, grid);
    manager.preview(SHOW_VERTICAL_BARLINES_ID, bars);
    const result = paint();
    assert.equal(result.bands > 0, grid);
    assert.equal(result.bars > 0, bars);
    assert.equal(result.signatures > 0, bars);
    assert.equal(result.ruler, defaults.ruler, 'ruler bar marks remain unchanged');
    assert.ok(cv.drawing.some(([op, text]) => op === 'fillText' && text === '3/4'), 'signature label remains in ruler');
  }
  manager.restore();
  assert.deepEqual(paint(), defaults, 'Cancel restores both decorations');
  await manager.save({ [SHOW_INPUT_GRID_ID]: false, [SHOW_VERTICAL_BARLINES_ID]: false });
  const reloaded = createPreferencesManager({ storage: { load: async () => saved, save: async () => {} } });
  ctx.timelineDisplay = registerTimelinePreferences(reloaded, () => arranger.redraw());
  await reloaded.load();
  assert.equal(paint().bands, 0);
  assert.equal(paint().bars, 0);
  assert.deepEqual(song.snap, originalSnap, 'display preferences never change snapping');
  assert.equal(changes(), 0, 'display preferences do not edit the song');
}

// Mini notes use the full clip height, without reserving a header for the label.
{
  const { clip, arranger } = setup();
  clip.notes = [note(48, 2, 1), note(72, 4, 2)];
  const cv = arranger.surface.cv;
  cv.drawing.length = 0;
  arranger.redraw(); flush();
  const notes = cv.drawing.filter(([op, , , , , color]) => op === 'fillRect' && color === 'rgba(0, 0, 0, 0.55)');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map(([, x, y, w, h]) => [x, y, w, h]), [
    [ax(2), 2 * CLIP_H + CLIP_H - 4, 15, 2],
    [ax(4), 2 * CLIP_H + 2, 31, 2],
  ], 'low and high notes reach the bottom and top padding, preserving their timing');
  clip.notes = [note(60, 2)];
  cv.drawing.length = 0;
  arranger.redraw(); flush();
  const single = cv.drawing.find(([op, , , , , color]) => op === 'fillRect' && color === 'rgba(0, 0, 0, 0.55)');
  assert.equal(single[2] + single[4] / 2, 2 * CLIP_H + CLIP_H / 2, 'a single-pitch preview stays centered');
}

// Camera-only interactions schedule persistence without creating undo steps.
{
  const { roll, arranger, ctx, changes } = setup();
  let viewChanges = 0;
  ctx.viewChanged = () => viewChanges++;
  const expectViewChange = (action, label) => {
    const before = viewChanges;
    action();
    assert.ok(viewChanges > before, `${label} schedules a view save`);
  };
  const rollCv = roll.surface.cv;
  expectViewChange(() => fire(rollCv, 'wheel', { clientX: 400, clientY: 100, deltaY: 60, deltaMode: 0 }), 'roll scroll');
  expectViewChange(() => fire(rollCv, 'wheel', { clientX: 400, clientY: 100, deltaY: -100, deltaMode: 0, ctrlKey: true }), 'roll time zoom');
  expectViewChange(() => fire(rollCv, 'wheel', { clientX: 400, clientY: 100, deltaY: -100, deltaMode: 0, shiftKey: true }), 'roll pitch zoom');
  expectViewChange(() => drag(rollCv, 400, 100, 430, 120, { button: 1 }), 'roll pan');
  expectViewChange(() => click(rollCv, ROLL_WIDTH - ROLL_SB / 2, 300), 'roll vertical scrollbar');
  expectViewChange(() => click(rollCv, ROLL_WIDTH - ROLL_SB - 2, 360), 'roll horizontal scrollbar');
  const arrangerCv = arranger.surface.cv;
  expectViewChange(() => fire(arrangerCv, 'wheel', { clientX: 200, clientY: 100, deltaY: 60, deltaMode: 0 }), 'timeline scroll');
  expectViewChange(() => fire(arrangerCv, 'wheel', { clientX: 200, clientY: 100, deltaY: -100, deltaMode: 0, ctrlKey: true }), 'timeline zoom');
  expectViewChange(() => drag(arrangerCv, 200, 150, 230, 170, { button: 1 }), 'timeline pan');
  expectViewChange(() => click(arrangerCv, 400, 390), 'timeline scrollbar');
  assert.equal(changes(), 0, 'camera interactions do not create undo steps');
}

// Restoring the TimeLine after layout changes must not apply the old viewport's resize again.
{
  const { arranger, arrangerHost } = setup();
  arrangerHost.clientWidth = 600;
  arrangerHost.clientHeight = 250;
  const saved = { sx: 170, sy: -90, ppq: 32 };
  arranger.setView(saved);
  arrangerHost.resize();
  flush();
  assert.deepEqual(arranger.getView(), saved);
}

{
  const song = emptySong();
  const clip = addAutoClip(song, { length: 16 });
  song.selected = clip.id;
  let viewChanges = 0;
  let changes = 0;
  const lane = createAutomationLane(host(), {
    song: () => song, clip: () => clip, color: () => '#e76f51',
    transport: { playing: false, pos: 0 }, autoParam: () => null,
    changed: () => changes++, viewChanged: () => viewChanges++,
  });
  flush();
  const cv = lane.surface.cv;
  for (const action of [
    () => fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaY: 60, deltaMode: 0 }),
    () => fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaY: -100, deltaMode: 0, ctrlKey: true }),
    () => drag(cv, 200, 150, 200, 170, { button: 1 }),
  ]) {
    const before = viewChanges;
    action();
    assert.ok(viewChanges > before, 'automation camera schedules a view save');
  }
  const saved = lane.getView();
  lane.setView({ sy: 0, ppq: 48 });
  lane.setView(saved);
  flush();
  assert.deepEqual(lane.getView(), saved, 'automation view survives a round trip');
  assert.equal(changes, 0, 'automation camera does not create undo steps');
}

// TimeLine resizing retains the time/lane at its centre, including hide/restore.
{
  const { arranger, arrangerHost, changes } = setup();
  arranger.setView({ sx: 170, sy: -90, ppq: 32 });
  flush();
  const centre = () => {
    const v = arranger.getView();
    return { time: (arrangerHost.clientWidth / 2 + v.sx) / v.ppq, lane: arrangerHost.clientHeight / 2 + v.sy };
  };
  const before = centre();
  for (const [w, h] of [[480, 200], [800, 200], [320, 600], [480, 400]]) {
    arrangerHost.clientWidth = w;
    arrangerHost.clientHeight = h;
    arrangerHost.resize();
    flush();
    assert.deepEqual(centre(), before, 'same time and lane remain centred');
    assert.equal(arranger.getView().ppq, 32, 'zoom unchanged');
  }
  assert.deepEqual(arranger.getView(), { sx: 170, sy: -90, ppq: 32 }, 'no round-trip drift');
  arrangerHost.clientHeight = 0;
  arrangerHost.resize(); flush();
  arrangerHost.clientHeight = 300;
  arrangerHost.resize(); flush();
  assert.deepEqual(centre(), before, 'restoring uses the last visible viewport');
  assert.equal(changes(), 0, 'resizing is not a song edit');
}

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
  point(cv, 'pointerdown', nx(60), ny(1.37), { buttons: 1 });
  point(cv, 'pointermove', nx(60), ny(1.37) + 11, { buttons: 1 });
  point(cv, 'pointermove', nx(60), ny(1.49), { buttons: 1 });
  point(cv, 'pointerup', nx(60), ny(1.49));
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
// clip playback: keys of the notes under the playhead light up in the clip's note colour
{
  const { clip, roll, ctx } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 2), note(63, 2, 1), note(67, 5, 1), note(70, 20, 1));
  const keyFill = (p) => cv.drawing.findLast(([op, x, y, w]) => op === 'fillRect' && y === 377 && x <= nx(p) && nx(p) < x + w)?.at(-1);
  const paintAt = (pos, playing = true) => {
    Object.assign(ctx.transport, { pos: clip.start + pos, playing });
    cv.drawing.length = 0;
    roll.redraw(); flush();
  };
  const noteColor = 'color-mix(in srgb, #e76f51 75%, #fff)';
  paintAt(2.5);
  assert.equal(keyFill(60), noteColor, 'sounding white key: note colour');
  assert.match(keyFill(63), /color-mix\(in srgb, color-mix\(in srgb, #e76f51/, 'sounding black key: darker note colour');
  assert.notEqual(keyFill(67), noteColor, 'later note not lit yet');
  paintAt(3);
  assert.notEqual(keyFill(60), noteColor, 'note end releases the key');
  paintAt(0.5);
  assert.notEqual(keyFill(60), noteColor, 'before the note starts');
  paintAt(2.5, false);
  assert.notEqual(keyFill(60), noteColor, 'paused / stopped: no highlight');
  ctx.heldKeys = () => new Set([60]);
  paintAt(2.5);
  assert.equal(keyFill(60), '#65b4ff', 'keys held live win over clip playback');
  delete ctx.heldKeys;
  Object.assign(ctx.transport, { pos: 0, playing: false });
}

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
  if (ending === 'pointerup') {
    // keys held on the MIDI device / computer keyboard light up in the selection colour
    const held = new Set([62, 63]);
    ctx.heldKeys = () => held;
    roll.redraw();
    flush();
    const keyFill = (p) => cv.drawing.findLast(([op, x, y, w]) => op === 'fillRect' && y === 377 && x <= nx(p) && nx(p) < x + w)?.at(-1);
    assert.equal(keyFill(62), '#65b4ff', 'held white key: selection blue');
    assert.match(keyFill(63), /color-mix\(in srgb, #65b4ff/, 'held black key: darker blue');
    assert.notEqual(keyFill(64), '#65b4ff', 'other keys unchanged');
    delete ctx.heldKeys;
  }
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
  // (Shift + drag on a circle tunes the note, so the rectangle starts there with the right button)
  drag(cv, nx(60), ny(1) + 5, nx(65), ny(2), { button: 2, buttons: 2 });
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

// The timeline always keeps a clip selected: Escape leaves it and reaches the exit shortcut.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  cv.focus();
  assert.equal(song.selected, clip.id);
  for (let i = 0; i < 3; i++) {
    assert.equal(key(cv, 'Escape').defaultPrevented, false, 'the timeline never traps Escape');
    assert.equal(song.selected, clip.id, 'Escape keeps the selected clip');
  }
  assert.equal(document.activeElement, cv, 'timeline remains focused');
}

// Empty clicks, empty rectangles and Ctrl/Cmd + click on the last selected clip keep a clip selected;
// deleting selects the nearest remaining clip.
{
  const { song, clip, arranger, ctx } = setup();
  const cv = arranger.surface.cv;
  const other = addClip(song, { start: 8, length: 4, y: 34, target: 7 });
  click(cv, ax(20), ay(200));
  assert.equal(song.selected, clip.id, 'empty click');
  drag(cv, ax(20), ay(200), ax(24), ay(240));
  assert.equal(song.selected, clip.id, 'empty rectangle');
  click(cv, ax(1), ay(0), { ctrlKey: true });
  assert.equal(song.selected, clip.id, 'Ctrl/Cmd + click cannot deselect the last clip');
  click(cv, ax(9), ay(34), { ctrlKey: true });
  click(cv, ax(1), ay(0), { ctrlKey: true });
  assert.equal(song.selected, other.id, 'with two selected, one can be toggled off');
  key(cv, 'Delete');
  assert.deepEqual(song.clips.map((c) => c.id), [clip.id]);
  assert.equal(song.selected, clip.id, 'the remaining clip is selected');
  assert.equal(ctx.clip(), clip);
}

// Restart point: inserted at the playhead from the ruler / clip / empty-space menu, drawn as 'restart:' and a |
// in the bar number row; right-clicking the marker removes it.
{
  const { song, clip, arranger, ctx, menus, changes } = setup();
  const cv = arranger.surface.cv;
  const rightClick = (x, y) => { point(cv, 'pointerdown', x, y, { button: 2, buttons: 2 }); point(cv, 'pointerup', x, y, { button: 2 }); };
  ctx.transport.pos = 4;
  rightClick(ax(10), 1.5 * CLIP_H);
  assert.deepEqual(labels(menus), ['Insert/Edit time-Signature Change…', 'Insert restart point at playhead', 'Remove restart point']);
  assert.ok(menus.at(-1).items.find(item => item.label === 'Remove restart point').disabled, 'nothing to remove yet');
  pick(menus, 'Insert restart point at playhead');
  assert.equal(song.restart, 4);
  assert.equal(changes(), 1, 'one undo step');
  cv.drawing = [];
  arranger.redraw();
  flush();
  assert.ok(cv.drawing.some(([op, text]) => op === 'fillText' && text === 'restart:'), 'labelled');
  assert.ok(cv.drawing.some(([op, x, , w, , color]) => op === 'fillRect' && x === ax(4) - 1 && w === 3 && color === '#5fd38a'), 'a | at the restart time');
  rightClick(ax(1), ay(clip.y));
  assert.ok(labels(menus).includes('Remove restart point'), 'the clip menu has the items too');
  ctx.transport.pos = 2.5;
  pick(menus, 'Insert restart point at playhead');
  assert.equal(song.restart, 4, 'moves to the nearest barline to the playhead');
  rightClick(ax(30), ay(200));
  assert.ok(labels(menus).includes('Insert restart point at playhead'), 'and the empty-space menu');
  const n = menus.length;
  rightClick(ax(4), 1.5 * CLIP_H);
  assert.equal(menus.length, n, 'the marker opens no menu');
  assert.equal(song.restart, undefined, 'right-click on the marker removes it');
  assert.equal(normalizeSong({ restart: 3 }).restart, 3);
  assert.equal(normalizeSong({ restart: 'x' }).restart, undefined);
}

// Signature dragging previews the whole grid and records only the released edit.
{
  const { song, clip, arranger, ctx, menus, changes } = setup();
  clip.length = 4;
  ctx.transport.pos = 2;
  const cv = arranger.surface.cv;
  holdRightClick(cv, ax(1), ay(0));
  assert.equal(menus.at(-1).items.find(item => item.label === 'Split at playhead').shortcut, 'S');
  key(cv, 's', { ctrlKey: true });
  assert.equal(song.clips.length, 1, 'Ctrl+S remains available for saving');
  key(cv, 's');
  assert.equal(song.clips.length, 2);
  assert.deepEqual(song.clips.map(c => [c.start, c.length]), [[0, 2], [2, 2]]);
  assert.equal(changes(), 1);
  key(cv, 's');
  assert.equal(changes(), 1, 'split at clip boundary is a no-op');
}

// Signature dragging previews the whole grid and records only the released edit.
{
  const { song, arranger, ctx, changes } = setup();
  setSig(song, 8, 3, 4, [0, 2]);
  setSig(song, 14, 7, 8);
  setSig(song, 21, 4, 4);
  arranger.redraw(); flush();
  const cv = arranger.surface.cv;
  const before = structuredClone(song.sigs);
  const start = ax(8) + 6;
  point(cv, 'pointerdown', start, 17, { buttons: 1 });
  point(cv, 'pointermove', start + 64, 17, { buttons: 1 });
  assert.deepEqual(song.sigs.map(sig => sig.at), [0, 12, 15, 22], 'grid changes during drag');
  assert.equal(changes(), 0, 'no undo step during preview');
  point(cv, 'pointermove', start, 17, { buttons: 1 });
  assert.deepEqual(song.sigs, before, 'returning to the original position restores later changes');
  point(cv, 'pointermove', start + 64, 17, { buttons: 1 });
  point(cv, 'pointercancel', start + 64, 17);
  assert.deepEqual(song.sigs, before, 'cancel restores all signature positions');
  assert.equal(changes(), 0);
  point(cv, 'pointerdown', start, 17, { buttons: 1 });
  point(cv, 'pointermove', start + 64, 17, { buttons: 1 });
  key(cv, 'Escape');
  point(cv, 'pointerup', start + 64, 17);
  assert.deepEqual(song.sigs, before, 'Escape restores all signature positions');
  assert.equal(changes(), 0);
  drag(cv, start, 17, start + 64, 17);
  assert.deepEqual(song.sigs.map(sig => sig.at), [0, 12, 15, 22]);
  assert.equal(changes(), 1, 'one undo step on release');
  assert.equal(ctx.transport.pos, 0, 'dragging does not scrub playback');
}

// Signature insertion uses the right-click position, rounded to a bar, in all timeline menus.
{
  const { arranger, ctx, menus } = setup();
  const cv = arranger.surface.cv;
  const edits = [];
  ctx.editSig = at => edits.push(at);
  ctx.transport.pos = 1;
  for (const [time, y, expected] of [[11, 8, 12], [9, 1.5 * CLIP_H, 8], [3, ay(0), 4], [15, ay(200), 16]]) {
    point(cv, 'pointerdown', ax(time), y, { button: 2, buttons: 2 });
    point(cv, 'pointerup', ax(time), y, { button: 2 });
    pick(menus, 'Insert/Edit time-Signature Change…');
    assert.equal(edits.at(-1), expected);
    assert.equal(ctx.transport.pos, 1, 'insertion does not use or move the playhead');
  }
  arranger.setView({ sx: 64, ppq: 32 }); flush();
  point(cv, 'pointerdown', 70 + 11 * 32 - 64, ay(200), { button: 2, buttons: 2 });
  point(cv, 'pointerup', 70 + 11 * 32 - 64, ay(200), { button: 2 });
  pick(menus, 'Insert/Edit time-Signature Change…');
  assert.equal(edits.at(-1), 12, 'position respects timeline scrolling and zoom');
}

// Duration editing needs more than 10 CSS pixels, preserving the remembered length on clicks.
{
  const { clip, roll, previews } = setup();
  const cv = roll.surface.cv;
  drag(cv, nx(60), ny(0), nx(60), ny(2));
  assert.equal(clip.notes[0].length, 2);
  for (const [dx, dy] of [[0, 0], [0, 1], [6, 8], [0, 10]]) {
    point(cv, 'pointerdown', nx(64), ny(3), { buttons: 1 });
    const n = clip.notes.at(-1);
    point(cv, 'pointermove', nx(64) + dx, ny(3) + dy, { buttons: 1 });
    assert.equal(n.length, 2, 'movement up to 10 px keeps the remembered length');
    point(cv, 'pointerup', nx(64) + dx, ny(3) + dy);
    assert.equal(n.length, 2);
    clip.notes.pop();
  }
  point(cv, 'pointerdown', nx(67), ny(3), { buttons: 1 });
  const n = clip.notes.at(-1);
  point(cv, 'pointermove', nx(67), ny(3) + 10, { buttons: 1 });
  assert.equal(n.length, 2, 'exactly 10 px does not resize');
  point(cv, 'pointermove', nx(67), ny(3) + 11, { buttons: 1 });
  assert.notEqual(n.length, 2, 'more than 10 px activates duration editing');
  point(cv, 'pointermove', nx(67), ny(4), { buttons: 1 });
  assert.equal(n.length, 1, 'active duration drag follows pointer');
  point(cv, 'pointerup', nx(67), ny(4));
  click(cv, nx(72), ny(5));
  assert.equal(clip.notes.at(-1).length, 1, 'completed duration becomes the next remembered length');

  const bodyY = ny(0.5);
  point(cv, 'pointerdown', nx(60), bodyY, { buttons: 1 });
  point(cv, 'pointermove', nx(60), bodyY + 10, { buttons: 1 });
  assert.equal(clip.notes[0].length, 2, 'existing body also ignores movement up to 10 px');
  point(cv, 'pointermove', nx(60), bodyY + 11, { buttons: 1 });
  assert.notEqual(clip.notes[0].length, 2, 'body resizing starts past threshold');
  point(cv, 'pointerup', nx(60), bodyY + 11);
  assert.equal(previews(), 0, 'all insertion previews released');
}

// Velocity memory follows duration memory's gesture, lifetime and cancellation rules.
{
  const { clip, song, roll, ctx } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 2, 0.3);
  const b = note(64, 4, 1, 0.7);
  clip.notes.push(a, b);
  const inserted = (velocity, length = 2) => {
    click(cv, nx(72), ny(5));
    const n = ctx.clip().notes.pop();
    assert.equal(n.vel, velocity);
    assert.equal(n.length, length);
    assert.deepEqual(n.vels, [{ t: length, v: velocity, r: 0 }], 'new notes have a flat curve at the remembered velocity');
  };
  click(cv, nx(60), ny(1.5));
  inserted(0.8); // a duration-body click adopts length, not velocity
  click(cv, vx(0.3), ny(1));
  inserted(0.3);
  click(cv, nx(64), ny(4) + 5);
  inserted(0.3); // selection through the notehead does not adopt its velocity
  drag(cv, nx(64), ny(4) + 5, nx(65), ny(4.5) + 5);
  inserted(0.3);
  for (const ending of ['pointercancel', 'lostpointercapture', 'pointerup']) {
    drag(cv, vx(a.vel), ny(1), vx(0.6), ny(1), {}, ending);
    if (ending === 'pointercancel') {
      assert.ok(Math.abs(a.vel - 0.3) < 1e-9, 'cancel restores the edited note');
      inserted(0.3);
    } else {
      inserted(a.vel); // lost capture commits, just as it does for duration
    }
  }
  const remembered = a.vel;
  const other = addClip(song, { length: 16, target: 7 });
  ctx.select(other.id);
  roll.setView(null);
  roll.setView({ sy: 0, ppq: 48, snapVelocity: false });
  inserted(remembered);
}

// Exact velocity endpoints and snapping are remembered, without re-snapping on insertion.
for (const [snapVelocity, value] of [[false, 0], [false, 1], [false, 0.53], [true, 0.53]]) {
  const { clip, roll, ctx } = setup({ snapVelocity });
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 2, 0.8));
  drag(cv, 7 + 0.8 * 70, ny(1), 7 + value * 70, ny(1));
  const expected = snapVelocity ? Math.round(value * 16) / 16 : clip.notes[0].vel;
  ctx.pianorollPreferences.snapVelocity = !snapVelocity;
  click(cv, nx(64), ny(4));
  assert.equal(clip.notes.at(-1).vel, expected);
  assert.deepEqual(clip.notes.at(-1).vels, [{ t: 0.25, v: expected, r: 0 }]);
}

// Group edits remember the grabbed note, not the earliest note or a curve-point value.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 2, 0.2);
  const b = note(64, 4, 2, 0.5);
  clip.notes.push(a, b);
  key(cv, 'a', { ctrlKey: true });
  drag(cv, vx(0.5), ny(4), vx(0.7), ny(4));
  click(cv, nx(72), ny(6));
  assert.equal(clip.notes.at(-1).vel, b.vel);
  clip.notes.pop();
  click(cv, vx(a.vel), ny(1));
  dbl(cv, vx(0.9), ny(2));
  click(cv, nx(72), ny(6));
  assert.equal(clip.notes.at(-1).vel, a.vel, 'interior curve values are not copied as start velocities');
  assert.equal(clip.notes.at(-1).vels[0].v, a.vel, 'curves themselves are not copied');
}

// Straight-line edits remember the covered note start nearest the release, in either direction.
for (const reverse of [false, true]) {
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  clip.notes.push(note(60, 1, 1, 0.5), note(64, 3, 1, 0.5));
  const [from, to] = reverse ? [[0.8, 4], [0.2, 0]] : [[0.2, 0], [0.8, 4]];
  drag(cv, vx(from[0]), ny(from[1]), vx(to[0]), ny(to[1]), { ctrlKey: true }, 'pointercancel');
  click(cv, nx(72), ny(6));
  assert.equal(clip.notes.pop().vel, 0.8, 'cancelled line does not update memory');
  key(cv, 'Escape');
  drag(cv, vx(from[0]), ny(from[1]), vx(to[0]), ny(to[1]), { ctrlKey: true });
  const expected = clip.notes[reverse ? 0 : 1].vel;
  click(cv, nx(72), ny(6));
  assert.equal(clip.notes.at(-1).vel, expected);
}

// Ordinary insertion, duration edits and head moves still work; short right click deletes.
{
  const { clip, roll, previews, menus } = setup();
  const cv = roll.surface.cv;
  drag(cv, nx(60), ny(1), nx(60), ny(2));
  const end = (length, v = 0.8) => ({ vels: [{ t: length, v, r: 0 }] });
  assert.deepEqual(clip.notes, [{ ...note(60, 1), ...end(1) }], 'a new note has a velocity point at its end');
  drag(cv, nx(60), ny(1.5), nx(60), ny(2.5));
  assert.equal(clip.notes[0].length, 1.5, 'the end jumps to the snapped pointer');
  assert.deepEqual(clip.notes[0].vels, end(1.5).vels, 'the end velocity point follows the note end');
  drag(cv, nx(60), ny(1) + 5, nx(62), ny(2) + 5);
  assert.deepEqual(clip.notes, [{ ...note(62, 2, 1.5), ...end(1.5) }]);
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

// The selection rectangle survives scrolling: the wheel (or dragging past the grid's bottom edge)
// moves the view while the start corner stays put in the clip, so a selection can span the clip.
for (const how of ['wheel', 'edge']) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { clip, roll, menus, changes } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1), note(62, 6), note(64, 14), note(80, 14));
    point(cv, 'pointerdown', nx(59), ny(0.5), { button: 2, buttons: 2 });
    if (how === 'wheel') {
      for (let i = 0; i < 60; i++) fire(cv, 'wheel', { clientX: nx(66), clientY: 200, deltaX: 0, deltaY: 100, deltaMode: 0 });
      point(cv, 'pointermove', nx(66), 200, { button: 2, buttons: 2 });
    } else {
      point(cv, 'pointermove', nx(66), 300, { button: 2, buttons: 2 });
      point(cv, 'pointermove', nx(66), 1000, { button: 2, buttons: 2 }); // far below the grid
      mock.timers.tick(5000); flush();
    }
    const sy = roll.getView().sy;
    assert.ok(sy > ny(10), `${how}: the view scrolled down (${sy})`);
    mock.timers.tick(1000);
    point(cv, 'pointerup', nx(66), how === 'wheel' ? 200 : 1000, { button: 2 });
    assert.equal(menus.length, 0, `${how}: no menu`);
    assert.equal(changes(), 0, `${how}: nothing deleted`);
    key(cv, 'Delete');
    assert.deepEqual(clip.notes.map((n) => n.pitch), [80], `${how}: the notes from the top to the scrolled-to bottom were selected`);
  } finally {
    mock.timers.reset();
  }
}

// Dragging a note's duration past the bottom edge (or with the wheel) scrolls the view along, as the clip end.
{
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { clip, roll } = setup();
    const cv = roll.surface.cv;
    clip.length = 64;
    roll.redraw(); flush();
    // new note: drag past the bottom edge
    point(cv, 'pointerdown', nx(64), ny(0), { buttons: 1 });
    point(cv, 'pointermove', nx(64), 1000, { buttons: 1 });
    mock.timers.tick(3000); flush();
    point(cv, 'pointerup', nx(64), 1000);
    const n = clip.notes.at(-1);
    assert.ok(n.length > 20, `edge auto-scroll lengthened the new note (${n.length})`);
    assert.equal(n.length, Math.round(n.length * 4) / 4, 'still snapped');
    mock.timers.tick(1000); // no interval left running
    // existing body: wheel while dragging
    roll.setView({ sy: 0 }); flush();
    n.length = 1;
    roll.redraw(); flush();
    point(cv, 'pointerdown', nx(64), ny(0.5), { buttons: 1 });
    point(cv, 'pointermove', nx(64), 300, { buttons: 1 });
    const before = n.length;
    for (let i = 0; i < 20; i++) fire(cv, 'wheel', { clientX: nx(64), clientY: 300, deltaX: 0, deltaY: 100, deltaMode: 0 });
    point(cv, 'pointerup', nx(64), 300);
    assert.ok(n.length > before + 3, `the wheel scrolled the note end along (${before} → ${n.length})`);
    // moving a note (circle) past the bottom edge scrolls too, carrying the note along
    roll.setView({ sy: 0 }); flush();
    n.length = 1;
    roll.redraw(); flush();
    point(cv, 'pointerdown', nx(64), ny(0), { buttons: 1 });
    point(cv, 'pointermove', nx(64), 1000, { buttons: 1 });
    mock.timers.tick(3000); flush();
    point(cv, 'pointerup', nx(64), 1000);
    assert.ok(roll.getView().sy > 500, 'moves auto-scroll');
    assert.ok(n.start > 20, `the moved note travelled with the view (${n.start})`);
    assert.equal(n.start, Math.round(n.start * 4) / 4, 'start still snapped');
    assert.equal(n.length, 1, 'a move keeps the length');
    mock.timers.tick(1000);
    // and back up past the top edge
    roll.setView({ sy: n.start * 48 - 100 }); flush();
    point(cv, 'pointerdown', nx(64), n.start * 48 - roll.getView().sy, { buttons: 1 });
    point(cv, 'pointermove', nx(64), -200, { buttons: 1 });
    mock.timers.tick(5000); flush();
    point(cv, 'pointerup', nx(64), -200);
    assert.equal(n.start, 0, 'dragging past the top scrolls back to the clip start');
  } finally {
    mock.timers.reset();
  }
}

// Every drag along the time axis scrolls the view along near / past an edge: bend points, velocity
// curve points, automation points, the TimeLine selection rectangle and the restart marker.
{
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    {
      const { clip, roll } = setup();
      const cv = roll.surface.cv;
      clip.length = 64;
      const n = note(60, 0, 64);
      n.bends = [{ t: 1, d: 0, r: 0 }];
      clip.notes.push(n);
      key(cv, 'a', { ctrlKey: true });
      flush();
      point(cv, 'pointerdown', nx(60), ny(1), { buttons: 1 });
      point(cv, 'pointermove', nx(60), 1000, { buttons: 1 });
      mock.timers.tick(3000); flush();
      point(cv, 'pointerup', nx(60), 1000);
      assert.ok(n.bends[0].t > 20, `bend point travelled with the view (${n.bends[0].t})`);
      mock.timers.tick(1000);
    }
    {
      const { clip, roll } = setup();
      const cv = roll.surface.cv;
      const vx = (v) => 7 + v * 70;
      clip.length = 64;
      const n = note(60, 0, 64, 0.5);
      clip.notes.push(n);
      click(cv, vx(0.5), ny(0));
      dbl(cv, vx(0.5), ny(2));
      const before = JSON.stringify(n.vels);
      point(cv, 'pointerdown', vx(0.5), ny(2), { buttons: 1 });
      point(cv, 'pointermove', vx(0.5), 1000, { buttons: 1 });
      mock.timers.tick(3000); flush();
      point(cv, 'pointerup', vx(0.5), 1000);
      const last = Math.max(...(n.vels ?? []).map((p) => p.t));
      assert.ok(last > 20, `velocity point travelled with the view (${before} → ${JSON.stringify(n.vels)})`);
      assert.ok(roll.getView().sy > 500, 'the roll scrolled');
      mock.timers.tick(1000);
    }
    {
      const song = emptySong();
      const a = addAutoClip(song, { length: 64, target: 1, controller: 0 });
      song.selected = a.id;
      a.points.push({ t: 1, v: 0.5, r: 0 }, { t: 2, v: 0.5, r: 0 });
      const lane = createAutomationLane(host(), {
        song: () => song, clip: () => a, color: () => '#e76f51', transport: { playing: false, pos: 0 },
        changed() {}, autoParam: () => ({ p: {}, format: (v) => `${Math.round(v * 100)}` }),
      });
      flush();
      const cv = lane.surface.cv;
      const lx = (v) => 48 + v * (420 - ROLL_SB);
      const ly = (t) => t * 48 - lane.getView().sy;
      point(cv, 'pointerdown', lx(0.5), ly(2), { buttons: 1 });
      point(cv, 'pointermove', lx(0.5), 1000, { buttons: 1 });
      mock.timers.tick(3000); flush();
      point(cv, 'pointerup', lx(0.5), 1000);
      assert.ok(a.points[1].t > 20, `automation point travelled with the view (${a.points[1].t})`);
      assert.equal(a.points[1].t, Math.round(a.points[1].t * 4) / 4, 'still snapped');
      mock.timers.tick(1000);
    }
    {
      const { song, clip, arranger } = setup();
      const cv = arranger.surface.cv;
      clip.length = 4;
      const far = addClip(song, { start: 60, length: 4 });
      point(cv, 'pointerdown', ax(5), ay(60), { buttons: 1 });
      point(cv, 'pointermove', 478, ay(0), { buttons: 1 });
      mock.timers.tick(2000); flush();
      point(cv, 'pointerup', 478, ay(0));
      assert.ok(arranger.getView().sx > 500, 'the rectangle scrolled the TimeLine');
      key(cv, 'Delete');
      assert.deepEqual(song.clips, [clip], 'the far clip was selected by the scrolled rectangle');
      assert.ok(!song.clips.includes(far));
      mock.timers.tick(1000);
      arranger.setView({ sx: 0 }); flush();
      const RY = 1.5 * CLIP_H;
      point(cv, 'dblclick', ax(4), RY);
      assert.equal(song.restart, 4);
      point(cv, 'pointerdown', ax(4), RY, { buttons: 1 });
      point(cv, 'pointermove', 478, RY, { buttons: 1 });
      mock.timers.tick(2000); flush();
      point(cv, 'pointerup', 478, RY);
      assert.ok(song.restart > 40, `the dragged restart marker scrolled along (${song.restart})`);
    }
  } finally {
    mock.timers.reset();
  }
}

// Dragging the thick clip end line changes the clip length instead of adding a note; the wheel and
// dragging past the bottom edge scroll the view along, so the end can go anywhere in one drag.
{
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { song, clip, roll, changes } = setup();
    const cv = roll.surface.cv;
    clip.length = 4;
    roll.redraw(); flush();
    point(cv, 'pointermove', nx(70), ny(4) + 2);
    assert.equal(cv.style.cursor, 'row-resize', 'the end line shows a resize cursor');
    drag(cv, nx(70), ny(4) + 2, nx(70), ny(2.1));
    assert.equal(clip.length, 2, 'dragging up shortens the clip (snapped)');
    assert.equal(clip.notes.length, 0, 'no note was added');
    assert.equal(changes(), 1, 'one undo step');
    // Escape cancels the drag and restores the length
    point(cv, 'pointerdown', nx(70), ny(2), { buttons: 1 });
    point(cv, 'pointermove', nx(70), ny(5), { buttons: 1 });
    assert.equal(clip.length, 5);
    key(cv, 'Escape');
    point(cv, 'pointerup', nx(70), ny(5));
    assert.equal(clip.length, 2, 'Escape restores the length');
    assert.equal(changes(), 1);
    // wheel scrolling while dragging lengthens past the visible area
    point(cv, 'pointerdown', nx(70), ny(2), { buttons: 1 });
    point(cv, 'pointermove', nx(70), 300, { buttons: 1 });
    for (let i = 0; i < 40; i++) fire(cv, 'wheel', { clientX: nx(70), clientY: 300, deltaX: 0, deltaY: 100, deltaMode: 0 });
    point(cv, 'pointerup', nx(70), 300);
    assert.ok(clip.length > 300 / 48 + 5, `the wheel scrolled the end along (${clip.length})`);
    assert.equal(clip.length, Math.round(clip.length * 4) / 4, 'still snapped');
    // dragging past the bottom edge auto-scrolls and keeps lengthening
    roll.setView({ sy: 0 }); flush();
    clip.length = 4;
    roll.redraw(); flush();
    point(cv, 'pointerdown', nx(70), ny(4), { buttons: 1 });
    point(cv, 'pointermove', nx(70), 1000, { buttons: 1 });
    mock.timers.tick(3000); flush();
    point(cv, 'pointerup', nx(70), 1000);
    assert.ok(clip.length > 20, `edge auto-scroll lengthened the clip (${clip.length})`);
    mock.timers.tick(1000); // no interval left running
    // the end never runs into the next clip on the same TimeLine lane
    roll.setView({ sy: 0 }); flush();
    clip.length = 4;
    addClip(song, { start: clip.start + 6, length: 4, y: clip.y, target: 7 });
    roll.redraw(); flush();
    drag(cv, nx(70), ny(4), nx(70), ny(7.5));
    assert.equal(clip.length, 6, 'capped at the next clip');
    // a note crossing the end line keeps its own drag (resizing the note, not the clip)
    clip.notes.push(note(70, 5, 2));
    roll.redraw(); flush();
    drag(cv, nx(70), ny(6), nx(70), ny(7.5));
    assert.equal(clip.length, 6);
    assert.equal(clip.notes[0].length, 2.5);
  } finally {
    mock.timers.reset();
  }
}

// Shortening the clip with the view scrolled to its end: the view must not jump under the pointer
// (that shortened the clip again on every move); each move puts the end exactly at the pointer.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  clip.length = 32;
  roll.setView({ sy: 1e9 }); flush(); // clamped to the bottom of the scroll range
  const sy = roll.getView().sy;
  const yEnd = 32 * 48 - sy;
  assert.ok(yEnd > 0 && yEnd < 376, 'the end line is visible');
  point(cv, 'pointerdown', nx(70), yEnd, { buttons: 1 });
  for (let i = 1; i <= 4; i++) {
    point(cv, 'pointermove', nx(70), yEnd - i * 24, { buttons: 1 });
    point(cv, 'pointermove', nx(70), yEnd - i * 24, { buttons: 1 }); // the same spot again: no change
    assert.equal(roll.getView().sy, sy, `the view stays put (${i})`);
    assert.equal(clip.length, 32 - i / 2, `the end follows the pointer (${i})`);
  }
  point(cv, 'pointerup', nx(70), yEnd - 96);
  assert.equal(clip.length, 30);
  assert.equal(changes(), 1);
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
  // body drag adds the same duration to every selected note
  drag(cv, nx(61), ny(3.5), nx(61), ny(5.5));
  assert.deepEqual(clip.notes.map((n) => n.length), [3, 3, 1]);
  // Shift + click toggles a note in the selection
  click(cv, nx(70), ny(1) + 5, { shiftKey: true });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 0);
}

// Ctrl-click (Windows/Linux) and Cmd-click (macOS) toggle individual notes without editing.
for (const modifier of ['ctrlKey', 'metaKey']) {
  for (const part of ['head', 'body']) {
    const { clip, roll, changes, previews } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1), note(64, 2), note(67, 1));
    const before = JSON.stringify(clip.notes);
    const offset = part === 'head' ? 5 : 24;
    click(cv, nx(60), ny(1) + offset);
    click(cv, nx(64), ny(2) + offset, { [modifier]: true });
    assert.equal(changes(), 0, 'selection-only clicks create no musical edit');
    assert.equal(previews(), 0, 'selection leaves no sounding preview');
    assert.equal(JSON.stringify(clip.notes), before, 'modifier click never moves, resizes or bends a note');
    key(cv, 'ArrowRight');
    assert.deepEqual(clip.notes.map((n) => n.pitch), [61, 65, 67], `${modifier}: both notes are selected (${part})`);
    const afterMove = JSON.stringify(clip.notes);
    const edits = changes();
    click(cv, nx(61), ny(1) + offset, { [modifier]: true });
    assert.equal(JSON.stringify(clip.notes), afterMove, 'toggling off does not edit the note');
    assert.equal(changes(), edits, 'toggling off creates no undo edit');
    key(cv, 'Delete');
    assert.deepEqual(clip.notes.map((n) => n.pitch), [61, 67], `${modifier}: toggled-off note stays, selected note is deleted`);
  }
  {
    const { clip, roll, changes } = setup();
    const cv = roll.surface.cv;
    clip.notes.push(note(60, 1), note(64, 2));
    const before = JSON.stringify(clip.notes);
    // Rapid modifier clicks on a selected body must toggle, not insert bend points.
    click(cv, nx(60), ny(1) + 24, { [modifier]: true });
    click(cv, nx(60), ny(1) + 24, { [modifier]: true });
    key(cv, 'Delete');
    assert.equal(JSON.stringify(clip.notes), before, 'toggling the last selected note off clears selection');
    assert.equal(changes(), 0);
    click(cv, nx(60), ny(1) + 5);
    click(cv, nx(64), ny(2) + 5, { [modifier]: true });
    drag(cv, nx(60), ny(1) + 5, nx(61), ny(2) + 5);
    assert.deepEqual(clip.notes.map((n) => [n.pitch, n.start]), [[61, 2], [65, 3]],
      'ordinary dragging still moves the modifier-built selection together');
  }
}

// Released while still moving, Firefox (macOS) can end the capture with lostpointercapture instead
// of a pointerup: a drawn rectangle still selects; pointercancel restores the old selection.
for (const end of ['lostpointercapture', 'pointercancel']) {
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1), note(62, 2), note(70, 1));
  drag(cv, nx(59), ny(0.5), nx(63), ny(3.5), { button: 2, buttons: 2 }, end);
  point(cv, 'pointerup', nx(63), ny(3.5), { button: 2 });
  key(cv, 'Delete');
  assert.deepEqual(clip.notes.map((n) => n.pitch), end === 'pointercancel' ? [60, 62, 70] : [70], end);
}

// Micropitch: Shift + drag a circle sideways tunes it slowly (4 px per cent, 0.1 cent steps) and
// shows a slider; the note stays on its key (halves round up); Esc restores; the selection tunes along.
{
  const { clip, roll, ctx, changes, menus } = setup();
  const cv = roll.surface.cv;
  const bends = [];
  let playing = 0;
  ctx.preview = { on() { playing++; return { id: 1 }; }, bend(h, p) { bends.push(p); }, off(h) { if (h) playing--; } };
  const a = note(60, 1);
  const b = note(64, 1);
  const c = note(67, 3);
  clip.notes.push(a, b, c);
  // +10 cents
  point(cv, 'pointerdown', nx(60), ny(1) + 5, { buttons: 1, shiftKey: true });
  point(cv, 'pointermove', nx(60) + 40, ny(1) + 5, { buttons: 1, shiftKey: true });
  assert.equal(a.pitch, 60.1);
  assert.equal(playing, 1, 'the note sounds while it is tuned');
  assert.deepEqual(bends, [60.1], 'and glides along');
  assert.ok(cv.drawing.some(([op, t]) => op === 'fillText' && t === 'C4 +10 ct'), 'slider shows the key and cents');
  point(cv, 'pointermove', nx(60) + 2, ny(1) + 5, { buttons: 1, shiftKey: true });
  assert.equal(a.pitch, 60.005, 'fine: half a cent');
  point(cv, 'pointermove', nx(60) + 2000, ny(1) + 5, { buttons: 1, shiftKey: true });
  assert.equal(a.pitch, 60.499, 'up to +49.9 cents (+50 belongs to the next key)');
  point(cv, 'pointerup', nx(60) + 2000, ny(1) + 5, { shiftKey: true });
  assert.equal(playing, 0);
  assert.equal(changes(), 1);
  assert.equal(b.pitch, 64, 'other notes untouched');
  // the whole note shifts by the tuning: body and circle lean right together
  cv.drawing.length = 0;
  roll.redraw(); flush();
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'roundRect' && Math.abs(x - (nx(60) - 7.5 + 0.499 * 14)) < 1e-9 && y === ny(1)), 'body shifts with the tuning');
  assert.ok(cv.drawing.some(([op, x]) => op === 'translate' && Math.abs(x - (nx(60) + 0.499 * 14)) < 1e-9), 'circle leans by the tuning');
  // the circle is still grabbed where it is drawn; down to -50 cents
  drag(cv, nx(60) + 7, ny(1) + 5, nx(60) + 7 - 4000, ny(1) + 5, { shiftKey: true });
  assert.equal(a.pitch, 59.5, '-50 cents: still C4');
  assert.equal(changes(), 2);
  // Escape restores
  point(cv, 'pointerdown', nx(60) - 7, ny(1) + 5, { buttons: 1, shiftKey: true });
  point(cv, 'pointermove', nx(60) + 100, ny(1) + 5, { buttons: 1, shiftKey: true });
  assert.notEqual(a.pitch, 59.5);
  key(cv, 'Escape');
  assert.equal(a.pitch, 59.5, 'Escape restores the tuning');
  assert.equal(changes(), 2);
  // a selection tunes along, every note by the same cents, each kept on its key
  a.pitch = 60;
  key(cv, 'a', { ctrlKey: true });
  drag(cv, nx(64), ny(1) + 5, nx(64) - 80, ny(1) + 5, { shiftKey: true });
  assert.deepEqual([a.pitch, b.pitch, c.pitch], [59.8, 63.8, 66.8]);
  // transposing keeps the tuning; Reset tuning puts every selected note back on its key
  key(cv, 'ArrowRight');
  assert.deepEqual([a.pitch, b.pitch, c.pitch], [60.8, 64.8, 67.8]);
  holdRightClick(cv, nx(80), ny(6));
  pick(menus, 'Reset tuning');
  assert.deepEqual([a.pitch, b.pitch, c.pitch], [61, 65, 68]);
  // Shift + click (no drag) still toggles the note in the selection
  click(cv, nx(61), ny(1) + 5, { shiftKey: true });
  key(cv, 'Delete');
  assert.deepEqual(clip.notes.map((n) => n.pitch), [61]);
}

// Micropitch notes belong to the key their pitch rounds to (halves up), in the roll and on its keyboard.
{
  const { clip, roll, ctx } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(59.5, 1), note(59.49, 3));
  roll.redraw(); flush();
  // the bodies sit at their exact pitch (between the columns), the key still names and colours them
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'roundRect' && near(x, nx(59.5) - 7.5) && y === ny(1)), '59.5 drawn at its pitch');
  assert.ok(cv.drawing.some(([op, x, y]) => op === 'roundRect' && near(x, nx(59.49) - 7.5) && y === ny(3)), '59.49 drawn at its pitch');
  point(cv, 'pointermove', nx(59.5), ny(1.5));
  assert.match(cv.title, /^C4 /, '59.5 is C4');
  point(cv, 'pointermove', nx(59.49), ny(3.5));
  assert.match(cv.title, /^B3 /, '59.49 is B3');
  // held keys (MIDI) light their base key blue
  const keyFill = (p) => cv.drawing.findLast(([op, x, y]) => op === 'fillRect' && x === nx(p) - 7 + 0.5 && y > 300)?.[5];
  ctx.heldKeys = () => new Set([61.6]);
  roll.redraw(); flush();
  assert.equal(keyFill(62), '#65b4ff', 'a tuned held pitch lights its base key');
  assert.notEqual(keyFill(61), '#65b4ff');
  assert.ok(keyFill(61), 'key rect found');
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
  assert.ok(clip.notes.every((n) => Number.isInteger(n.start * 4) && Number.isInteger((n.start + n.length) * 4)), JSON.stringify(clip.notes));
  clip.notes.length = 0;
  drag(cv, nx(60), ny(4), nx(60), ny(6));
  assert.equal(clip.notes[0].length, 2);
  click(cv, nx(65), ny(0.5));
  assert.equal(clip.notes[1].length, 2);
}

// Quantize snaps each original edge to the Input Grid, including divided grids and Free timing.
for (const snap of [{ base: 16, div: 1 }, { base: 8, div: 3 }, { base: 4, div: 1, free: true }]) {
  const { song, clip, roll, changes } = setup();
  song.snap = snap;
  const st = snapStep(snap);
  clip.notes.push(
    note(60, st, st * 1.7), // aligned start, unaligned end
    note(62, st * 1.4, st * 1.3), // end must snap independently of the moved start
    note(64, st * 3.8, st * 0.1), // both edges round to the same point
    note(65, -st * 0.4, st * 0.5),
  );
  key(roll.surface.cv, 'q');
  const clean = v => Math.round(v * 1e9) / 1e9;
  assert.deepEqual(clip.notes.map(n => [n.start, n.length]), [
    [clean(st), clean(2 * st)], [clean(st), clean(2 * st)],
    [clean(4 * st), clean(st)], [0, clean(st)],
  ]);
  assert.equal(changes(), 1, 'quantizing all notes is one edit');
  key(roll.surface.cv, 'q');
  assert.equal(changes(), 1, 'already quantized notes do not create another edit');
}

// Context-menu quantize affects only the selection; velocity endpoints follow length changes.
{
  const { clip, roll, menus, changes } = setup();
  const a = note(60, 1, 0.43);
  a.vels = [{ t: 0.2, v: 0.5, r: 0 }, { t: 0.43, v: 0.2, r: 0.4 }];
  const b = note(64, 2, 0.32);
  b.vels = [{ t: 0.1, v: 0.6, r: 0 }, { t: 0.3, v: 0.4, r: 0 }, { t: 0.32, v: 0.1, r: 0 }];
  const untouched = note(67, 3.1, 0.37);
  clip.notes.push(a, b, untouched);
  click(roll.surface.cv, nx(60), ny(1) + 5);
  click(roll.surface.cv, nx(64), ny(2) + 5, { shiftKey: true });
  const before = changes();
  holdRightClick(roll.surface.cv, nx(80), ny(6));
  pick(menus, 'Quantize selection');
  assert.equal(changes(), before + 1, 'selected quantization is one edit');
  assert.equal(a.length, 0.5);
  assert.deepEqual(a.vels, [{ t: 0.2, v: 0.5, r: 0 }, { t: 0.5, v: 0.2, r: 0.4 }]);
  assert.equal(b.length, 0.25);
  assert.deepEqual(b.vels, [{ t: 0.1, v: 0.6, r: 0 }, { t: 0.25, v: 0.1, r: 0 }]);
  assert.deepEqual(untouched, note(67, 3.1, 0.37), 'unselected notes are unchanged');
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
  assert.equal(song.selected, clip.id, 'cutting selects the nearest remaining clip');
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

// Existing arranger move, edge resize, duplication and signature-row seek remain intact.
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
  click(cv, ax(5.37), 0.5 * CLIP_H);
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
  click(cv, ax(20), ay(200)); // empty: keeps the selection, the playhead stays
  assert.equal(song.selected, other.id);
  assert.equal(ctx.transport.pos, 10);
  click(cv, ax(11), ay(34)); // just this clip
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

// The ruler: a click leaves the play position; a double-click on the bar numbers inserts the restart
// point (snapped), dragging the marker moves it, right-click removes it.
{
  const { song, arranger, ctx, changes } = setup();
  const cv = arranger.surface.cv;
  const RY = 1.5 * CLIP_H; // bar number row
  ctx.transport.pos = 2.5;
  for (const playing of [false, true]) {
    ctx.transport.playing = playing;
    click(cv, ax(5.37), RY);
    assert.equal(ctx.transport.pos, 2.5, 'clicking bar numbers never seeks, stopped or playing');
  }
  ctx.transport.playing = false;
  drag(cv, ax(4.1), RY, ax(8.05), RY);
  assert.equal(song.restart, undefined, 'dragging the bar numbers makes nothing');
  arranger.setView({ sx: 0, ppq: 16 }); flush();
  assert.equal('loop' in song, false, 'there is no loop region');
  const c0 = changes();
  point(cv, 'dblclick', ax(4.1), RY);
  assert.equal(song.restart, 4, 'a double-click inserts the restart point (snapped)');
  assert.equal(changes(), c0 + 1, 'one undo step');
  point(cv, 'dblclick', ax(6.05), RY);
  assert.equal(song.restart, 8, 'another double-click rounds to the nearest barline');
  point(cv, 'dblclick', ax(5.9), RY);
  assert.equal(song.restart, 4, 'double-clicking within the existing restart label places the marker at the clicked barline');
  point(cv, 'dblclick', ax(8.1), RY);
  assert.equal(song.restart, 8);
  const sigEdits = [];
  ctx.editSig = (at) => sigEdits.push(at);
  point(cv, 'dblclick', ax(3), 8);
  assert.equal(song.restart, 8, 'the signature row double-click edits signatures instead');
  assert.equal(sigEdits.length, 1);
  const c1 = changes();
  const pos = ctx.transport.pos;
  drag(cv, ax(8), RY, ax(10.05), RY);
  assert.equal(song.restart, 12, 'drag the marker to the nearest barline');
  assert.equal(ctx.transport.pos, pos, 'moving the marker leaves the play position');
  assert.equal(changes(), c1 + 1, 'one undo step');
  drag(cv, ax(12), RY, ax(3), RY, {}, 'pointercancel');
  assert.equal(song.restart, 12, 'cancel puts it back');
  drag(cv, ax(12), RY, ax(-3), RY);
  assert.equal(song.restart, undefined, 'dropped at time zero it is removed');
  point(cv, 'dblclick', ax(8), RY);
  point(cv, 'pointerdown', ax(8), RY, { button: 2, buttons: 2 });
  point(cv, 'pointerup', ax(8), RY, { button: 2 });
  assert.equal(song.restart, undefined, 'right-click on the marker removes it');
  assert.equal(normalizeSong({ loop: { start: 0, end: 4 } }).loop, undefined, 'old loop regions are dropped');
}

// Restart markers follow meter changes, not even a coarse or triplet Input Grid.
for (const snap of [{ base: 1, div: 1 }, { base: 16, div: 3 }]) {
  const { song, arranger, ctx, menus } = setup();
  const cv = arranger.surface.cv;
  const y = 1.5 * CLIP_H;
  song.snap = snap;
  setSig(song, 4, 3, 4);
  setSig(song, 10, 5, 8);
  point(cv, 'dblclick', ax(6.6), y);
  assert.equal(song.restart, 7, 'placement follows 3/4 measures');
  drag(cv, ax(7), y, ax(11.9), y);
  assert.equal(song.restart, 12.5, 'dragging follows 5/8 measures');
  ctx.transport.pos = 7.3;
  point(cv, 'pointerdown', ax(1), ay(200), { button: 2, buttons: 2 });
  point(cv, 'pointerup', ax(1), ay(200), { button: 2 });
  pick(menus, 'Insert restart point at playhead');
  assert.equal(song.restart, 7, 'menu placement also ignores the Input Grid');
}

// The scrollbars below (time) and right (lanes) of the TimeLine pan it by track click or thumb drag.
{
  const { arranger } = setup();
  const cv = arranger.surface.cv;
  arranger.setView({ sx: 0, sy: 0 }); flush();
  const hy = 400 - 16; // bottom scrollbar (32 px high, the canvas is 480 x 400)
  click(cv, 440, hy);
  const later = arranger.getView().sx;
  assert.ok(later > 0, 'clicking the track toward the end scrolls toward later time');
  assert.equal(arranger.getView().sy, 0, 'the time scrollbar leaves the lanes alone');
  drag(cv, 440, hy, 80, hy);
  assert.ok(arranger.getView().sx < 0, 'dragging the thumb back scrolls before time zero');
  const vx = 480 - 16; // right scrollbar
  click(cv, vx, 360);
  assert.ok(arranger.getView().sy > 0, 'the lane scrollbar scrolls down even without clips down there');
  click(cv, vx, 2 * CLIP_H + 2);
  assert.ok(arranger.getView().sy < 0, 'and up into idea storage');
  const n = arranger.getView();
  click(cv, 470, 390); // the corner between the scrollbars does nothing
  assert.deepEqual(arranger.getView(), n);
}

// The camera can pan far horizontally and downward, but stops above at the idea label.
{
  const { arranger } = setup();
  const cv = arranger.surface.cv;
  const y = 400 - 16;
  click(cv, 300, y);
  const before = arranger.getView();
  const anchor = (300 - 70 + before.sx) / before.ppq;
  point(cv, 'pointerdown', 300, y, { buttons: 1 });
  point(cv, 'pointermove', 300, y - 48, { buttons: 1 });
  assert.ok(Math.abs(arranger.getView().ppq - before.ppq * 1.15) < 1e-9, 'scrollbar upward drag zooms in');
  assert.ok(Math.abs((300 - 70 + arranger.getView().sx) / arranger.getView().ppq - anchor) < 1e-9, 'scrollbar zoom anchors at the grab position');
  point(cv, 'pointermove', 330, y - 48, { buttons: 1 });
  assert.notEqual(arranger.getView().sx, before.sx, 'horizontal scrollbar movement remains active');
  key(cv, 'Escape');
  assert.deepEqual(arranger.getView(), before, 'Escape restores scrollbar zoom and scroll');
  point(cv, 'pointerup', 330, y - 48);
  drag(cv, 300, y, 300, y + 48);
  assert.ok(Math.abs(arranger.getView().ppq - before.ppq / 1.15) < 1e-9, 'scrollbar downward drag zooms out');
}

// The camera can pan far horizontally and downward, but stops above at the idea label.
{
  const { song, arranger } = setup();
  const cv = arranger.surface.cv;
  addClip(song, { start: 8, length: 4, y: 2 * 34 });
  for (const [sx, sy] of [[5000, 3000], [-4000, -200], [64 * 300, 34 * 200]]) {
    arranger.setView({ sx, sy }); flush();
    assert.deepEqual([arranger.getView().sx, arranger.getView().sy], [sx, sy], `view remains at ${sx}, ${sy}`);
  }
  // the scrollbars still work out there: the thumb sits at the far end, pressing the track
  // at the start brings the camera back toward the content
  click(cv, 80, 400 - 16);
  assert.ok(arranger.getView().sx < 64 * 300, 'time scrollbar pans back');
  click(cv, 480 - 16, 2 * CLIP_H + 2);
  assert.ok(arranger.getView().sy < 34 * 200, 'lane scrollbar pans back');
  const before = arranger.getView();
  arranger.setView({ sx: NaN, sy: Infinity }); flush();
  assert.deepEqual([arranger.getView().sx, arranger.getView().sy], [before.sx, before.sy], 'broken numbers are ignored');
  arranger.setView({ sx: 1e12, sy: -1e12 }); flush();
  assert.deepEqual([arranger.getView().sx, arranger.getView().sy], [1e7, 2 * CLIP_H - 374], 'upward limit keeps the idea label visible');
}

// Every way of moving the camera respects the visible bottom edge of the idea label.
{
  const { song, arranger, arrangerHost } = setup();
  const cv = arranger.surface.cv;
  const label = 'Playback of clips in this area is ignored except if you loop the clip.';
  const checkLimit = (message) => {
    cv.drawing.length = 0;
    arranger.redraw(); flush();
    const text = cv.drawing.findLast(([op, value]) => op === 'fillText' && value === label);
    assert.ok(text, `${message}: label is drawn`);
    assert.equal(text[3], arrangerHost.clientHeight - 32, `${message}: label stays above the scrollbar`);
    assert.equal(arranger.getView().sy, 2 * CLIP_H - (arrangerHost.clientHeight - 32 + 6), `${message}: exact pan limit`);
  };
  arranger.setView({ sy: -1e7 }); flush();
  checkLimit('restored view');
  arranger.setView({ sy: 0 }); flush();
  fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaY: -100000, deltaMode: 0, shiftKey: true });
  checkLimit('wheel');
  arranger.setView({ sy: 0 }); flush();
  drag(cv, 200, 150, 200, 5000, { button: 1 });
  checkLimit('middle drag');
  arranger.setView({ sy: 0 }); flush();
  drag(cv, 200, 150, 200, 5000, { shiftKey: true });
  checkLimit('Shift + empty-space drag');
  arranger.setView({ sy: 0 }); flush();
  click(cv, 464, 2 * CLIP_H + 2);
  checkLimit('scrollbar');
  arrangerHost.clientHeight = 200;
  arrangerHost.resize(); flush();
  checkLimit('resize');
  arrangerHost.clientHeight = 0;
  arrangerHost.resize(); flush();
  arranger.setView({ sy: -5000 });
  arrangerHost.clientHeight = 300;
  arrangerHost.resize(); flush();
  checkLimit('restore while collapsed');
  arranger.setView({ sy: 0 }); flush();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    point(cv, 'pointerdown', 200, 150, { buttons: 1 });
    point(cv, 'pointermove', 200, 0, { buttons: 1 });
    mock.timers.tick(5000); flush();
    checkLimit('selection auto-scroll');
    point(cv, 'pointerup', 200, 0);
  } finally {
    mock.timers.reset();
  }
  const deepIdea = addClip(song, { start: 5, length: 4, y: -5000 });
  arranger.reveal(deepIdea.id); flush();
  checkLimit('reveal an existing deep idea');
  assert.equal(deepIdea.y, -5000, 'old ideas outside the limit are not modified');
  assert.equal(song.clips.length, 2, 'limiting the camera does not remove clips');
}

// Idea storage above the first lane: clips go there freely (no snapping, overlaps allowed) and
// snap again when dragged back onto a lane.
{
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const other = addClip(song, { start: 8, length: 4, y: 0, target: 7 });
  arranger.setView({ sx: 0, sy: -136, ppq: 16 }); flush();
  const top = 2 * CLIP_H + 136; // local y of the first lane
  const texts = () => cv.drawing.filter(([op]) => op === 'fillText').map(([, t]) => t);
  // the label text is free to change: find it by where it is drawn (time area, above lane 1)
  const ideaLabel = cv.drawing.findLast(([op, t, x, y]) => op === 'fillText' && x > 70 && y === top - 6 && t !== 'Ideas')?.[1];
  assert.ok(ideaLabel && texts().includes('Ideas'), 'the area is labelled');
  const labelY = (t) => cv.drawing.findLast(([op, text]) => op === 'fillText' && text === t)[3];
  assert.equal(labelY(ideaLabel), top - 6, 'just above the first lane');
  assert.equal(labelY('Ideas'), top - 6, 'beside it in the lane column');
  drag(cv, ax(1), top + 17, ax(3) + 5, top - 74);
  assert.deepEqual([clip.start, clip.y], [2.3125, -91], 'dropped exactly where released');
  drag(cv, ax(9), top + 17, ax(3) + 5, top - 74);
  assert.deepEqual([other.start, other.y], [2.3125, -91], 'ideas may overlap');
  const ideaMid = top - 91 + 17;
  drag(cv, ax(3.3125), ideaMid, ax(3.3125), ideaMid + 70); // its middle still above the first lane
  const lifted = other; // the later clip is on top
  assert.deepEqual([lifted.start, lifted.y], [2.3125, -34], 'an idea lies wholly above the first lane');
  assert.equal(clip.y, -91);
  drag(cv, ax(lifted.start + 1), top - 17, ax(lifted.start + 1), top + 34 + 17);
  assert.deepEqual([lifted.start, lifted.y], [2.25, 34], 'back on a lane it snaps to the (16th) grid and the lane');
  // double-click in idea storage inserts an idea right there
  point(cv, 'dblclick', ax(20) + 3, top - 94);
  const made = song.clips.at(-1);
  assert.deepEqual([made.start, made.y], [20.1875, -94 - 17], 'centred on the pointer, unsnapped');
  // paste into idea storage: the copies stay ideas
  arranger.setView({ sx: 0, sy: -136, ppq: 16 }); flush();
  click(cv, ax(lifted.start + 1), top + 34 + 17);
  key(cv, 'c', { ctrlKey: true });
  point(cv, 'pointermove', ax(15), top - 114);
  key(cv, 'v', { ctrlKey: true });
  const pasted = song.clips.at(-1);
  assert.ok(pasted.y < 0 && pasted.start === 15, `pasted as an idea (${pasted.start}, ${pasted.y})`);
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

// The wheel / trackpad scrolls the piano roll by its own pixel distance (no snap steps); sideways
// deltas pan the keys when zoomed in on pitch.
{
  const { roll } = setup();
  const cv = roll.surface.cv;
  roll.setView({ sy: 0 }); flush();
  const wheel = (deltaY, deltaMode = 0, deltaX = 0) => { fire(cv, 'wheel', { clientX: 200, clientY: 100, deltaX, deltaY, deltaMode }); flush(); };
  wheel(3);
  assert.equal(roll.getView().sy, 3, 'a small trackpad delta scrolls just that far');
  wheel(100);
  assert.equal(roll.getView().sy, 103, 'a mouse wheel click scrolls its pixel distance');
  wheel(-2, 1);
  assert.equal(roll.getView().sy, 71, 'line deltas are 16 px each');
  wheel(0, 0, 40);
  assert.equal(roll.getView().sy, 71, 'a sideways delta without pitch zoom leaves time alone');
  assert.equal(roll.getView().hx ?? 0, 0);
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
  click(cv, 33, sy(0));
  clip.y = -50; // an idea: silent in the song, but that is not a muted lane
  rc.drawing.length = 0;
  roll.redraw(); flush();
  assert.ok(!rc.drawing.some((op) => op[0] === 'fill' && op[1] === '#000'), 'an idea shows no M');
  clip.y = 0;
  click(cv, 33, sy(0));
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
  assert.ok(Math.abs(x - (LEFT + (rollHost.clientWidth - ROLL_SB - LEFT) / 2)) < 1, 'centred horizontally');
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
    arranger.setView({ sx: after + 64 }); flush(); // the clip went under the scrollbar with the pointer
    const shown = arranger.getView().sx;
    const cx = 70 + (clip.start + 1) * 16 - shown; // grab the clip where it now is
    assert.ok(cx > 70 && cx < 480 - 32);
    point(cv, 'pointerdown', cx, ay(0), { buttons: 1 }); // and leftwards
    point(cv, 'pointermove', 72, ay(0), { buttons: 1 });
    mock.timers.tick(300); flush();
    assert.ok(arranger.getView().sx < shown, 'the view scrolls back left');
    point(cv, 'pointerup', 72, ay(0));
  } finally {
    mock.timers.reset();
  }
}

// A selection rectangle consolidates MIDI clips across lanes, but not automation.
{
  const { song, clip, arranger, menus, ctx } = setup();
  clip.length = 4;
  clip.target = 12;
  clip.notes.push(note(60, 1));
  const lower = addClip(song, { start: 6, length: 2, y: 34, target: 9 });
  lower.notes.push(note(64, 0.5));
  const auto = addAutoClip(song, { start: 0, length: 2, y: 68 });
  const secondAuto = addAutoClip(song, { start: 6, length: 2, y: 68 });
  const cv = arranger.surface.cv;
  drag(cv, ax(9), ay(68) + 14, ax(0) + 2, ay(68) - 14);
  holdRightClick(cv, ax(1), ay(68));
  assert.ok(menus.at(-1).items.find(i => i.label === 'Consolidate').disabled, 'automation-only rectangle is disabled');
  drag(cv, ax(9), ay(68) + 14, ax(0) + 2, 39);
  holdRightClick(cv, ax(1), ay(0));
  assert.ok(menus.at(-1).items.find(i => i.label === 'Consolidate').disabled, 'mixed rectangle is disabled');
  drag(cv, ax(9), ay(34) + 14, ax(0) + 2, 39);
  holdRightClick(cv, ax(1), ay(0));
  pick(menus, 'Consolidate');
  const merged = ctx.clip();
  assert.equal(merged.target, 12);
  assert.deepEqual(merged.notes.map(n => [n.pitch, n.start]), [[60, 1], [64, 6.5]]);
  assert.ok(song.clips.includes(auto) && song.clips.includes(secondAuto));
}

// Individual selection order, not creation or time order, supplies the destination.
{
  const { song, clip, arranger, menus, ctx } = setup();
  clip.length = 4;
  clip.target = 12;
  const first = addClip(song, { start: 6, length: 2, y: 34, target: 9 });
  const cv = arranger.surface.cv;
  click(cv, ax(7), ay(34));
  click(cv, ax(1), ay(0), { ctrlKey: true });
  holdRightClick(cv, ax(1), ay(0));
  pick(menus, 'Consolidate');
  assert.equal(ctx.clip().target, first.target, 'first selected destination wins even after right-clicking another selected clip');
  assert.equal(ctx.clip().y, 34);
}

// Context menu: Consolidate selected MIDI clips across lanes, Split at the playhead; the signature
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
  assert.ok(!menus.at(-1).items.find((i) => i.label === 'Consolidate').disabled, 'MIDI clips on different lanes are enabled');
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

// Context menu: Save Clip(s)… hands the selected clips to ctx.saveClips; Load Clip… on empty
// space places the opened clips at the pointer with fresh ids.
{
  const { song, clip, arranger, ctx, menus } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  clip.notes.push(note(60, 1));
  const b = addClip(song, { start: 6, length: 2, target: 9 });
  let saved = null;
  ctx.saveClips = (clips) => { saved = clips; };
  holdRightClick(cv, ax(1), ay(0));
  pick(menus, 'Save Clip…');
  assert.deepEqual(saved, [clip]);
  click(cv, ax(7), ay(0), { ctrlKey: true });
  holdRightClick(cv, ax(7), ay(0));
  pick(menus, 'Save Clips…');
  assert.deepEqual(saved.map((c) => c.id).sort(), [clip.id, b.id].sort());

  const loaded = parseClipFile(clipFileText([clip, b]));
  ctx.openClips = async () => structuredClone(loaded);
  holdRightClick(cv, ax(12.1), ay(68));
  assert.ok(labels(menus).includes('Load Clip…'));
  pick(menus, 'Load Clip…');
  await new Promise((r) => setImmediate(r));
  assert.equal(song.clips.length, 4);
  const [l1, l2] = song.clips.slice(2);
  assert.deepEqual([l1.start, l1.y, l1.length, l1.target], [12, 68, 4, 7]);
  assert.deepEqual([l2.start, l2.y, l2.length, l2.target], [18, 68, 2, 9]);
  assert.deepEqual(l1.notes, clip.notes);
  assert.notEqual(l1.notes, clip.notes);
  assert.equal(new Set(song.clips.map((c) => c.id)).size, 4);
  assertNoOverlap(song);
}

// MIDI tracks import together without overlapping occupied lanes.
{
  const { song, clip, arranger, ctx, menus, changes } = setup();
  const cv = arranger.surface.cv;
  clip.length = 16;
  addClip(song, { start: 4, y: 34, length: 8 });
  let version = 0;
  let completed = null;
  let cancelled = 0;
  ctx.layerVersion = () => version;
  ctx.midiImported = (result) => { completed = result; };
  ctx.midiImportCancelled = () => { cancelled++; };
  const tracks = [
    { name: 'one', start: 0, y: 0, length: 4, target: null, notes: [note(60, 0.5)] },
    { name: 'two', start: 0, y: 34, length: 8, target: null, notes: [] },
  ];
  ctx.openMidi = async () => ({ clips: tracks, name: 'test.mid', warnings: 0 });
  holdRightClick(cv, ax(5), ay(0));
  assert.ok(labels(menus).includes('Import MIDI…'), 'import is available on clips');
  const before = changes();
  pick(menus, 'Import MIDI…');
  await new Promise((r) => setImmediate(r));
  const imported = song.clips.slice(2);
  assert.deepEqual(imported.map((c) => [c.start, c.y, c.target]), [[5, 68, null], [5, 102, null]]);
  assert.deepEqual(imported[0].notes, tracks[0].notes);
  assert.equal(changes(), before + 1, 'one edit for all tracks');
  assert.equal(completed.name, 'test.mid');
  assertNoOverlap(song);

  let resolve;
  ctx.openMidi = () => new Promise((r) => { resolve = r; });
  holdRightClick(cv, ax(20), ay(0));
  pick(menus, 'Import MIDI…');
  version++;
  resolve({ clips: tracks });
  await new Promise((r) => setImmediate(r));
  assert.equal(song.clips.length, 4, 'layer changes cancel in-flight import');
  assert.equal(cancelled, 1);
  ctx.openMidi = async () => null;
  holdRightClick(cv, ax(18), ay(0));
  pick(menus, 'Import MIDI…');
  await new Promise((r) => setImmediate(r));
  assert.equal(song.clips.length, 4, 'cancelling does not change song');
}

{
  const { song, arranger, ctx, menus } = setup();
  arranger.setView({ sx: 0, sy: -136, ppq: 16 });
  flush();
  ctx.openMidi = async () => ({ clips: [
    { name: 'one', length: 1, notes: [], target: null },
    { name: 'two', length: 1, notes: [], target: null },
    { name: 'three', length: 1, notes: [], target: null },
  ] });
  holdRightClick(arranger.surface.cv, ax(20) + 3, 80);
  pick(menus, 'Import MIDI…');
  await new Promise((r) => setImmediate(r));
  const clips = song.clips.slice(1);
  assert.deepEqual(clips.map((c) => c.start), [20.1875, 20.1875, 20.1875]);
  assert.ok(clips.every((c) => c.y <= -34), 'all imported tracks remain in idea storage');
  assert.deepEqual(clips.map((c) => c.y), [80 - 2 * CLIP_H - 136 - 17, 80 - 2 * CLIP_H - 136 + 17, 80 - 2 * CLIP_H - 136 + 51]);
}

{
  const { song, arranger, ctx, menus, changes } = setup();
  const noteClip = { name: 'Track', start: 0, y: 0, length: 4, target: null, notes: [note(60, 0)] };
  const tempoClip = { name: 'MIDI Tempo', kind: 'auto', target: 0, controller: 0, length: 4,
    notes: [], points: [{ t: 0, v: 0.1, r: 0 }, { t: 2, v: 0.1, r: 0 }, { t: 2, v: 0.2, r: 0 }] };
  ctx.openMidi = async () => ({ clips: [noteClip], tempoClip });
  holdRightClick(arranger.surface.cv, ax(10), ay(68));
  pick(menus, 'Import MIDI…');
  await new Promise((r) => setImmediate(r));
  const [imported, tempo] = song.clips.slice(1);
  assert.equal(imported.start, tempo.start, 'tempo and notes start together');
  assert.equal(tempo.y, imported.y + 34);
  assert.deepEqual(tempo.points, tempoClip.points);
  assert.equal(tempo.target, 0);
  assert.equal(tempo.kind, 'auto');
  assert.equal(changes(), 1, 'tracks and tempo are one edit');
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
  point(acv, 'pointermove', 210, 2 * CLIP_H + 97);
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

// TimeLine: Shift + drag on empty space pans; a plain drag selects clips for group move and delete.
{
  const { song, clip, arranger, ctx, changes } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const b = addClip(song, { start: 6, length: 4 });
  const c = addClip(song, { start: 20, length: 4 });
  const view = { ...arranger.getView() };
  let viewChanges = 0;
  ctx.viewChanged = () => viewChanges++;
  drag(cv, ax(0.5), ay(60), ax(7), ay(0), { shiftKey: true });
  assert.deepEqual([arranger.getView().sx, arranger.getView().sy], [view.sx - (ax(7) - ax(0.5)), view.sy + 60], 'Shift + drag pans');
  assert.equal(song.selected, clip.id, 'and keeps the selection');
  assert.ok(viewChanges > 0, 'panning saves the view');
  assert.equal(changes(), 0, 'panning does not edit the song');
  arranger.setView({ sx: view.sx, sy: view.sy }); flush();
  drag(cv, ax(0.5), ay(60), ax(7), ay(0));
  assert.deepEqual([arranger.getView().sx, arranger.getView().sy], [view.sx, view.sy], 'plain selection drag does not pan');
  point(cv, 'pointerdown', ax(1), ay(0), { buttons: 1 });
  point(cv, 'pointermove', ax(3), ay(0), { buttons: 1 });
  point(cv, 'pointerup', ax(3), ay(0));
  assert.deepEqual([clip.start, b.start, c.start], [2, 8, 20]);
  assertNoOverlap(song);
  key(cv, 'Delete');
  assert.deepEqual(song.clips, [c]);
}

// Ctrl/Cmd + empty-space drag adds clips; cancelling a plain rectangle restores the selection.
for (const modifier of ['ctrlKey', 'metaKey']) {
  for (const cancelled of [false, true]) {
    const { song, clip, arranger } = setup();
    const cv = arranger.surface.cv;
    clip.length = 4;
    const b = addClip(song, { start: 6, length: 4 });
    const c = addClip(song, { start: 20, length: 4 });
    drag(cv, ax(5), ay(60), ax(11), ay(0), cancelled ? {} : { [modifier]: true }, cancelled ? 'pointercancel' : 'pointerup');
    key(cv, 'Delete');
    assert.deepEqual(song.clips, cancelled ? [b, c] : [c], cancelled ? 'cancel restores selection' : 'modifier adds to selection');
  }
}

// Ctrl/Cmd + click toggles; Alt + drag copies keep the name (no " copy" suffix).
for (const onClip of [false, true]) {
  const { song, clip, arranger, changes } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const b = addClip(song, { start: 6, length: 4 });
  const c = addClip(song, { start: 20, length: 4 });
  const before = structuredClone(song.clips);
  const view = { ...arranger.getView() };
  drag(cv, ax(0.5), ay(onClip ? 5 : 60), ax(7), ay(onClip ? 20 : 0), { button: 4, buttons: 16 });
  assert.deepEqual(song.clips, before, 'Forward selection never moves clips');
  assert.deepEqual([arranger.getView().sx, arranger.getView().sy], [view.sx, view.sy], 'Forward selection does not pan');
  assert.equal(changes(), 0, 'selection does not edit song data');
  key(cv, 'Delete');
  assert.deepEqual(song.clips, [c], 'Forward-drag selects both intersected clips');
  assert.ok(!song.clips.includes(b));
}

for (const cancelled of [false, true]) {
  const { song, clip, arranger } = setup();
  const cv = arranger.surface.cv;
  clip.length = 4;
  const b = addClip(song, { start: 6, length: 4 });
  const c = addClip(song, { start: 20, length: 4 });
  point(cv, 'pointerdown', ax(5), ay(5), { button: 4, buttons: 16, ctrlKey: true });
  point(cv, 'pointermove', ax(11), ay(20), { button: -1, buttons: 16, ctrlKey: true });
  point(cv, cancelled ? 'pointercancel' : 'pointerup', ax(11), ay(20), { button: 4, buttons: 0, ctrlKey: true });
  key(cv, 'Delete');
  assert.deepEqual(song.clips, cancelled ? [b, c] : [c], cancelled
    ? 'cancelled Forward selection keeps the original selection'
    : 'Ctrl + Forward selection adds to the original selection');
}

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
  assert.equal(arranger.getView().sx, -100 * 16, 'and on, far before the earliest clip (free camera)');
  arranger.setView({ sx: -12 * 16, sy: 0, ppq: 16 });
  flush();
  const texts = cv.drawing.filter(([op]) => op === 'fillText').map(([, t]) => t);
  assert.ok(texts.includes('1') && texts.includes('2') && texts.includes('3'), 'lane numbers');
  assert.ok(texts.includes('Idea Storage'));
  assert.ok(texts.includes('-2') && texts.includes('0'), 'bars before zero are numbered 0, -1, -2, ...');
  // double-click inserts on the lane under the pointer
  arranger.setView({ sx: 0, sy: 0, ppq: 16 });
  flush();
  point(cv, 'dblclick', ax(8), 2 * CLIP_H + CLIP_H * 2 + 3);
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

// Velocity strip: start handles move whole curves; point edits leave starts untouched.
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
  // Start handles move every selected note, even with Alt.
  key(cv, 'a', { ctrlKey: true });
  drag(cv, vx(0.3), ny(0), vx(0.5), ny(0), { altKey: true });
  assert.equal(b.vel, 0.5, 'all selected starts take the dragged value');
  assert.ok(Math.abs(a.vel - 0.5) < 1e-9);
  // double-click inside the selection adds a point at the snapped time; drag it to 1
  dbl(cv, vx(0.5), ny(3.05));
  assert.deepEqual(b.vels?.map((p) => p.t), [1], 'point offset is relative to each note start');
  assert.deepEqual(a.vels?.map((p) => p.t), [1], 'point is created for the first selected note too');
  assert.equal(b.vels[0].r, 0.5, 'new points start half rounded');
  drag(cv, vx(b.vels[0].v), ny(3), vx(1), ny(3), { altKey: true });
  assert.equal(b.vels[0].v, 1);
  assert.equal(b.vel, 0.5, 'point edit leaves the second note start unchanged');
  assert.equal(a.vels[0].v, 0.5, 'point at another timeline time stays unchanged');
  // Moving the point in time moves each corresponding point by the same offset.
  drag(cv, vx(1), ny(3), vx(1), ny(2.5));
  assert.equal(a.vel, 0.5);
  assert.deepEqual(a.vels?.map((p) => p.t), [1]);
  assert.deepEqual(b.vels?.map((p) => p.t), [0.5]);
  assert.equal(b.vel, 0.5, 'moving points never changes start velocity');
  // wheel rounds the point; right click offers deletion without deleting immediately
  point(cv, 'wheel', vx(1), ny(2.5), { deltaY: -100 });
  assert.equal(b.vels[0].r, 0.55);
  b.vels[0].r = 1;
  point(cv, 'wheel', vx(1), ny(2.5), { deltaY: -100 });
  assert.equal(b.vels[0].r, 1, 'already at maximum rounding');
  point(cv, 'wheel', vx(1), ny(2.5), { deltaY: 100 });
  assert.equal(b.vels[0].r, 0.95);
  holdRightClick(cv, vx(1), ny(2.5));
  assert.ok(b.vels, 'releasing after the menu opened does not delete');
  assert.ok(b.vels);
  pick(menus, 'Delete point');
  assert.equal('vels' in b, false);
  assert.deepEqual(a.vels, [{ t: 1, v: 0.5, r: 0.5 }], 'deleting a point does not remove a different-time point');
  assert.ok(changes() > 4);
}

// Dragging an existing point creates missing counterparts immediately, not a shared curve.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 4, 0.4);
  const b = note(64, 1.5, 2, 0.3);
  const other = note(67, 10, 2, 0.9);
  a.vels = [{ t: 1, v: 0.6, r: 0.2 }, { t: 3, v: 0.7, r: 0.8 }];
  other.vels = [{ t: 1, v: 0.8, r: 0.1 }];
  clip.notes.push(a, b, other);
  click(cv, vx(a.vel), ny(a.start));
  click(cv, vx(b.vel), ny(b.start), { shiftKey: true });
  const original = structuredClone(clip.notes);
  const count = changes();
  point(cv, 'pointerdown', vx(0.6), ny(2), { buttons: 1 });
  assert.deepEqual(b.vels, [{ t: 0.5, v: 0.3, r: 0.2 }], 'missing point appears at the same absolute time, preserving the other curve value');
  point(cv, 'pointermove', vx(0.8), ny(2.5), { buttons: 1 });
  assert.deepEqual([a.vel, b.vel], [0.4, 0.3], 'starts stay independent');
  assert.deepEqual(a.vels, [{ t: 1.5, v: 0.8, r: 0.2 }, { t: 3, v: 0.7, r: 0.8 }], 'other points are untouched');
  assert.deepEqual(b.vels, [{ t: 1, v: 0.5, r: 0.2 }], 'corresponding point stays at the same timeline time');
  assert.deepEqual(other, original[2], 'unselected note is never modified');
  point(cv, 'pointercancel', vx(0.8), ny(2.5));
  assert.deepEqual(clip.notes, original, 'cancel removes auto-created points and restores edited ones');
  assert.equal(changes(), count, 'cancel creates no undo step');
  drag(cv, vx(0.6), ny(2), vx(0.8), ny(2.5));
  assert.equal(changes(), count + 1, 'point creation and drag commit as one edit');
  point(cv, 'wheel', vx(0.8), ny(2.5), { deltaY: -100 });
  assert.deepEqual([a.vels[0].r, b.vels[0].r], [0.25, 0.25]);
  assert.deepEqual([a.vel, b.vel], [0.4, 0.3], 'rounding never edits starts');
  // Select only the first note: neither the second note nor its point follows now.
  click(cv, nx(60), ny(1) + 5);
  const bBefore = structuredClone(b);
  drag(cv, vx(0.8), ny(2.5), vx(0.6), ny(2));
  assert.deepEqual(b, bBefore, 'single-note selection edits only that note');
  const pointsBefore = structuredClone(a.vels);
  drag(cv, vx(a.vel), ny(1), vx(0.5), ny(1));
  assert.equal(a.vel, 0.5);
  assert.deepEqual(a.vels, pointsBefore.map(p => ({ ...p, v: +(p.v + 0.1).toFixed(9) })), 'single start handle moves its entire curve');
}

// Existing coincident points move together even with different note starts and values.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 5, 0.4);
  const b = note(64, 2, 5, 0.3);
  a.vels = [{ t: 2, v: 0.6, r: 0.2 }];
  b.vels = [{ t: 1, v: 0.4, r: 0.3 }, { t: 2, v: 0.8, r: 0.5 }];
  clip.notes.push(a, b);
  key(cv, 'a', { ctrlKey: true });
  drag(cv, vx(0.6), ny(3), vx(0.8), ny(3.5));
  assert.deepEqual(a.vels, [{ t: 2.5, v: 0.8, r: 0.2 }]);
  assert.deepEqual(b.vels, [{ t: 1.5, v: 0.6, r: 0.3 }, { t: 2, v: 0.8, r: 0.5 }], 'same-time point moves, not the different-time point with matching relative offset');
  assert.deepEqual([a.vel, b.vel], [0.4, 0.3]);
}

// Point bounds clamp individually; differences recover within a drag, then commit on release.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const notes = [note(60, 1, 3, 0.4), note(64, 1, 3, 0.5), note(67, 1, 3, 0.6)];
  notes.forEach((n, i) => { n.vels = [{ t: 1, v: [0.2, 0.5, 0.8][i], r: 0.3 }]; });
  clip.notes.push(...notes);
  key(cv, 'a', { ctrlKey: true });
  const values = () => notes.map(n => n.vels[0].v);
  const count = changes();
  point(cv, 'pointerdown', vx(0.5), ny(2), { buttons: 1 });
  point(cv, 'pointermove', vx(0.9), ny(2), { buttons: 1 });
  assert.deepEqual(values(), [0.6, 0.9, 1], 'one point at the limit does not block the others');
  point(cv, 'pointermove', vx(1.4), ny(2), { buttons: 1 });
  assert.deepEqual(values(), [1, 1, 1], 'dragging beyond the edge flattens all points');
  point(cv, 'pointermove', vx(0.5), ny(2), { buttons: 1 });
  assert.deepEqual(values(), [0.2, 0.5, 0.8], 'moving back restores original differences before release');
  point(cv, 'pointermove', vx(1.4), ny(2), { buttons: 1 });
  point(cv, 'pointerup', vx(1.4), ny(2));
  assert.deepEqual(values(), [1, 1, 1]);
  assert.equal(changes(), count + 1);
  drag(cv, vx(1), ny(2), vx(0.6), ny(2));
  assert.deepEqual(values(), [0.6, 0.6, 0.6], 'after release the committed equal values move together');
  drag(cv, vx(0.6), ny(2), vx(-0.1), ny(2));
  assert.deepEqual(values(), [0, 0, 0], 'minimum also clamps each point');
  assert.deepEqual(notes.map(n => n.vel), [0.4, 0.5, 0.6], 'start velocities are unaffected');
}

// Double-click insertion and immediate drag form one cancellable multi-note edit.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 4, 0.4);
  const b = note(64, 6, 1, 0.3);
  clip.notes.push(a, b);
  key(cv, 'a', { ctrlKey: true });
  const original = structuredClone(clip.notes);
  const count = changes();
  point(cv, 'pointerdown', vx(0.7), ny(3), { buttons: 1 });
  point(cv, 'pointerup', vx(0.7), ny(3));
  point(cv, 'pointerdown', vx(0.7), ny(3), { buttons: 1 });
  assert.deepEqual(a.vels, [{ t: 2, v: 0.7, r: 0.5 }]);
  assert.deepEqual(b.vels, [{ t: 1, v: 0.7, r: 0.5 }], 'short notes get a point at their end');
  point(cv, 'pointermove', vx(0.8), ny(3), { buttons: 1 });
  point(cv, 'pointercancel', vx(0.8), ny(3));
  assert.deepEqual(clip.notes, original);
  assert.equal(changes(), count);
  dbl(cv, vx(0.7), ny(3));
  assert.equal(changes(), count + 1, 'double-click inserts all points in one undo step');
  assert.deepEqual([a.vel, b.vel], [0.4, 0.3]);
}

// Velocity strip: Ctrl+drag draws a dashed line; on release the velocities under it snap onto it
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 0, 1, 0.5);
  const b = note(62, 2, 2, 0.5);
  const c = note(64, 6, 1, 0.5);
  b.vels = [{ t: 1, v: 0.5, r: 0 }];
  clip.notes.push(a, b, c);
  flush();
  const c0 = changes();
  point(cv, 'pointerdown', vx(0), ny(0), { buttons: 1, ctrlKey: true });
  point(cv, 'pointermove', vx(1), ny(4), { buttons: 1, ctrlKey: true });
  cv.drawing.length = 0;
  roll.redraw?.();
  flush();
  assert.equal(a.vel, 0.5, 'nothing changes while drawing');
  assert.ok(cv.drawing.some(([op, dash]) => op === 'setLineDash' && dash?.join() === '5,4'), 'the line is dashed');
  point(cv, 'pointerup', vx(1), ny(4), { ctrlKey: true });
  assert.ok(Math.abs(a.vel) < 1e-6, `start of the line: ${a.vel}`);
  assert.ok(Math.abs(b.vel - 0.5) < 1e-6, `half way: ${b.vel}`);
  assert.ok(Math.abs(b.vels[0].v - 0.75) < 1e-6, `curve point at t=3: ${b.vels[0].v}`);
  assert.equal(c.vel, 0.5, 'beyond the line: untouched');
  assert.ok(changes() > c0);
  // with a selection only the selected notes snap
  key(cv, 'a', { ctrlKey: true });
  key(cv, 'Escape');
  click(cv, vx(c.vel), ny(6));
  const before = a.vel;
  drag(cv, vx(1), ny(0), vx(1), ny(7), { ctrlKey: true });
  assert.equal(a.vel, before, 'unselected note untouched');
  assert.ok(Math.abs(c.vel - 1) < 1e-6, `selected note snapped: ${c.vel}`);
}

// Pitch bend: double-click a selected note's body inserts a bend point that drags at once; points
// snap pitch and time (Shift frees pitch, Free timing frees time), the body follows the curve, wheel rounds,
// right-click deletes, the menu resets; tuned notes shift whole (body included).
for (const free of [false, true]) {
  for (const shiftKey of [false, true]) {
    const { song, clip, roll } = setup();
    const cv = roll.surface.cv;
    song.snap.free = free;
    const n = note(60.25, 0.13, 4);
    n.bends = [{ t: 0.87, d: 0, r: 0.4 }];
    clip.notes.push(n);
    key(cv, 'a', { ctrlKey: true });
    flush();
    drag(cv, nx(60.25), ny(1), nx(61.4), ny(1.37), { shiftKey });
    assert.ok(Math.abs(n.pitch + n.bends[0].d - (shiftKey ? 61.4 : 61)) < 1e-8,
      'pitch snapping is absolute even for a microtuned note');
    assert.ok(Math.abs(n.start + n.bends[0].t - (free ? 1.37 : 1.25)) < 1e-8,
      'time snaps to the roll grid, not relative to an off-grid note start');
    assert.equal(n.bends[0].r, 0.4, 'editing preserves corner rounding');
  }
}

{
  const { song, clip, roll, changes, menus, previews } = setup();
  const cv = roll.surface.cv;
  const n = note(60, 0, 4);
  clip.notes.push(n);
  flush();
  dbl(cv, nx(60), ny(2)); // first press selects, the second inserts
  assert.deepEqual(n.bends, [{ t: 2, d: 0, r: 0.5 }], 'inserted at the pointer\'s time, the pitch under the pointer, half rounded');
  assert.equal(n.length, 4, 'the double-click did not resize the note');
  const c0 = changes();
  drag(cv, nx(60), ny(2), nx(62) + 7, ny(2.5));
  assert.equal(n.bends[0].t, 2.5);
  assert.equal(n.bends[0].d, 3, 'ordinary drag snaps pitch');
  assert.ok(changes() > c0);
  assert.equal(previews(), 0, 'the bend preview is released');
  drag(cv, nx(63), ny(2.5), nx(63.4), ny(2.63), { shiftKey: true });
  assert.ok(Math.abs(n.bends[0].d - 3.4) < 1e-9, 'Shift allows continuous pitch');
  assert.equal(n.bends[0].t, 2.75, 'Shift does not bypass time snapping');
  delete n.bends;
  flush();
  dbl(cv, nx(60), ny(1.37));
  assert.equal(n.bends[0].t, 1.25, 'new pitch points also use the time grid');
  n.bends = [{ t: 2.75, d: 3.4, r: 1 }];
  song.snap.free = true;
  drag(cv, nx(63.4), ny(2.75), nx(63.4), ny(2.63));
  assert.equal(n.bends[0].d, 3, 'Free timing does not bypass pitch snapping');
  assert.ok(Math.abs(n.bends[0].t - 2.63) < 1e-6, `dragged off the grid: ${n.bends[0].t}`);
  n.bends = [];
  delete n.bends;
  flush();
  dbl(cv, nx(60), ny(1.37));
  assert.ok(n.bends?.length === 1 && Math.abs(n.bends[0].t - 1.37) < 1e-6, `inserted off the grid: ${n.bends?.[0]?.t}`);
  n.bends = [{ t: 4, d: 12, r: 0 }];
  flush();
  // the body follows the curve: at t=2 it sits 6 semitones up, the straight column is empty there
  point(cv, 'pointermove', nx(66), ny(2));
  assert.match(cv.title, /^C4/, 'hovering the bent body shows the note');
  point(cv, 'pointermove', nx(60), ny(3));
  assert.doesNotMatch(cv.title, /^C4/, 'the column under the start pitch is free later on');
  // transposing keeps the relative bend
  key(cv, 'ArrowRight');
  assert.equal(n.pitch, 61);
  assert.equal(notePitchAt(n, 4), 73);
  // wheel rounds a point
  point(cv, 'wheel', nx(73), ny(4), { deltaY: -100 });
  assert.equal(n.bends[0].r, 0.05);
  // Escape while dragging restores; a fresh double-click insert cancelled removes the point again
  point(cv, 'pointerdown', nx(73), ny(4), { buttons: 1 });
  point(cv, 'pointermove', nx(50), ny(3), { buttons: 1 });
  key(cv, 'Escape');
  assert.deepEqual(n.bends, [{ t: 4, d: 12, r: 0.05 }]);
  // menu on a point: Delete bend point; Reset bend straightens the note
  holdRightClick(cv, nx(73), ny(4));
  assert.ok(labels(menus).includes('Delete bend point'));
  assert.ok(n.bends, 'holding for the menu does not delete');
  pick(menus, 'Delete bend point');
  assert.equal('bends' in n, false);
  n.bends = [{ t: 1, d: -2, r: 0 }, { t: 3, d: 2, r: 0 }];
  flush();
  click(cv, nx(59), ny(1), { button: 2 }); // short right-click on a point deletes it
  assert.deepEqual(n.bends, [{ t: 3, d: 2, r: 0 }]);
  assert.ok(clip.notes.includes(n), 'and not the note');
  holdRightClick(cv, nx(61), ny(0.5));
  pick(menus, 'Reset bend');
  assert.equal('bends' in n, false);
  // micropitch shifts the whole note: the body column follows the cents
  n.pitch = 60.5; // C#4 - 50 cents, half a column left of C#4
  flush();
  point(cv, 'pointermove', nx(60.5), ny(2));
  assert.match(cv.title, /^C#4/, 'the tuned body sits between the columns');
}

// Selected starts share one dragged value even at different times; unselected notes stay unchanged.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 0, 1, 0.5);
  const b = note(62, 2, 2, 0.3);
  const c = note(64, 4, 1, 0.9);
  const other = note(65, 6, 1, 0.4);
  b.vels = [{ t: 1, v: 0.8, r: 0 }];
  clip.notes.push(a, b, c, other);
  flush();
  click(cv, vx(0.5), ny(0));
  click(cv, vx(0.3), ny(2), { shiftKey: true });
  click(cv, vx(0.9), ny(4), { shiftKey: true });
  const c0 = changes();
  drag(cv, vx(0.3), ny(2), vx(0.5), ny(2.4)); // grab the middle note: +0.2, vertical motion ignored
  assert.deepEqual([a, b, c].map((n) => Math.round(n.vel * 1e9) / 1e9), [0.5, 0.5, 0.5], 'different start times and velocities converge to one baseline');
  assert.equal(other.vel, 0.4, 'unselected note unchanged');
  assert.deepEqual(b.vels, [{ t: 1, v: 1, r: 0 }], 'curve points follow their own starts, clamping at the boundary');
  assert.equal(changes(), c0 + 1, 'one undo step');
  drag(cv, vx(0.5), ny(2), vx(0.1), ny(2));
  assert.deepEqual([a, b, c].map((n) => Math.round(n.vel * 1e9) / 1e9), [0.1, 0.1, 0.1]);
  assert.deepEqual(b.vels, [{ t: 1, v: 0.6, r: 0 }]);
  key(cv, 'Backspace');
  assert.deepEqual(clip.notes, [other], 'the selection was kept');
}

// Shift-drag translates complete selected velocity curves without flattening their differences.
for (const fromPoint of [false, true]) {
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 0, 4, 0.3);
  const b = note(64, 5, 3, 0.5);
  const other = note(67, 9, 2, 0.7);
  a.vels = [{ t: 1, v: 0.4, r: 0.2 }, { t: 3, v: 0.8, r: 0.7 }];
  b.vels = [{ t: 2, v: 0.1, r: 0.3 }];
  other.vels = [{ t: 1, v: 0.6, r: 0.4 }];
  clip.notes.push(a, b, other);
  click(cv, nx(60), ny(0));
  click(cv, nx(64), ny(5), { ctrlKey: true });
  const before = structuredClone(clip.notes);
  const count = changes();
  const v = fromPoint ? 0.4 : 0.3;
  const t = fromPoint ? 1 : 0;
  const expectOffset = (delta) => {
    const expected = structuredClone(before);
    for (const n of expected.slice(0, 2)) {
      n.vel = Math.round((n.vel + delta) * 1e9) / 1e9;
      for (const p of n.vels) p.v = Math.round((p.v + delta) * 1e9) / 1e9;
    }
    assert.deepEqual(clip.notes, expected);
  };
  point(cv, 'pointerdown', vx(v), ny(t), { buttons: 1, shiftKey: true });
  point(cv, 'pointermove', vx(v + 0.1), ny(t + 0.5), { buttons: 1, shiftKey: true });
  expectOffset(0.1);
  point(cv, 'pointermove', vx(2), ny(t), { buttons: 1, shiftKey: true });
  expectOffset(0.2);
  point(cv, 'pointermove', vx(-1), ny(t), { buttons: 1, shiftKey: true });
  expectOffset(-0.1);
  point(cv, 'pointermove', vx(v), ny(t), { buttons: 1, shiftKey: true });
  expectOffset(0);
  point(cv, 'pointercancel', vx(v), ny(t), { shiftKey: true });
  assert.deepEqual(clip.notes, before, 'cancel restores every start and curve');
  assert.equal(changes(), count, 'cancel creates no undo step');
  drag(cv, vx(v), ny(t), vx(v + 0.1), ny(t + 0.5), { shiftKey: true });
  expectOffset(0.1);
  assert.equal(changes(), count + 1, 'one undoable edit for the whole group');
  key(cv, 'Delete');
  assert.deepEqual(clip.notes, [other], 'group selection is retained');
}

// Relative group velocity uses the grabbed handle's snapped target, not individual snapping.
{
  const { clip, roll } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 0, 3, 0.3);
  const b = note(64, 4, 2, 0.45);
  a.vels = [{ t: 1, v: 0.6, r: 0.2 }];
  clip.notes.push(a, b);
  key(cv, 'a', { ctrlKey: true });
  drag(cv, vx(0.3), ny(0), vx(0.43), ny(0), { shiftKey: true });
  assert.deepEqual([a.vel, b.vel, a.vels[0].v], [0.4375, 0.5875, 0.7375]);
}

// Unified start velocities reach both endpoints even with extreme curve points.
{
  const { clip, roll, changes } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 3, 0.2);
  const b = note(64, 6, 2, 0.8);
  a.vels = [{ t: 1, v: 1, r: 0.5 }];
  b.vels = [{ t: 1, v: 0, r: 0.2 }];
  clip.notes.push(a, b);
  key(cv, 'a', { ctrlKey: true });
  const before = structuredClone(clip.notes);
  const count = changes();
  point(cv, 'pointerdown', vx(0.2), ny(1), { buttons: 1 });
  point(cv, 'pointermove', vx(1), ny(1), { buttons: 1 });
  assert.deepEqual([a.vel, b.vel], [1, 1]);
  assert.deepEqual([a.vels[0].v, b.vels[0].v], [1, 0.2]);
  point(cv, 'pointermove', vx(0.2), ny(1), { buttons: 1 });
  assert.equal(a.vels[0].v, 0.9875, 'points derive from original values and the snapped target, avoiding cumulative clipping');
  point(cv, 'pointercancel', vx(0.2), ny(1));
  assert.deepEqual(clip.notes, before);
  assert.equal(changes(), count);
  drag(cv, vx(0.2), ny(1), vx(0.71), ny(1));
  assert.deepEqual([a.vel, b.vel], [0.6875, 0.6875], 'all selected starts take the same snapped value');
  assert.deepEqual([a.vels[0].t, b.vels[0].t], [1, 1]);
  assert.deepEqual([a.vels[0].r, b.vels[0].r], [0.5, 0.2]);
  drag(cv, vx(0.6875), ny(1), vx(0), ny(1));
  assert.deepEqual([a.vel, b.vel], [0, 0], 'curve bounds do not prevent setting all starts to zero');
}

// Velocity snapping: all sixteen intervals, including both endpoints.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 3, 0.5);
  const b = note(64, 1, 3, 0.5);
  for (const n of [a, b]) n.vels = [{ t: 1, v: 0.8, r: 0.5 }, { t: 2, v: 0.6, r: 0.2 }];
  clip.notes.push(a, b);
  key(cv, 'a', { ctrlKey: true });
  const before = structuredClone(clip.notes);
  drag(cv, vx(0.8), ny(2), vx(0.6), ny(2.5), {}, 'pointercancel');
  assert.deepEqual(clip.notes, before, 'cancel restores every velocity and point');
  const count = changes();
  drag(cv, vx(0.8), ny(2), vx(0.6), ny(2.5));
  for (const n of clip.notes) {
    assert.equal(n.vel, 0.5, 'point drag never changes start velocity');
    assert.deepEqual(n.vels, [{ t: 1.5, v: 0.6, r: 0.5 }, { t: 2, v: 0.6, r: 0.2 }], 'only corresponding points move; other points and rounding are preserved');
  }
  assert.equal(changes(), count + 1, 'one undoable edit');
}

for (const value of [-0.1, ...Array.from({ length: 17 }, (_, i) => (i + 0.2) / 16), 0.531249, 0.53125, 0.531251, 1.2]) {
  const { clip, roll } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 3, 0.5));
  drag(cv, 7 + 0.5 * 70, ny(1), 7 + value * 70, ny(1));
  assert.equal(clip.notes[0].vel, Math.round(Math.max(0, Math.min(1, value)) * 16) / 16);
}
{
  const { clip, roll, menus, changes, initialSnap, song, ctx } = setup({ snapVelocity: true });
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  assert.equal(initialSnap, true, 'new piano rolls enable snapping by default');
  clip.notes.push(note(60, 1, 3, 0.53));
  const before = structuredClone(clip.notes);
  holdRightClick(cv, 35, ny(5));
  assert.equal(menus.length, 0, 'blank velocity lane no longer offers the snapping menu');
  ctx.pianorollPreferences.snapVelocity = false;
  assert.deepEqual(clip.notes, before, 'toggling does not quantize existing values');
  assert.equal(changes(), 0, 'preferences do not create project edits');
  drag(cv, vx(0.53), ny(1), vx(0.9), ny(1));
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'disabled toggle restores free editing');
  holdRightClick(cv, 35, ny(5));
  ctx.pianorollPreferences.snapVelocity = true;
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'enabling leaves old values untouched too');
  drag(cv, vx(0.9), ny(1), vx(0.6), ny(1), {}, 'pointercancel');
  assert.ok(Math.abs(clip.notes[0].vel - 0.9) < 1e-9, 'cancellation restores the original unsnapped value');
  // Fine movement is still snapped.
  drag(cv, vx(0.9), ny(1), vx(0.6), ny(1), { shiftKey: true });
  assert.equal(clip.notes[0].vel, 0.875);
  drag(cv, vx(0.875), ny(1), vx(0.6), ny(1), {}, 'pointercancel');
  assert.equal(clip.notes[0].vel, 0.875);
  const saved = roll.getView();
  ctx.pianorollPreferences.snapVelocity = false;
  roll.setView(null);
  roll.setView({ ...saved, snapVelocity: true });
  assert.equal(ctx.pianorollPreferences.snapVelocity, false, 'project view cannot override the preference');
  assert.equal('snapVelocity' in roll.getView(), false, 'snapping is no longer saved in project view state');
  song.selected = null;
  holdRightClick(cv, 35, ny(5));
  assert.equal(menus.length, 0, 'no velocity menu without a selected clip');
  cv.drawing.length = 0;
  roll.redraw(); flush();
  for (const x of [7.5, 42.5, 77.5]) {
    assert.equal(cv.drawing.some(([op, px, py]) => op === 'lineTo' && px === x && py === 376), false, 'no velocity grid lines');
  }
  // snap levels are shown as alternating light/dark bands only while snapping is on
  const bands = () => cv.drawing.filter(([op, x, y, w, , fill]) => op === 'fillRect' && fill === 'rgba(0, 0, 0, 0.10)' && y === 0 && x < 84 && w < 10);
  assert.equal(bands().length, 0, 'snapping off: no velocity bands');
  ctx.pianorollPreferences.snapVelocity = true;
  cv.drawing.length = 0;
  roll.redraw(); flush();
  const on = bands();
  assert.equal(on.length, 8, 'snapping on: every other 1/16 step is darkened');
  assert.deepEqual(on.map(([, x]) => x), [1, 3, 5, 7, 9, 11, 13, 15].map((k) => Math.round(7 + (k / 16) * 70)));
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
  drag(cv, vx(0.6875), ny(2), vx(0.91), ny(2.5), { altKey: true });
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

// Velocity right-drag selects starts as notes and curve points individually, without editing data.
{
  const { clip, roll, changes, menus } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const a = note(60, 1, 4, 0.8);
  const b = note(64, 2, 3, 0.7);
  const c = note(67, 3, 2, 0.3);
  a.vels = [{ t: 1, v: 0.2, r: 0 }, { t: 3, v: 0.3, r: 0 }];
  b.vels = [{ t: 1, v: 0.25, r: 0 }];
  clip.notes.push(a, b, c);
  const before = structuredClone(clip.notes);
  const rightDrag = (x, y, toX, toY, end = 'pointerup') => drag(cv, x, y, toX, toY, { button: 2, buttons: 2 }, end);
  rightDrag(vx(0.65), ny(0.8), vx(0.85), ny(2.2));
  assert.deepEqual(clip.notes, before, 'rectangle selection never edits velocity data');
  assert.equal(changes(), 0, 'selection creates no undo step');
  assert.equal(menus.length, 0, 'right-drag never opens a context menu');
  drag(cv, vx(a.vel), ny(1), vx(0.9), ny(1));
  assert.ok(Math.abs(a.vel - 0.9) < 1e-9);
  assert.ok(Math.abs(b.vel - 0.9) < 1e-9, 'enclosed starts select both notes for group editing');
  assert.equal(c.vel, 0.3, 'a start outside the rectangle remains unselected');
  // Select points at different absolute times, but no starts.
  rightDrag(vx(0.1), ny(1.8), vx(0.5), ny(3.2));
  const originals = structuredClone(clip.notes);
  const p = a.vels[0];
  const q = b.vels[0];
  drag(cv, vx(p.v), ny(a.start + p.t), vx(p.v + 0.1), ny(a.start + p.t + 0.5));
  assert.ok(Math.abs(p.v - (originals[0].vels[0].v + 0.1)) < 1e-9);
  assert.ok(Math.abs(q.v - (originals[1].vels[0].v + 0.1)) < 1e-9, 'individually selected points move together across notes and times');
  assert.equal(p.t, 1.5);
  assert.equal(q.t, 1.5);
  assert.deepEqual(a.vels[1], originals[0].vels[1], 'points outside the rectangle are not moved');
  assert.deepEqual(clip.notes.map((n) => n.vel), originals.map((n) => n.vel), 'point-only selection leaves starts unchanged');
  const count = changes();
  // Cancel a new rectangle, then verify the previous point selection still moves together.
  point(cv, 'pointerdown', vx(0.6), ny(0.5), { button: 2, buttons: 2 });
  point(cv, 'pointermove', vx(1), ny(3.5), { button: 2, buttons: 2 });
  key(cv, 'Escape');
  drag(cv, vx(p.v), ny(a.start + p.t), vx(p.v + 0.1), ny(a.start + p.t));
  assert.ok(Math.abs(q.v - (originals[1].vels[0].v + 0.2)) < 1e-9, 'Escape restores the previous point selection');
  assert.equal(changes(), count + 1, 'only the completed point edit is recorded');
  key(cv, 'Escape');
  assert.equal(menus.length, 0);
}

{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const vx = (v) => 7 + v * 70;
  const n = note(60, 0, 6, 0.8);
  n.vels = [{ t: 1, v: 0.2, r: 0 }, { t: 2, v: 0.3, r: 0 }, { t: 5, v: 0.7, r: 0 }];
  clip.notes.push(n);
  drag(cv, vx(0.1), ny(0.5), vx(0.4), ny(2.5), { button: 2, buttons: 2 });
  drag(cv, vx(0.2), ny(1), vx(0.3), ny(3));
  assert.deepEqual(n.vels.map((p) => p.t), [3, 4, 5], 'adjacent selected points translate together rather than blocking each other');
  assert.ok(Math.abs(n.vels[0].v - 0.3) < 1e-9);
  assert.ok(Math.abs(n.vels[1].v - 0.4) < 1e-9);
  assert.equal(changes(), 1);
  const before = structuredClone(n);
  drag(cv, vx(0.3), ny(3), vx(0.5), ny(4), {}, 'pointercancel');
  assert.deepEqual(n, before, 'cancelling a multi-point move restores every selected point');
  drag(cv, vx(0.3), ny(3), vx(0.4), ny(3.5));
  assert.deepEqual(n.vels.map((p) => p.t), [3.5, 4.5, 5], 'cancelling preserves the multi-point selection for the next drag');
}

{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 1, 0.4), note(64, 8, 1, 0.4));
  point(cv, 'pointerdown', 20, ny(0.5), { button: 2, buttons: 2 });
  point(cv, 'pointermove', 45, ny(2), { button: 2, buttons: 2 });
  const before = roll.getView().sy;
  point(cv, 'wheel', 45, ny(2), { deltaY: 300, deltaX: 0 });
  assert.ok(roll.getView().sy > before, 'wheel scrolling extends a velocity selection rectangle');
  point(cv, 'pointerup', 45, ny(2), { button: 2 });
  key(cv, 'Delete');
  assert.equal(clip.notes.length, 0, 'the scrolled rectangle selects starts across the clip');
  assert.equal(changes(), 1, 'only deleting the selected notes changes the clip');
}

{
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const { clip, roll, changes } = setup();
    const cv = roll.surface.cv;
    clip.length = 64;
    clip.notes.push(note(60, 1, 1, 0.4), note(64, 20, 1, 0.4));
    point(cv, 'pointerdown', 20, ny(0.5), { button: 2, buttons: 2 });
    point(cv, 'pointermove', 45, 1000, { button: 2, buttons: 2 });
    mock.timers.tick(3000); flush();
    assert.ok(roll.getView().sy > 500, 'velocity rectangle autoscrolls beyond the bottom edge');
    point(cv, 'pointerup', 45, 1000, { button: 2 });
    key(cv, 'Delete');
    assert.equal(clip.notes.length, 0, 'edge scrolling extends selection to offscreen note starts');
    assert.equal(changes(), 1);
  } finally {
    mock.timers.reset();
  }
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

// Beyond the 10 px threshold, duration drags put the note end at the snapped pointer.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 32), note(64, 1, 8));
  drag(cv, nx(60), ny(2.6), nx(60), ny(2.6) + 11);
  assert.equal(clip.notes[0].length, 1.75, 'end snaps to the 16th grid under the pointer');
  drag(cv, nx(60), ny(1.5), nx(60), ny(0.2));
  assert.equal(clip.notes[0].length, 0.25, 'never shorter than one snap step');
  key(cv, 'a', { ctrlKey: true });
  drag(cv, nx(64), ny(5), nx(64), ny(4));
  assert.deepEqual(clip.notes.map((n) => n.length), [0.25, 8], 'shortest note limits shortening for the whole selection');
}

// Multi-note duration drags apply an equal delta, not a shared endpoint.
for (const free of [false, true]) {
  const { clip, song, roll } = setup();
  song.snap.free = free;
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1, 2), note(64, 2, 4), note(67, 0.5, 3));
  key(cv, 'a', { ctrlKey: true });
  const amount = free ? 0.73 : 0.75;
  drag(cv, nx(64), ny(3), nx(64), ny(3 + amount));
  clip.notes.forEach((n, i) => assert.ok(Math.abs(n.length - ([2, 4, 3][i] + amount)) < 1e-6, 'every note lengthens equally'));
  assert.deepEqual(clip.notes.map((n) => n.start), [1, 2, 0.5], 'resizing preserves start times');
  drag(cv, nx(60), ny(2), nx(60), ny(1.5));
  clip.notes.forEach((n, i) => assert.ok(Math.abs(n.length - ([2, 4, 3][i] + amount - 0.5)) < 1e-6, 'every note shortens equally from either anchor'));
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
    click(cv, ax(20), ay(100), { button: 2 });
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
    assert.ok(labels(menus).includes('Insert/Edit time-Signature Change…'), 'holding an existing signature opens the insertion menu');
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
  const lx = (v) => 48 + v * (420 - ROLL_SB);
  const ly = (t) => t * 48 - lane.getView().sy; // starts with free space above time 0, like the piano roll
  assert.equal(lane.getView().sy, -TOP_MARGIN, 'starts with the piano roll\'s top margin');
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
  lane.setView({ sy: 0 }); // scrolled down: later times fit the test canvas
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

// Automation playback uses absolute, floor-snapped pointer time, including after view changes.
{
  const song = emptySong();
  const a = addAutoClip(song, { start: 8.25, length: 8 });
  song.selected = a.id;
  const lane = createAutomationLane(host(), {
    song: () => song, clip: () => song.selected === a.id ? a : null,
    color: () => '#e76f51', transport: { playing: false, pos: 0 },
    changed() {}, autoParam: () => null,
  });
  flush();
  const cv = lane.surface.cv;
  assert.equal(lane.getPointerTime(), null);
  point(cv, 'pointermove', 200, TOP_MARGIN + 1.4 * 48);
  assert.equal(lane.getPointerTime(), 9.5);
  a.points.push({ t: 1.4, v: (200 - 48) / (420 - ROLL_SB), r: 0 });
  point(cv, 'pointermove', 200, TOP_MARGIN + 1.4 * 48);
  assert.equal(lane.getPointerTime(), 9.5, 'hovering a point still uses floor snapping');
  song.snap.div = 2;
  song.freeTime = true;
  assert.equal(lane.getPointerTime(), 9.625, 'automation keeps snapping even with Free timing');
  lane.setView({ sy: 96, ppq: 96 });
  flush();
  assert.equal(lane.getPointerTime(), 11.25, 'uses current scroll and zoom');
  point(cv, 'pointermove', 20, 200);
  assert.equal(lane.getPointerTime(), null, 'ruler is not a time position');
  point(cv, 'pointermove', 200, 390);
  assert.equal(lane.getPointerTime(), null, 'value scale is not a time position');
  lane.reveal(); flush();
  point(cv, 'pointermove', 200, 20);
  assert.equal(lane.getPointerTime(), a.start, 'top margin clamps to clip start');
  point(cv, 'wheel', 200, TOP_MARGIN + 1.4 * 96, { deltaY: 0, deltaX: 0, deltaMode: 0 });
  assert.equal(lane.getPointerTime(), 9.625, 'wheel refreshes the pointer position');
  point(cv, 'pointerleave', 200, 200);
  assert.equal(lane.getPointerTime(), null);
  song.selected = null;
  point(cv, 'pointermove', 200, 200);
  assert.equal(lane.getPointerTime(), null, 'no selected automation clip');
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

// Signature gridBeats filters piano-roll beat/bar lines, not the ruler or clip boundaries.
{
  const { song, clip, roll } = setup();
  clip.length = 14;
  const cv = roll.surface.cv;
  const lines = (beats) => {
    setSig(song, 0, 7, 8, beats);
    roll.setView({ ...roll.getView(), ppq: 96, sy: 0 });
    cv.drawing.length = 0; roll.redraw(); flush();
    const times = [];
    for (let i = 2; i < cv.drawing.length; i++) {
      const [op, color, width] = cv.drawing[i];
      const from = cv.drawing[i - 2], to = cv.drawing[i - 1];
      if (op === 'stroke' && color === '#111216' && width === 4 &&
          from[0] === 'moveTo' && to[0] === 'lineTo' && from[2] === to[2] && from[1] > 120 && from[2] > 0.5) times.push((from[2] - 0.5) / 96);
    }
    return times;
  };
  const all = lines([0, 1, 2, 3, 4, 5, 6]);
  assert.ok(all.includes(0.5) && all.includes(3.5), `all beats include inner beats and measure start: ${all}`);
  const selected = lines([2, 4]);
  assert.ok(selected.includes(1) && selected.includes(2));
  assert.ok(!selected.includes(0.5) && !selected.includes(3.5), 'disabled beat zero hides repeating barlines');
  assert.deepEqual(lines([]), [], 'all musical lines may be hidden');
  assert.ok(cv.drawing.some(([op, text]) => op === 'fillText' && text === '7/8'), 'ruler signatures remain visible');
}

// Zoomed out in time, grid lines closer than GRID_MIN_PX disappear: beat lines as a whole, bar
// lines thinned (the same ones while scrolling), so no two drawn lines get closer than that.
{
  const { song, clip, roll } = setup();
  const cv = roll.surface.cv;
  const render = (v) => { roll.setView({ ...roll.getView(), ...v }); cv.drawing.length = 0; roll.redraw(); flush(); };
  const dashed = () => cv.drawing.some(([op, dash]) => op === 'setLineDash' && JSON.stringify(dash) === '[12,12]');
  // grid lines: full-width horizontal strokes inside the grid (bar lines are 4 px wide)
  const barYs = () => {
    const ys = [];
    for (let i = 2; i < cv.drawing.length; i++) {
      const [op, color, width] = cv.drawing[i];
      const to = cv.drawing[i - 1];
      const from = cv.drawing[i - 2];
      if (op === 'stroke' && color === '#111216' && width === 4 && from[0] === 'moveTo' && to[0] === 'lineTo' && from[2] === to[2] && from[1] >= nx(22) - 20) ys.push(from[2]);
    }
    return [...new Set(ys)].sort((a, b) => a - b);
  };
  render({ ppq: 48, sy: 0 });
  assert.ok(dashed(), 'beat lines at 48 px per beat');
  render({ ppq: GRID_MIN_PX - 1 });
  assert.ok(!dashed(), 'beat lines closer than GRID_MIN_PX disappear');
  // 1/8: a bar is half a quarter, 3 px at the widest zoom out
  clip.length = 64;
  setSig(song, 0, 1, 8);
  render({ ppq: 6, sy: 0 });
  const ys = barYs();
  assert.ok(ys.length > 10, `bar lines still drawn: ${ys.length}`);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= GRID_MIN_PX - 1, `bar lines ${ys[i - 1]} / ${ys[i]} too close`);
  // scrolling keeps the same bars (no flicker): the times of the drawn lines match after a scroll
  const timesAt = (list) => { const { sy } = roll.getView(); return list.map((y) => (y - 0.5 + sy) / 6); };
  const times = timesAt(ys);
  const sy0 = roll.getView().sy;
  render({ ppq: 6, sy: sy0 + 20 });
  assert.equal(roll.getView().sy, sy0 + 20, 'scrolled');
  const shifted = timesAt(barYs());
  const common = shifted.filter((t) => t <= times.at(-1));
  assert.ok(common.length > 5);
  for (const t of common) assert.ok(times.some((u) => Math.abs(u - t) < 0.3), `bar at ${t} newly drawn after scrolling`);
  render({ ppq: 600, sy: 0 });
  const close = barYs();
  assert.ok(close.length >= 2 && close[1] - close[0] >= 290, 'zoomed in: every bar');
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
  const kw = (width - ROLL_SB - 120) / 128;
  const left = 120 + 22.5 * kw;
  const right = 120 + 106.5 * kw;
  const bands = cv.drawing.filter(([op, x, , , , color]) => op === 'fillRect' && color === 'rgba(0, 0, 0, 0.10)' && x >= 120);
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
  const kw = (width - ROLL_SB - 120) / 128;
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

// A vertical scrollbar (the TimeLine's look) right of the note grid scrolls the clip.
{
  const { clip, roll, changes } = setup();
  const cv = roll.surface.cv;
  const x = ROLL_WIDTH - ROLL_SB / 2;
  const bottom = 400 - 24; // above the keyboard
  const max = (clip.length + 4) * 48 - bottom; // a bar past the clip end
  cv.drawing.length = 0;
  roll.redraw(); flush();
  assert.ok(cv.drawing.some(([op, x0, y0, w, h, color]) => op === 'fillRect' && x0 === ROLL_WIDTH - ROLL_SB && y0 === 0
    && w === ROLL_SB && h === bottom && color === '#151517'), 'the track spans the note grid height');
  roll.setView({ sy: 0 }); flush();
  click(cv, x, bottom - 4); // the track below the thumb: jump to the end
  assert.equal(roll.getView().sy, max);
  drag(cv, x, bottom - 20, x, -500); // drag the thumb all the way up
  assert.equal(roll.getView().sy, -128, 'back to the margin above the clip start');
  click(cv, x, bottom + 10); // the dead corner beside the keyboard
  assert.equal(clip.notes.length, 0, 'the scrollbar never inserts notes');
  assert.equal(changes(), 0, 'scrolling is no undo step');
  const keys = cv.drawing.filter(([op, , y, , h]) => op === 'fillRect' && y === 377 && h === 22);
  assert.ok(keys.every(([, kx, , kw]) => kx + kw <= ROLL_WIDTH - ROLL_SB), 'the keyboard ends at the scrollbar');
}

// Automation uses the same jump-to-click scrollbar without editing points or their values.
{
  const song = emptySong();
  const clip = addAutoClip(song, { length: 64 });
  clip.points.push({ t: 1, v: 1, r: 0 }, { t: 80, v: 0.5, r: 0 });
  const original = JSON.stringify(clip.points);
  const laneHost = host();
  let changes = 0;
  let viewChanges = 0;
  let current = clip;
  const lane = createAutomationLane(laneHost, {
    song: () => song, clip: () => current, color: () => '#e76f51',
    transport: { playing: false, pos: 0 }, autoParam: () => null,
    changed: () => changes++, viewChanged: () => viewChanges++,
  });
  flush();
  const cv = lane.surface.cv;
  const x = 480 - ROLL_SB / 2;
  const bottom = 400 - 24;
  const max = (80 + 4) * 48 - bottom;
  const size = Math.max(48, bottom * bottom / (max + TOP_MARGIN + bottom));
  assert.ok(cv.drawing.some(([op, tx, ty, w, h, color]) => op === 'fillRect'
    && tx === 448 && ty === 0 && w === ROLL_SB && h === 400 && color === '#151517'),
  'track and dead corner sit beside the value grid and scale');
  click(cv, x, 200);
  const expected = -TOP_MARGIN + (200 - size / 2) / (bottom - size) * (max + TOP_MARGIN);
  assert.ok(Math.abs(lane.getView().sy - expected) < 1e-9, 'track click centres the thumb at the clicked position');
  assert.ok(viewChanges > 0, 'scrollbar saves the view');
  lane.setView({ sy: -TOP_MARGIN }); flush();
  drag(cv, x, 200, x, 240);
  assert.ok(Math.abs(lane.getView().sy - (-TOP_MARGIN + (240 - size / 2) / (bottom - size) * (max + TOP_MARGIN))) < 1e-9,
    'track press continues dragging');
  click(cv, x, bottom - 1);
  assert.equal(lane.getView().sy, max, 'range includes points past the clip end and an extra bar');
  drag(cv, x, bottom - 12, x, bottom - 32);
  assert.ok(Math.abs(lane.getView().sy - (max - 20 / (bottom - size) * (max + TOP_MARGIN))) < 1e-9,
    'handle drag retains its grab offset');
  drag(cv, x, 10, x, -500);
  assert.equal(lane.getView().sy, -TOP_MARGIN, 'drag clamps to the top margin');
  point(cv, 'pointerdown', x, 250, { buttons: 1 });
  point(cv, 'pointercancel', x, 250);
  click(cv, x, bottom - 1);
  assert.equal(lane.getView().sy, max, 'cancel releases the scrollbar for the next drag');
  const saved = lane.getView();
  dbl(cv, x, bottom + 10);
  click(cv, x, 100, { button: 2 });
  assert.deepEqual(lane.getView(), saved, 'dead corner and right click do not scroll');
  assert.equal(lane.getPointerTime(), null, 'scrollbar is not a playback time target');
  fire(cv, 'wheel', { clientX: x, clientY: 100, deltaY: -60, deltaMode: 0 });
  assert.equal(lane.getView().sy, max - 60, 'wheel over the track scrolls');
  fire(cv, 'wheel', { clientX: x, clientY: 100, deltaY: -100, deltaMode: 0, ctrlKey: true });
  assert.ok(lane.getView().ppq > 48, 'wheel zoom still works over the track');
  laneHost.clientHeight = 600;
  lane.redraw(); flush();
  click(cv, x, 575);
  assert.equal(lane.getView().sy, 84 * lane.getView().ppq - 576, 'range follows zoom and resize');
  lane.setView({ sy: -TOP_MARGIN, ppq: 48 }); flush();
  point(cv, 'pointerdown', 436, 176, { buttons: 1 });
  point(cv, 'pointerup', 436, 176);
  fire(cv, 'wheel', { clientX: 436, clientY: 176, deltaY: -1, deltaMode: 0 });
  assert.equal(clip.points[0].r, 0.05, 'maximum-value point stays inside the grid and editable');
  clip.points[0].r = 0;
  assert.equal(JSON.stringify(clip.points), original, 'scrollbar gestures never edit automation');
  assert.equal(changes, 1, 'only the explicit point rounding creates an edit');
  current = null;
  lane.redraw(); flush();
  click(cv, x, 575);
  assert.ok(Number.isFinite(lane.getView().sy), 'scrollbar works without a selected clip');
}

// Shift + wheel zooms pitch (stave and keyboard) around the pointer; zoomed in, a horizontal
// scrollbar shows above the keys and middle-drag pans sideways. The view is saved.
{
  const { clip, roll, ctx } = setup();
  const cv = roll.surface.cv;
  const played = [];
  const on = ctx.preview.on;
  ctx.preview.on = (c, pitch) => { played.push(pitch); return on(c, pitch); };
  clip.notes.push(note(60, 1), note(61, 1));
  const heads = () => {
    cv.drawing.length = 0;
    roll.redraw(); flush();
    return cv.drawing.filter(([op]) => op === 'translate').map((op) => op[1]).slice(0, 2); // the notes, not the hover ghost
  };
  const track = (y) => cv.drawing.some(([op, x0, y0, w, h, color]) => op === 'fillRect' && x0 === 0 && y0 === y && h === ROLL_SB && color === '#151517');
  const [a0, b0] = heads();
  assert.equal(b0 - a0, 14, 'unzoomed: one 14 px column per key');
  assert.ok(!track(400 - 24 - ROLL_SB), 'no horizontal scrollbar unzoomed');
  for (let i = 0; i < 10; i++) fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaX: 0, deltaY: -100, deltaMode: 0, shiftKey: true });
  const [a1, b1] = heads();
  assert.ok(Math.abs(a1 - a0) < 1e-6, 'the key under the pointer stays put');
  assert.ok(b1 - a1 > 50, `keys widen (${b1 - a1} px)`);
  assert.equal(roll.getView().sy, 0, 'Shift + wheel does not scroll time');
  const sbY = 400 - 24 - ROLL_SB;
  assert.ok(track(sbY), 'the horizontal scrollbar shows just above the keyboard');
  const bodies = cv.drawing.filter(([op]) => op === 'roundRect');
  assert.ok(bodies.length === 2 && bodies.every((r) => r[3] <= 48 + 1), 'notes stop growing at 48 px');
  // keys and stave stay aligned: click the keyboard and the stave under the same key
  click(cv, b1, 390);
  assert.deepEqual(played, [61], 'the zoomed key under the pointer plays');
  click(cv, b1, ny(6));
  assert.deepEqual(clip.notes.at(-1).pitch, 61, 'a note lands in the zoomed column under the pointer');
  clip.notes.pop();
  // middle-drag pans sideways (and in time)
  drag(cv, 600, 100, 700, 100, { button: 1 });
  const [a2] = heads();
  assert.ok(Math.abs(a2 - (a1 + 100)) < 1e-6, 'middle-drag pans the zoomed keys');
  // the horizontal scrollbar: click the track at its right end, the view jumps to the highest keys
  click(cv, ROLL_WIDTH - ROLL_SB - 2, sbY + 16);
  click(cv, ROLL_WIDTH - ROLL_SB - 4, ny(6));
  assert.equal(clip.notes.at(-1).pitch, 127, 'scrolled to the right end of the keys');
  clip.notes.pop();
  assert.equal(clip.notes.length, 2, 'the scrollbar inserts no notes');
  const saved = JSON.parse(JSON.stringify(roll.getView()));
  assert.ok(saved.hz > 1 && saved.hx > 0, 'pitch zoom and scroll are saved');
  for (let i = 0; i < 40; i++) fire(cv, 'wheel', { clientX: 600, clientY: 100, deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true });
  const [a3, b3] = heads();
  assert.deepEqual([a3, b3], [a0, b0], 'zoomed fully out: back to all keys');
  assert.ok(!track(sbY), 'the horizontal scrollbar hides again');
  roll.setView(saved); flush();
  assert.deepEqual(roll.getView(), saved, 'pitch zoom and scroll survive a view round trip');
  for (let i = 0; i < 10; i++) fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaX: 0, deltaY: -100, deltaMode: 0, shiftKey: true });
  roll.setView({ sy: 0, ppq: 48 });
  assert.deepEqual(heads(), [a0, b0], 'older views without pitch zoom start unzoomed');
}

// When zoomed in, moving a note past the side edge scrolls the keys along.
{
  const { clip, roll } = setup();
  const cv = roll.surface.cv;
  clip.notes.push(note(60, 1));
  for (let i = 0; i < 15; i++) fire(cv, 'wheel', { clientX: nx(60), clientY: 100, deltaX: 0, deltaY: -100, deltaMode: 0, shiftKey: true });
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const x = nx(60);
    point(cv, 'pointerdown', x, ny(1) + 3, { buttons: 1 });
    point(cv, 'pointermove', ROLL_WIDTH - ROLL_SB - 2, ny(1) + 3, { buttons: 1 });
    const p0 = clip.notes[0].pitch;
    mock.timers.tick(2000);
    assert.ok(clip.notes[0].pitch > p0, `the note keeps moving up while the keys scroll (${p0} → ${clip.notes[0].pitch})`);
    point(cv, 'pointerup', ROLL_WIDTH - ROLL_SB - 2, ny(1) + 3);
  } finally {
    mock.timers.reset();
  }
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
  const kw = (ROLL_WIDTH - ROLL_SB - 220) / 128;
  assert.deepEqual(centers(), [220 + kw / 2, 220 + 127.5 * kw], 'the grid scales into the rest');
  assert.equal(viewChanges, 1, 'saved as a view change');
  assert.equal(changes(), 0, 'no undo step');
  assert.deepEqual(clip.notes, before, 'notes untouched');
  drag(cv, 200, 50, 99999, 50);
  assert.equal(roll.getView().velW, ROLL_WIDTH * 0.5, 'at most 50 % of the roll');
  drag(cv, ROLL_WIDTH * 0.5 + 10, 50, -500, 50);
  assert.equal(roll.getView().velW, 0, 'velocity strip can collapse fully');
  point(cv, 'pointerdown', 10, 50, { buttons: 1, detail: 2 });
  point(cv, 'pointerup', 10, 50);
  assert.equal(roll.getView().velW, 84, 'double-click resets');
  roll.setView({ ...roll.getView(), velW: 150 });
  assert.equal(roll.getView().velW, 150, 'restored from the project view');
  roll.setView(undefined);
  assert.equal(roll.getView().velW, 84, 'new project: default');
  roll.setView({ sy: 0, ppq: 48 });
  assert.equal(roll.getView().velW, 84, 'older projects: default');
  clip.length = 16;
  roll.setView({ ...roll.getView(), sy: 100 });
  viewChanges = 0;
  const anchored = (150 + 100) / 48;
  point(cv, 'pointerdown', 100, 150, { buttons: 1 });
  point(cv, 'pointermove', 101, 110, { buttons: 1 });
  assert.ok(roll.getView().ppq > 48, 'upward ruler drag zooms time in immediately');
  assert.ok(Math.abs((150 + roll.getView().sy) / roll.getView().ppq - anchored) < 1e-9, 'zoom preserves time at the grab position');
  point(cv, 'pointermove', 160, 90, { buttons: 1 });
  point(cv, 'pointerup', 160, 90);
  assert.ok(Math.abs(roll.getView().ppq - 48 * Math.pow(1.15, 60 / 48)) < 1e-9);
  assert.equal(roll.getView().velW, 144, 'diagonal ruler drag resizes while zooming');
  assert.equal(viewChanges, 1);
  const zoomBefore = roll.getView().ppq;
  point(cv, 'pointerdown', 160, 150, { buttons: 1 });
  point(cv, 'pointermove', 190, 151, { buttons: 1 });
  point(cv, 'pointermove', 200, 200, { buttons: 1 });
  point(cv, 'pointerup', 200, 200);
  assert.equal(roll.getView().velW, 184);
  assert.ok(roll.getView().ppq < zoomBefore, 'both axes remain active throughout the drag');
  const saved = roll.getView();
  point(cv, 'pointerdown', 200, 150, { buttons: 1 });
  point(cv, 'pointermove', 220, 200, { buttons: 1 });
  point(cv, 'pointercancel', 220, 200);
  assert.deepEqual(roll.getView(), saved, 'cancel restores ruler zoom and resize');
  point(cv, 'pointerdown', 200, 150, { buttons: 1 });
  point(cv, 'pointermove', 240, 170, { buttons: 1 });
  key(cv, 'Escape');
  point(cv, 'pointerup', 240, 170);
  assert.deepEqual(roll.getView(), saved, 'Escape restores ruler resize');
  drag(cv, 200, 150, 200, -10000);
  assert.equal(roll.getView().ppq, 600, 'ruler zoom uses the existing maximum');
  drag(cv, 200, 150, 200, 10000);
  assert.equal(roll.getView().ppq, 6, 'ruler zoom uses the existing minimum');
  assert.deepEqual(clip.notes, before);
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
    flush();
    const centers = cv.drawing.filter(([op]) => op === 'translate').map((op) => op[1]);
    const kw = (width - ROLL_SB - 120) / 128;
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
    assert.deepEqual(Object.keys(roll.getView()).sort(), ['hx', 'hz', 'ppq', 'sy', 'velW'], 'the view includes pitch zoom and scroll, not preferences');
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
  assert.equal(roll.getView().sy, -128 + 16, 'margin scrolls away by the wheel distance');
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
    flush();
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
    replaceChildren(...children) { this.children = children; }
    contains(el) { return el === this; }
    blur() { document.activeElement = null; }
    closest(selector) { return this.kind !== 'div' && selector.includes(this.kind) ? this : null; }
  }
  const elements = new Map();
  const inputIds = ['seq-name', 'seq-snap-div', 'seq-free-time'];
  const transportIds = ['seq-restart', 'seq-play', 'seq-loop', 'seq-stop', 'seq-record'];
  for (const id of ['seq', 'seq-bar', 'seq-bar-content', ...transportIds, 'seq-pos', 'seq-target', 'seq-snap-base', 'seq-ctl', 'seq-ctl-field', 'seq-target-field', ...inputIds,
    'workspace', 'patcher', 'roll', 'arranger', 'seq-split', 'seq-hsplit', 'panel', 'panel-split', 'status']) {
    elements.set(id, new Element(inputIds.includes(id) ? 'input' : transportIds.includes(id) ? 'button' : 'div'));
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
  let songChanges = 0;
  const engine = { song, resume() {}, panic() { panics++; }, root: { modules: new Map(), listeners: new Set() } };
  let picked = null; // the module selected in the patcher (main.js selectedTarget)
  const seq = createSequencer({
    engine,
    transport, getTarget: () => null, defaultTarget: () => null, selectedTarget: () => picked, onChange() { viewChanges++; },
    onSongChange() { songChanges++; },
  });
  seq.reload();
  flush();
  const free = elements.get('seq-free-time');
  assert.equal(free.checked, false, 'Free timing defaults off');
  assert.equal('snapVelocity' in seq.viewState().roll, false);
  seq.applyView({ roll: { snapVelocity: false } });
  const snapView = JSON.parse(JSON.stringify(seq.viewState()));
  seq.applyView(null);
  assert.equal('snapVelocity' in seq.viewState().roll, false, 'new project does not store preferences');
  seq.applyView(snapView);
  assert.equal('snapVelocity' in seq.viewState().roll, false, 'legacy project snapping is ignored');
  seq.applyView({ roll: { sx: 0, sy: 0 } });
  assert.equal('snapVelocity' in seq.viewState().roll, false, 'old projects do not override preferences');
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
  assert.ok(elements.get('seq-loop').classes.has('playing'));
  assert.ok(!elements.get('seq-play').classes.has('playing'));
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
  assert.equal(transport.pos, 1.5, 'play button starts at the parked playhead');
  assert.ok(elements.get('seq-play').classes.has('playing'));
  elements.get('seq-play').onclick();
  assert.equal(transport.playing, true, 'play button never toggles to stop');
  assert.equal(transport.pos, 1.5);
  elements.get('seq-restart').onclick();
  assert.equal(transport.pos, 0, 'restart button matches comma');
  assert.equal(transport.clipId, null);
  elements.get('seq-loop').onclick();
  assert.equal(transport.clipId, clip.id, 'clip button matches slash');
  assert.equal(transport.pos, clip.start);
  assert.ok(elements.get('seq-loop').classes.has('playing'));
  transport.seek(clip.start + 0.1);
  elements.get('seq-stop').onclick();
  assert.equal(transport.playing, false);
  assert.equal(transport.pos, clip.start + 0.1, 'stop button keeps the playhead, like apostrophe');
  assert.ok(!elements.get('seq-play').classes.has('playing'));
  assert.ok(!elements.get('seq-loop').classes.has('playing'));
  const beforePanic = panics;
  elements.get('seq-stop').onclick();
  assert.equal(panics, beforePanic + 1, 'repeated stop button matches apostrophe panic');
  song.selected = null;
  elements.get('seq-loop').onclick();
  assert.equal(transport.playing, false, 'clip playback needs a selection');
  assert.match(elements.get('status').textContent, /Select a clip/);
  song.selected = selected;
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
  // a restart point: stopping song playback (Space, ', the stop button) parks the playhead there; the / clip loop does not
  song.restart = 1;
  press('.');
  press(' ');
  assert.equal(transport.pos, 1, 'Space stops at the restart point');
  press(',');
  transport.seek(3);
  press("'");
  assert.equal(transport.pos, 1, "' stops at the restart point");
  press('.');
  elements.get('seq-stop').onclick();
  assert.equal(transport.pos, 1, 'stop button too');
  press('/');
  transport.seek(clip.start + 0.1);
  press(' ');
  assert.equal(transport.pos, clip.start, 'clip loop: Space parks at the clip start as before');
  press('/');
  transport.seek(clip.start + 0.1);
  press("'");
  assert.equal(transport.pos, clip.start + 0.1, "clip loop: ' keeps the playhead as before");
  delete song.restart;
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
  const auto = addAutoClip(song, { start: 8.25, length: 4 });
  song.selected = auto.id;
  seq.reload();
  seq.applyView({ lane: { sy: 0, ppq: 48 } });
  flush();
  const laneCanvas = elements.get('roll').children[1];
  point(laneCanvas, 'pointermove', 200, 1.4 * 48);
  press(' ', {}, laneCanvas);
  assert.equal(transport.pos, 9.5, 'automation Space starts at clip start plus floor-snapped mouse time');
  assert.equal(transport.clipId, null, 'automation Space plays the whole song');
  press(' ', {}, laneCanvas);
  assert.equal(transport.pos, auto.start, 'automation Space stops at the selected clip start');
  song.restart = 1;
  press(' ', {}, laneCanvas);
  press(' ', {}, laneCanvas);
  assert.equal(transport.pos, 1, 'automation Space still stops at the restart point');
  delete song.restart;
  point(laneCanvas, 'pointerleave', 200, 1.4 * 48);
  transport.seek(3);
  press(' ', {}, laneCanvas);
  assert.equal(transport.pos, 3, 'outside the automation lane, Space uses the parked playhead');
  press(' ', {}, laneCanvas);
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

  // Automation lists use controller numbers, not positions, and keep old reserved targets missing.
  {
    const mapped = { id: 'map1', label: 'Brightness', min: 20, max: 20000, number: 11 };
    engine.root.modules.set(81, {
      id: 81, def: { type: 'PATCH', params: [{ id: 'inputModule', label: 'Input Module' }, { id: 'instances', label: 'Instances' }, mapped] },
      inst: {}, values: { map1: 1000 },
    });
    const auto = addAutoClip(song, { target: 81, controller: 11, length: 1 });
    song.selected = auto.id;
    seq.reload(); flush();
    const options = () => elements.get('seq-ctl').children.map((o) => [o.label, o.value]);
    assert.deepEqual(options(), [['0 · Input Module', 0], ['1 · Instances', 1], ['11 · Brightness', 11]]);
    auto.controller = 2;
    seq.reload(); flush();
    assert.deepEqual(options().at(-1), ['2 · (missing)', 2], 'old mapped targets are not silently reassigned');
    engine.root.modules.delete(81);
    song.clips = [];
    song.selected = null;
    seq.reload(); flush();
  }

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

  // Send to applies to the selected MIDI clips in one edit, preserving automation and clone routing.
  {
    const a = addClip(song, { start: 0, length: 2, y: 0, target: 3 });
    const b = addClip(song, { start: 4, length: 2, y: 34, target: 5 });
    const clone = cloneClip(song, b);
    clone.start = 8;
    clone.y = 102;
    const unselected = addClip(song, { start: 12, length: 2, y: 0, target: 9 });
    const auto = addAutoClip(song, { start: 0, length: 2, y: 68, target: 11, controller: 4 });
    song.selected = a.id;
    seq.applyView({ arranger: { sx: 0, sy: 0, ppq: 16 } });
    elements.get('seq-name').dispatchEvent(new Event('change')); // baseline for undo
    const cv = elements.get('arranger').children[0];
    click(cv, ax(0.5), ay(0));
    click(cv, ax(4.5), ay(34), { ctrlKey: true });
    click(cv, ax(0.5), ay(68), { ctrlKey: true });
    click(cv, ax(0.5), ay(0), { ctrlKey: true }); // remove, then make MIDI primary again
    click(cv, ax(0.5), ay(0), { ctrlKey: true });
    assert.equal(song.selected, a.id);
    const before = viewChanges;
    elements.get('seq-target').value = '7';
    elements.get('seq-target').dispatchEvent(new Event('change'));
    assert.deepEqual([a, b, clone].map((c) => c.target), [7, 7, 7]);
    assert.equal(unselected.target, 9);
    assert.deepEqual([auto.target, auto.controller], [11, 4], 'selected automation is untouched');
    assert.equal(viewChanges, before + 1, 'one edit notification for the group');
    undoKey({ ctrlKey: true });
    assert.deepEqual(engine.song.clips.map((c) => c.target), [3, 5, 5, 9, 11], 'one undo restores every destination');
    undoKey({ ctrlKey: true, shiftKey: true });
    assert.deepEqual(engine.song.clips.map((c) => c.target), [7, 7, 7, 9, 11], 'one redo restores the group edit');
    engine.song = song;
    seq.reload(); flush();
    elements.get('seq-target').value = '';
    elements.get('seq-target').dispatchEvent(new Event('change'));
    assert.deepEqual([a, b, clone].map((c) => c.target), [null, null, null], 'none also applies to the group');
    assert.equal(unselected.target, 9);
    song.selected = auto.id;
    seq.reload(); flush();
    elements.get('seq-target').value = '13';
    elements.get('seq-target').dispatchEvent(new Event('change'));
    assert.deepEqual([auto.target, auto.controller], [13, 0], 'automation keeps its existing single-clip behavior');
    assert.deepEqual([a, b].map((c) => c.target), [null, null]);
    song.clips = [];
    song.selected = null;
    seq.reload(); flush();
  }

  // Double-clicking a clip expands and focuses its editor, without editing the clip data.
  {
    const midi = addClip(song, { start: 0, length: 4 });
    const auto = addAutoClip(song, { start: 6, length: 4 });
    song.selected = auto.id;
    seq.reload(); flush();
    seq.applyView({ top: 0.37, bottom: 0.81 });
    const cv = elements.get('arranger').children[0];
    const clips = structuredClone(song.clips);
    const before = viewChanges;
    point(cv, 'dblclick', ax(1), ay(0));
    assert.equal(song.selected, midi.id, 'double-click selects the clicked clip without relying on pointerdown');
    assert.deepEqual([seq.viewState().top, seq.viewState().bottom], [1, 1], 'both dividers move to the bottom');
    assert.equal(document.activeElement, elements.get('roll').children[0], 'piano roll receives keyboard focus');
    assert.deepEqual(song.clips, clips, 'maximizing is view-only');
    assert.ok(viewChanges > before, 'layout change is persisted');
    const saved = JSON.parse(JSON.stringify(seq.viewState()));
    seq.applyView(null);
    seq.applyView(saved);
    assert.deepEqual([seq.viewState().top, seq.viewState().bottom], [1, 1], 'maximized layout survives saving/loading');
    seq.applyView({ top: 0.37, bottom: 0.81 });
    point(cv, 'dblclick', ax(7), ay(0));
    assert.equal(song.selected, auto.id);
    assert.equal(document.activeElement, elements.get('roll').children[1], 'automation clips focus the automation editor');
    assert.deepEqual([seq.viewState().top, seq.viewState().bottom], [1, 1]);
    seq.applyView({ top: 0.37, bottom: 0.81 });
    const count = song.clips.length;
    point(cv, 'dblclick', ax(13), ay(0));
    assert.equal(song.clips.length, count + 1, 'double-clicking empty space still creates a clip');
    assert.deepEqual([seq.viewState().top, seq.viewState().bottom], [0.37, 0.81], 'creating a clip does not maximize');
    // a new clip plays the module selected in the patcher, before the selected clip's module
    midi.target = 3;
    song.selected = midi.id;
    picked = 5;
    point(cv, 'dblclick', ax(19), ay(0));
    assert.equal(song.clips.find((c) => c.id === song.selected).target, 5, 'new clip -> the selected module');
    picked = null;
    song.selected = midi.id;
    point(cv, 'dblclick', ax(25), ay(0));
    assert.equal(song.clips.find((c) => c.id === song.selected).target, 3, 'no module chosen: the selected clip\'s module');
    seq.applyView({ top: 0.37, bottom: 0.81 });
    song.clips = [];
    song.selected = null;
    seq.reload(); flush();
  }

  // Each clip restores its editor camera, independently of project-global and other layer views.
  {
    const midi = addClip(song, { length: 128, y: 0 });
    const midi2 = addClip(song, { length: 128, y: 34 });
    const auto = addAutoClip(song, { length: 128, y: 68 });
    const auto2 = addAutoClip(song, { length: 128, y: 102 });
    const timeline = elements.get('arranger').children[0];
    const roll = elements.get('roll').children[0];
    const lane = elements.get('roll').children[1];
    song.selected = midi.id;
    seq.reload(); flush();
    seq.applyView({ arranger: { sx: 0, sy: 0, ppq: 16 } });
    const select = (c) => click(timeline, ax(1), ay(c.y));
    const wheel = (cv, props) => fire(cv, 'wheel', { clientX: 200, clientY: 200, deltaMode: 0, deltaY: 120, ...props });
    const beforeScroll = songChanges;
    wheel(roll, { shiftKey: true, deltaY: -120 });
    wheel(roll, { deltaY: 0, deltaX: 30 });
    wheel(roll, {});
    const midiView = structuredClone(midi.editorView);
    assert.ok(midiView.sy > -TOP_MARGIN);
    assert.ok(midiView.hz > 1, 'pitch zoom is remembered with horizontal scrolling');
    assert.ok(midiView.hx > 0);
    assert.equal(songChanges, beforeScroll, 'scroll saves without a musical edit or audio resync');
    select(midi2);
    assert.equal(seq.viewState().roll.sy, -TOP_MARGIN, 'new clip starts at the top');
    wheel(roll, { deltaY: 300 });
    click(roll, 464, 300);
    const midi2View = structuredClone(midi2.editorView);
    select(midi);
    assert.deepEqual(seq.viewState().roll, midiView, 'MIDI selection restores its own camera');
    select(midi2);
    assert.deepEqual(seq.viewState().roll, midi2View);
    select(auto);
    wheel(lane, { ctrlKey: true, deltaY: -100 });
    wheel(lane, { deltaY: 240 });
    const autoView = structuredClone(auto.editorView);
    select(auto2);
    assert.equal(seq.viewState().lane.sy, -TOP_MARGIN);
    wheel(lane, { deltaY: 500 });
    drag(lane, 464, 250, 464, 280);
    const auto2View = structuredClone(auto2.editorView);
    select(auto);
    assert.deepEqual(seq.viewState().lane, autoView, 'automation selection restores its own camera');
    point(timeline, 'dblclick', ax(1), ay(auto.y));
    assert.deepEqual(seq.viewState().lane, autoView, 'maximizing does not reset the clip camera');
    select(auto2);
    assert.deepEqual(seq.viewState().lane, auto2View);
    const saved = JSON.parse(JSON.stringify(song));
    engine.song = normalizeSong(saved);
    seq.reload(); flush();
    seq.applyView({ lane: { sy: 0, ppq: 12 }, roll: { sy: 0, ppq: 12 } });
    flush();
    assert.deepEqual(seq.viewState().lane, auto2View, 'clip camera wins over stale project-global view after reload');
    engine.song.selected = midi.id;
    seq.reload(); flush();
    assert.deepEqual(seq.viewState().roll, midiView, 'project reload restores a different clip too');
    const layer = emptySong();
    const nested = addClip(layer, { length: 128 });
    nested.id = midi.id;
    nested.editorView = { ...midiView, sy: 950 };
    layer.selected = nested.id;
    engine.song = layer;
    seq.setLayer(); flush();
    assert.equal(seq.viewState().roll.sy, 950, 'same clip ID in another layer has its own view');
    engine.song = song;
    song.selected = midi.id;
    seq.setLayer(); flush();
    assert.deepEqual(seq.viewState().roll, midiView, 'returning from a Patch restores the outer clip');
    assert.deepEqual(midi.notes, []);
    assert.deepEqual(auto.points, [], 'camera changes do not edit musical content');
    song.clips = [];
    song.selected = null;
    seq.reload(); flush();
  }

  // S no longer changes pane visibility; it is reserved for timeline splitting.
  seq.applyView({ top: 0.37, bottom: 0.81 });
  assert.equal(press('S').defaultPrevented, false);
  assert.equal(press('s').defaultPrevented, false);
  assert.equal(seq.viewState().top, 0.37);
  assert.equal(seq.viewState().bottom, 0.81);
  for (const props of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(press('s', props).defaultPrevented, false);
    assert.equal(seq.viewState().top, 0.37);
  }
  assert.equal(press('s', {}, new Element('input')).defaultPrevented, false);

  // Older side-by-side layouts migrate to the same relative pane areas.
  seq.applyView({ width: 0.5, split: 0.6 });
  assert.equal(seq.viewState().top, 0.3);
  assert.equal(seq.viewState().bottom, 0.8);
  assert.equal('width' in seq.viewState(), false);
  assert.equal('split' in seq.viewState(), false);
  seq.applyView({ open: false, width: 0.4, split: 0.5 });
  assert.equal(seq.viewState().top, 0);
  assert.equal(seq.viewState().bottom, 1);
  assert.equal(seq.viewState().restoreTop, 0.2);
  assert.equal(seq.viewState().restoreBottom, 0.8);
  seq.applyView({ width: 0, restoreWidth: 0.8, split: 0.5 });
  assert.equal(seq.viewState().restoreTop, 0.4);
  assert.equal(seq.viewState().restoreBottom, 0.6);
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
  // High-rate pointer input updates the model immediately but lays out only once per frame.
  {
    flush();
    const setProperty = workspace.style.setProperty;
    let writes = 0;
    workspace.style.setProperty = (name, value) => { writes++; setProperty(name, value); };
    const send = (type, y) => upper.dispatchEvent(Object.assign(new Event(type), {
      button: 0, buttons: type === 'pointermove' ? 1 : 0, pointerId: 1, clientX: 300, clientY: y,
    }));
    try {
      const before = viewChanges;
      const songsBefore = songChanges;
      point(upper, 'pointerdown', 300, 310);
      send('pointermove', 560);
      for (let i = 0; i < 100; i++) send('pointermove', 360 + i / 100);
      assert.equal(writes, 0, 'pointer moves do not synchronously relayout');
      near(seq.viewState().bottom, 0.9, 'the pushed boundary is retained when the pointer reverses');
      flush();
      assert.equal(writes, 3, 'one layout application for the whole pointer burst');
      assert.equal(workspace.style['--roll-fr'], `${seq.viewState().top}fr`);
      send('pointerup', 360);
      flush();
      assert.equal(writes, 3, 'release does not repeat an already painted layout');
      assert.equal(viewChanges, before + 1, 'coalesced dragging still saves once');
      assert.equal(songChanges, songsBefore, 'divider dragging does not serialize the playback song/model');

      for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        seq.applyView({ top: 0.4, bottom: 0.75 });
        flush();
        writes = 0;
        const changes = viewChanges;
        point(upper, 'pointerdown', 300, 310);
        send('pointermove', 360);
        send(end, 360);
        assert.equal(writes, 3, `${end} flushes the pending final layout before saving`);
        assert.equal(workspace.style['--roll-fr'], '0.5fr');
        assert.equal(viewChanges, changes + 1);
        flush();
        assert.equal(writes, 3, `${end} leaves no stale layout work`);
        send('pointermove', 410);
        flush();
        assert.equal(writes, 3, `${end} removes the move listener`);
      }
    } finally {
      workspace.style.setProperty = setProperty;
      seq.applyView({ top: 0.4, bottom: 0.75, panelWidth: 280 });
      flush();
    }
  }
  const changesBeforeStackDrag = viewChanges;
  drag(upper, 300, 310, 900, 310);
  assert.deepEqual(positions(), [0.4, 0.75], 'sideways motion cannot move either horizontal boundary');
  assert.equal(seq.viewState().panelWidth, 880, 'upper divider also controls the controller width');
  drag(upper, 300, 310, 300, 360);
  near(seq.viewState().top, 0.5);
  assert.equal(seq.viewState().bottom, 0.75);
  assert.equal(viewChanges, changesBeforeStackDrag + 2, 'save once per drag');

  // The field names (Clip:, Send to:, Input Grid:) on the upper divider drag it too; their fields do not.
  {
    const at = (target, type, y) => {
      const e = new Event(type, { cancelable: true });
      Object.assign(e, { button: 0, buttons: 1, pointerId: 1, clientX: 300, clientY: y });
      Object.defineProperty(e, 'target', { value: target });
      upper.dispatchEvent(e);
      return e;
    };
    const fieldName = { closest: (s) => (s === '.seq-grab' || s.includes('label') ? fieldName : null) };
    const field = { closest: (s) => (s === '.seq-grab' ? null : field) };
    const before = seq.viewState().top;
    at(field, 'pointerdown', 360);
    at(field, 'pointermove', 410);
    at(field, 'pointerup', 410);
    assert.equal(seq.viewState().top, before, 'the select / input does not drag');
    at(fieldName, 'pointerdown', 360);
    at(fieldName, 'pointermove', 410);
    at(fieldName, 'pointerup', 410);
    near(seq.viewState().top, before + 0.1);
    assert.equal(at(fieldName, 'click', 410).defaultPrevented, true, 'the click does not focus / open the field');
    assert.equal(at(field, 'click', 410).defaultPrevented, false);
    seq.applyView({ top: 0.5, bottom: 0.75 });
  }

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

  // Collapsing both sequencer panes by dragging is unaffected by S.
  seq.applyView({ top: 0.4, bottom: 0.75 });
  drag(upper, 300, 310, 300, -1000);
  drag(lower, 300, 510, 300, 1000);
  assert.deepEqual(positions(), [0, 1]);
  press('s');
  assert.deepEqual(positions(), [0, 1]);
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
  assert.equal(positions()[1], 1, 'S leaves collapsed panes unchanged');
  press('s');
  assert.deepEqual(positions(), [0, 1], 'repeated S presses leave the layout unchanged');
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
