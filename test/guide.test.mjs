// Run: node test/guide.test.mjs   (the manual shown when nothing is selected)
import assert from 'node:assert/strict';
import { GUIDE, renderGuide, createGuideState } from '../src/guide.js';

assert.deepEqual(GUIDE.map((t) => t.id), ['about', 'interface', 'patcher', 'pianoroll-concept', 'timeline', 'automation', 'workspace'], 'Author introduction, interface, patcher, the pianoroll concept, combined pianoroll and timeline, automation, then workspace');
assert.equal(GUIDE.find((t) => t.id === 'timeline').title, 'Pianoroll and Timeline');
assert.equal(GUIDE.find((t) => t.id === 'automation').title, 'Automation');
for (const t of GUIDE) {
  assert.ok(t.title && t.intro, t.id);
  assert.ok(t.steps.length >= 1, t.id);
  for (const s of t.steps) assert.ok(s.title && s.items.length && s.items.every((i) => typeof i === 'string' && i.length > 20), `${t.id}: ${s.title}`);
  for (const [keys, action] of t.keys) assert.ok(keys && action, t.id);
  const html = JSON.stringify(t);
  assert.equal((html.match(/<kbd>/g) ?? []).length, (html.match(/<\/kbd>/g) ?? []).length, `${t.id}: balanced kbd tags`);
  assert.equal((html.match(/<b>/g) ?? []).length, (html.match(/<\/b>/g) ?? []).length, `${t.id}: balanced b tags`);
}
const text = (id) => JSON.stringify(GUIDE.find((t) => t.id === id));
// topics the manual must cover
for (const topic of ['MULTIMIDI', 'micropitch', 'pitch bends', 'velocity fading', 'sound colour', 'Klavarskribo', 'MPE', 'ten years', 'SunVox', 'Alexander Zolotov', 'modern development tools']) assert.ok(text('about').includes(topic), `about: ${topic}`);
for (const topic of ['controller area', 'show this manual', 'Right-click a button', 'Learn keyboard shortcut', 'Restore default']) assert.ok(text('interface').includes(topic), `interface: ${topic}`);
for (const topic of ['Shift</kbd> + drag', 'Alt</kbd> + drag', 'Snap to Grid', 'F2', 'Save module', 'Input Module', 'Ctrl/Cmd</kbd> + <kbd>Z']) assert.ok(text('patcher').includes(topic), `patcher: ${topic}`);
for (const topic of ['<b>Clip</b> field', 'Grid', 'Free timing', 'Piano roll:', 'TimeLine:', 'Save Clip', 'selection rectangle', 'end line', 'velocity', 'Right-click empty space', 'hold the right mouse button', 'Q</kbd>', 'Left</kbd>', 'Play and record']) assert.ok(text('timeline').includes(topic), `timeline: ${topic}`);
for (const topic of ['Double right-click', 'Send to', 'Controller', 'Double-click', 'rounds its corner', 'Free timing', 'keep snapping', 'keeps the last value', 'Automation goes first', 'Pianoroll and Timeline']) assert.ok(text('automation').includes(topic), `automation: ${topic}`);
const patcherKeys = GUIDE.find((t) => t.id === 'patcher').keys;
assert.ok(patcherKeys.some(([keys, action]) => keys.includes('Shift</kbd> + drag empty canvas') && action === 'pan, zoom'), 'patcher: Shift-drag pans');
assert.ok(patcherKeys.some(([keys, action]) => keys.startsWith('drag empty canvas') && action === 'selection rectangle'), 'patcher: plain drag selects');
assert.ok(text('patcher').includes('zooms around the pointer on every platform'), 'patcher: wheel zoom is documented');

// Reading state survives panel rebuilds and a new app session.
{
  let saved = null;
  const storage = { load: () => saved, save: (text) => { saved = text; } };
  const state = createGuideState(storage);
  class Node extends EventTarget {
    constructor() { super(); this.children = []; this.dataset = {}; this.open = false; }
    append(...c) { this.children.push(...c); }
  }
  const doc = { createElement: () => new Node() };
  const parts = () => renderGuide(doc, state).children;
  assert.ok(parts().every((d) => d.open === false), 'folded by default');
  const first = parts();
  first[1].open = true;
  first[1].dispatchEvent(new Event('toggle'));
  state.setScrollTop(742);
  const restored = createGuideState(storage);
  assert.equal(restored.scrollTop, 742, 'reading position survives a new session');
  assert.deepEqual(renderGuide(doc, restored).children.map((d) => d.open), GUIDE.map((_, i) => i === 1), 'chapter state survives a new session');
  assert.deepEqual(parts().map((d) => d.open), GUIDE.map((_, i) => i === 1), 'the opened part stays open');
  const again = parts();
  again[1].open = false;
  again[1].dispatchEvent(new Event('toggle'));
  assert.ok(parts().every((d) => d.open === false));
  assert.equal(createGuideState(storage).isOpen(GUIDE[1].id), false, 'closed chapters are persisted too');
  state.setScrollTop(0);
  assert.equal(createGuideState(storage).scrollTop, 0, 'returning to the top is persisted');
}
{
  const errors = [];
  const state = createGuideState({
    load: () => '{"opened":[],"scrollTop":-1}',
    save: () => { throw new Error('Storage unavailable'); },
    onError: (error) => errors.push(error.message),
  });
  assert.equal(state.scrollTop, 0, 'invalid stored state starts at the top');
  assert.equal(errors.length, 1, 'invalid stored state is reported');
  state.setOpen('about', true);
  state.setScrollTop(100);
  assert.equal(state.isOpen('about'), true, 'chapter state stays usable when storage fails');
  assert.equal(state.scrollTop, 100, 'scroll state stays usable when storage fails');
  assert.deepEqual(errors.slice(1), ['Storage unavailable', 'Storage unavailable'], 'storage failures are reported');
  assert.throws(() => state.setScrollTop(NaN), /Invalid manual scroll position/);
}
console.log('guide tests passed');
