import assert from 'node:assert/strict';
import { confirmDialog } from '../src/dialogs.js';
import { exitToOS } from '../src/exit.js';
import { createPersistence } from '../src/persist.js';

class Dialog extends EventTarget {
  open = false;
  showModal() { assert.equal(this.open, false); this.open = true; }
  close(value = '') { this.open = false; this.returnValue = value; this.dispatchEvent(new Event('close')); }
}
const dialog = new Dialog();
const elements = new Map(['confirm-title', 'confirm-text', 'confirm-ok', 'confirm-cancel'].map((id) => [id, { textContent: '' }]));
elements.set('confirm-dialog', dialog);
globalThis.document = { getElementById: (id) => elements.get(id) };
let closes = 0;
globalThis.window = { closed: false, close() { closes++; this.closed = true; } };
const messages = [];
const notify = (message) => messages.push(message);
let saves = 0;
const persist = { async flush() { saves++; return { local: true, disk: true }; } };
const key = (value, repeat = false) => {
  const e = new Event('keydown', { cancelable: true });
  Object.assign(e, { key: value, repeat });
  dialog.dispatchEvent(e);
  return e;
};

{
  const done = exitToOS(persist, notify);
  assert.equal(key('Escape', true).defaultPrevented, true);
  assert.equal(dialog.open, true, 'held Escape must not dismiss the newly opened prompt');
  assert.equal(key('Escape').defaultPrevented, true);
  await done;
  assert.equal(saves, 0, 'Escape means No');
  assert.equal(closes, 0);
  assert.equal(key('Enter').defaultPrevented, false, 'exit key handler is removed after cancellation');
}
{
  const done = exitToOS(persist, notify);
  assert.equal(key('Enter', true).defaultPrevented, true);
  assert.equal(dialog.open, true, 'held Enter cannot confirm accidentally');
  assert.equal(key('Enter').defaultPrevented, true);
  await done;
  assert.equal(saves, 1, 'Enter means Yes and autosaves');
  assert.equal(closes, 1);
  assert.equal(key('Enter').defaultPrevented, false, 'exit handler is removed after confirmation');
  saves = 0;
  closes = 0;
  window.closed = false;
}

for (const cancel of ['cancel', '']) {
  const done = exitToOS(persist, notify);
  assert.equal(elements.get('confirm-title').textContent, 'Exit to OS?');
  assert.equal(elements.get('confirm-ok').textContent, 'Yes');
  assert.equal(elements.get('confirm-cancel').textContent, 'No');
  await exitToOS(persist, notify); // repeated requests must not reopen an active dialog
  dialog.close(cancel);
  await done;
  assert.equal(saves, 0);
  assert.equal(closes, 0);
}
{
  let finishSave;
  const done = exitToOS({ flush: () => new Promise((resolve) => { finishSave = resolve; }) }, notify);
  dialog.close('ok');
  await Promise.resolve();
  assert.equal(closes, 0, 'waits for autosave');
  await exitToOS(persist, notify);
  assert.equal(dialog.open, false, 'no second exit prompt while saving');
  finishSave({ local: true, disk: false });
  await done;
  assert.equal(closes, 1, 'browser storage is sufficient when no disk server exists');
  assert.deepEqual(messages, []);
}
{
  const done = exitToOS({ flush: async () => ({ local: false, disk: false }) }, notify);
  dialog.close('ok');
  await done;
  assert.equal(closes, 1, 'failed autosave prevents closing');
  assert.match(messages.pop(), /autosave failed/);
}
{
  window.closed = false;
  window.close = () => { closes++; };
  const done = exitToOS(persist, notify);
  dialog.close('ok');
  await done;
  assert.match(messages.pop(), /Close the tab or window manually/, 'blocked browser close is explained');
}
{
  const done = confirmDialog('Other confirmation');
  assert.equal(elements.get('confirm-ok').textContent, 'OK');
  assert.equal(elements.get('confirm-cancel').textContent, 'Cancel', 'existing dialogs retain their default labels');
  dialog.close('cancel');
  assert.equal(await done, false);
}

// The real persistence layer reports its save outcome without changing notifications.
for (const local of [false, true]) for (const disk of [false, true]) {
  globalThis.localStorage = { setItem() { if (!local) throw new Error('Storage unavailable'); } };
  globalThis.fetch = async () => ({ ok: disk });
  let notification;
  const p = createPersistence({ getState: () => ({ format: 'modsynth' }), onSaved: (r) => { notification = r; } });
  const result = await p.flush();
  assert.deepEqual(result, { local, disk, at: result.at });
  assert.deepEqual(result, notification);
}
console.log('exit confirmation tests passed');
