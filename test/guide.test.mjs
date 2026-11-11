// Run: node test/guide.test.mjs   (the manual shown when nothing is selected)
import assert from 'node:assert/strict';
import { GUIDE, renderGuide } from '../src/guide.js';

assert.deepEqual(GUIDE.map((t) => t.id), ['interface', 'patcher', 'timeline', 'pianoroll', 'workspace'], 'Interface, patcher, TimeLine, piano roll, then workspace');
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
for (const topic of ['controller area', 'show this manual', 'Right-click a button', 'Learn keyboard shortcut', 'Restore default']) assert.ok(text('interface').includes(topic), `interface: ${topic}`);
for (const topic of ['Shift</kbd> + drag', 'Alt</kbd> + drag', 'Snap to Grid', 'F2', 'Save module', 'Input Module', 'Ctrl/Cmd</kbd> + <kbd>Z']) assert.ok(text('patcher').includes(topic), `patcher: ${topic}`);
for (const topic of ['Double right-click', '<b>Clip</b> field', 'Grid', 'Free timing', 'Automation editor', 'Piano roll:', 'TimeLine:', 'Save Clip']) assert.ok(text('timeline').includes(topic), `timeline: ${topic}`);
for (const topic of ['selection rectangle', 'end line', 'Velocity', 'Right-click empty space', 'hold the right mouse button', 'Q</kbd>', 'Left</kbd>']) assert.ok(text('pianoroll').includes(topic), `pianoroll: ${topic}`);
const patcherKeys = GUIDE.find((t) => t.id === 'patcher').keys;
assert.ok(patcherKeys.some(([keys, action]) => keys.includes('Shift</kbd> + drag empty canvas') && action === 'pan, zoom'), 'patcher: Shift-drag pans');
assert.ok(patcherKeys.some(([keys, action]) => keys.startsWith('drag empty canvas') && action === 'selection rectangle'), 'patcher: plain drag selects');
assert.ok(text('patcher').includes('zooms around the pointer on every platform'), 'patcher: wheel zoom is documented');

// rendered folded; a part opened stays open when the panel is rebuilt
{
  class Node extends EventTarget {
    constructor() { super(); this.children = []; this.dataset = {}; this.open = false; }
    append(...c) { this.children.push(...c); }
  }
  const doc = { createElement: () => new Node() };
  const parts = () => renderGuide(doc).children;
  assert.ok(parts().every((d) => d.open === false), 'folded by default');
  const first = parts();
  first[1].open = true;
  first[1].dispatchEvent(new Event('toggle'));
  assert.deepEqual(parts().map((d) => d.open), GUIDE.map((_, i) => i === 1), 'the opened part stays open');
  const again = parts();
  again[1].open = false;
  again[1].dispatchEvent(new Event('toggle'));
  assert.ok(parts().every((d) => d.open === false));
}
console.log('guide tests passed');
