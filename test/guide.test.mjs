// Run: node test/guide.test.mjs   (the tutorials shown when nothing is selected)
import assert from 'node:assert/strict';
import { GUIDE } from '../src/guide.js';

assert.deepEqual(GUIDE.map((t) => t.id), ['patcher', 'timeline', 'pianoroll', 'workspace'], 'patcher, TimeLine, piano roll, then workspace');
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
// topics the tutorials must cover
for (const topic of ['Shift</kbd> + drag', 'Alt</kbd> + drag', 'Snap to Grid', 'F2', 'Save module', 'Input Module', 'Ctrl/Cmd</kbd> + <kbd>Z']) assert.ok(text('patcher').includes(topic), `patcher: ${topic}`);
for (const topic of ['Double right-click', '<b>Clip</b> field', 'Grid', 'Free timing', 'Automation editor', 'Piano roll:', 'TimeLine:', 'Save Clip']) assert.ok(text('timeline').includes(topic), `timeline: ${topic}`);
for (const topic of ['selection rectangle', 'end line', 'Velocity', '250 ms', 'Q</kbd>', 'Left</kbd>']) assert.ok(text('pianoroll').includes(topic), `pianoroll: ${topic}`);
console.log('guide tests passed');
