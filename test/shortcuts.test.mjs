import assert from 'node:assert/strict';
import {
  keyCombination, parseShortcut, formatShortcut, validShortcutBindings, createShortcutRegistry,
  registerShortcutMenu, shortcutRegistry, registerShortcutPreferences, SHORTCUTS_ID, menuActionId,
} from '../src/shortcuts.js';
import { createPreferencesManager, parsePreferences } from '../src/preferences.js';

const key = (key, props = {}) => ({ key, ...props });
assert.equal(keyCombination(key('A', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+a');
assert.equal(keyCombination(key('ArrowRight', { shiftKey: true })), 'Shift+ArrowRight');
assert.equal(keyCombination(key(' ', {})), 'Space');
assert.equal(keyCombination(key('+', { shiftKey: true })), 'Shift+Plus');
assert.equal(keyCombination(key('Control')), null);
assert.equal(keyCombination(key('Dead')), null);
assert.equal(keyCombination(key('a', { isComposing: true })), null);
assert.equal(keyCombination(key('a', { getModifierState: () => true })), null, 'AltGr is text input');
assert.equal(parseShortcut('⌘⇧S'), 'Shift+Meta+s');
assert.equal(parseShortcut('Ctrl+Shift+A'), 'Ctrl+Shift+a');
assert.equal(parseShortcut('⇧→'), 'Shift+ArrowRight');
assert.equal(parseShortcut('⌫'), 'Backspace');
assert.equal(formatShortcut('Ctrl+Shift+a'), 'Ctrl+Shift+A');
assert.equal(validShortcutBindings({ 'global/save': 'Ctrl+Shift+a' }), true);
for (const value of [null, [], { save: 2 }, { save: 'Ctrl+A' }, { save: 'Escape' }, { save: 'Ctrl+Tab' }]) {
  assert.equal(validShortcutBindings(value), false, JSON.stringify(value));
}
assert.equal(menuActionId('piano', { id: 'quantize', label: 'Quantize all notes' }), 'piano/quantize');

{
  const registry = createShortcutRegistry();
  let editor = 'piano';
  let selection = 'first';
  const seen = [];
  registry.register('menus', () => [
    { id: 'piano/copy', scope: 'piano', label: 'Copy notes', keys: ['Ctrl+c'], active: () => editor === 'piano', run: () => seen.push(selection) },
    { id: 'timeline/copy', scope: 'timeline', label: 'Copy clips', keys: ['Ctrl+c'], active: () => editor === 'timeline' },
    { id: 'global/save', scope: 'global', label: 'Save', keys: ['Ctrl+s'], active: () => true, allowTyping: true },
    { id: 'picker/rename', scope: 'picker', label: 'Rename file', keys: ['F2'], active: () => true, dialog: 'file-dialog' },
  ]);
  const action = registry.actions()[0];
  assert.equal(registry.conflict(action, 'Ctrl+c'), undefined, 'different focused editors may share shortcuts');
  assert.equal(registry.conflict(action, 'Ctrl+s').id, 'global/save', 'global shortcuts conflict in every editor');
  assert.equal(registry.resolve('Ctrl+c').action.id, 'piano/copy');
  registry.setBindings({ 'piano/copy': 'Alt+c' });
  assert.deepEqual(registry.resolve('Ctrl+c'), { action: null, handled: true }, 'old default is suppressed');
  selection = 'second';
  registry.resolve('Alt+c').action.run();
  assert.deepEqual(seen, ['second'], 'callbacks resolve the current selection');
  editor = 'timeline';
  assert.equal(registry.resolve('Ctrl+c').action.id, 'timeline/copy', 'other editor defaults remain intact');
  assert.equal(registry.resolve('Alt+c').handled, false, 'inactive editor shortcuts do not run');
  assert.equal(registry.resolve('Ctrl+c', { typing: true }).handled, false);
  assert.equal(registry.resolve('Ctrl+s', { typing: true }).action.id, 'global/save');
  registry.setBindings({ 'global/save': 's' });
  assert.equal(registry.resolve('s', { typing: true }).handled, false, 'custom plain keys never interrupt typing');
  assert.equal(registry.resolve('s', { dialog: 'file-dialog' }).handled, false, 'global actions stay out of modals');
  registry.setBindings({ 'global/save': 'Shift+Meta+s' });
  assert.equal(registry.resolve('Shift+Meta+s', { typing: true }).action.id, 'global/save', 'Cmd+Shift shortcuts work while typing too');
  assert.equal(registry.resolve('F2', { dialog: 'file-dialog' }).action.id, 'picker/rename');
  assert.equal(registry.resolve('F2', { dialog: 'confirm-dialog' }).handled, false);
  registry.setBindings({});
  assert.equal(registry.resolve('Ctrl+s').action.id, 'global/save', 'reset restores defaults');
  registry.setBindings({ 'timeline/not-currently-visible': 'Ctrl+k' });
  assert.equal(registry.conflict({ id: 'global/other', scope: 'global' }, 'Ctrl+k').id, 'timeline/not-currently-visible',
    'stored shortcuts remain reserved even while their contextual action is unavailable');
  assert.throws(() => registry.setBindings({ bad: 'Escape' }), /Invalid keyboard/);
}

{
  let label = 'Quantize all notes';
  let enabled = false;
  let selected = 'first';
  const seen = [];
  const dispose = registerShortcutMenu('test-editor', () => [
    { id: 'quantize', label, shortcut: 'Q', disabled: !enabled, action: () => seen.push(selected) },
    { label: 'Export', children: [{ label: 'Audio', shortcut: 'Ctrl+E', action() {} }] },
    { label: 'Delete', shortcuts: ['Backspace', 'Delete'], action() {} },
  ]);
  let action = shortcutRegistry.actions().find((a) => a.id === 'test-editor/quantize');
  assert.equal(action.enabled(), false);
  enabled = true;
  label = 'Quantize selection';
  selected = 'second';
  action = shortcutRegistry.actions().find((a) => a.id === 'test-editor/quantize');
  assert.equal(action.label, label);
  assert.equal(action.enabled(), true, 'disabled state is recalculated, not captured from an old menu');
  action.run();
  assert.deepEqual(seen, ['second']);
  assert.equal(shortcutRegistry.actions().find((a) => a.id === 'test-editor/export/audio').keys[0], 'Ctrl+e');
  assert.ok(shortcutRegistry.actions().find((a) => a.id === 'test-editor/export/audio').keys.includes('Meta+e'),
    'both existing Ctrl and Cmd aliases are represented');
  assert.deepEqual(shortcutRegistry.actions().find((a) => a.id === 'test-editor/delete').keys, ['Backspace', 'Delete']);
  dispose();
  assert.equal(shortcutRegistry.actions().length, 0);
}

{
  let stored = null;
  let fail = false;
  const storage = {
    load: async () => stored,
    save: async (text) => { if (fail) throw new Error('Disk full'); stored = text; },
  };
  const preferences = createPreferencesManager({ storage });
  registerShortcutPreferences(preferences);
  await preferences.load();
  await preferences.save({ [SHORTCUTS_ID]: { 'global/save': 'Ctrl+k' } });
  assert.deepEqual(parsePreferences(stored)[SHORTCUTS_ID], { 'global/save': 'Ctrl+k' });
  const reloaded = createPreferencesManager({ storage });
  registerShortcutPreferences(reloaded);
  await reloaded.load();
  assert.equal(shortcutRegistry.label('global/save'), 'Ctrl+K', 'saved mappings survive restart');
  fail = true;
  await assert.rejects(reloaded.save({ [SHORTCUTS_ID]: {} }), /Disk full/);
  assert.equal(shortcutRegistry.label('global/save'), 'Ctrl+K', 'failed saves do not change mappings');
  preferences.preview(SHORTCUTS_ID, {});
  assert.deepEqual(shortcutRegistry.bindings(), {});
  preferences.restore();
  assert.equal(shortcutRegistry.label('global/save'), 'Ctrl+K', 'Cancel restores the stored bindings');
  await assert.rejects(preferences.save({ [SHORTCUTS_ID]: { bad: 'Escape' } }), /Invalid value/);
  shortcutRegistry.setBindings({});
}
console.log('keyboard shortcut tests passed');
