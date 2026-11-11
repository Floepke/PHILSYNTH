import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreferencesManager, parsePreferences, preferencesStorage, PREFERENCES_KEY, PREFERENCES_FORMAT } from '../src/preferences.js';
import { migrateWoodTint, WOOD_TINT_ID, WOOD_TINT_KEY } from '../src/woodtheme.js';
import { registerPreferences, launchFullscreen, showLaunchWindow } from '../electron/preferences.mjs';
import { atomicWrite } from '../electron/atomicwrite.mjs';
import { registerInterfacePreferences, PANEL_DIVIDER_WIDTH_ID, LAUNCH_FULLSCREEN_ID } from '../src/interfacepreferences.js';
import { registerMidiPreferences, migrateMidiInput, MIDI_INPUT_ID } from '../src/midipreferences.js';
import { registerPianorollPreferences, SNAP_VELOCITY_ID } from '../src/pianorollpreferences.js';
import { registerPatcherPreferences, SPECTRUM_FLOW_ID, SPECTRUM_SIZE_ID } from '../src/patcherpreferences.js';

{
  let stored = null;
  let redraws = 0;
  const manager = createPreferencesManager({ storage: { load: async () => stored, save: async text => { stored = text; } } });
  const settings = registerPatcherPreferences(manager, () => redraws++);
  await manager.load();
  assert.equal(settings.spectrumFlowDirection, 'down');
  assert.equal(settings.spectrumSize, 4096);
  manager.preview(SPECTRUM_SIZE_ID, '8192');
  assert.equal(settings.spectrumSize, 8192);
  manager.restore();
  assert.equal(settings.spectrumSize, 4096);
  assert.equal(manager.entries()[0].category, 'Patcher');
  const before = redraws;
  manager.preview(SPECTRUM_FLOW_ID, 'up');
  assert.equal(settings.spectrumFlowDirection, 'up');
  assert.equal(redraws, before + 1);
  manager.restore();
  assert.equal(settings.spectrumFlowDirection, 'down', 'Cancel restores the saved flow direction');
  await manager.save({ [SPECTRUM_FLOW_ID]: 'up', [SPECTRUM_SIZE_ID]: '16384' });
  const reloaded = createPreferencesManager({ storage: { load: async () => stored } });
  const restored = registerPatcherPreferences(reloaded);
  await reloaded.load();
  assert.equal(restored.spectrumFlowDirection, 'up', 'flow direction persists across sessions');
  assert.equal(restored.spectrumSize, 16384, 'FFT size persists across sessions');
  assert.throws(() => manager.preview(SPECTRUM_FLOW_ID, 'left'), /Invalid value/);
  assert.throws(() => manager.preview(SPECTRUM_SIZE_ID, '4048'), /Invalid value/);
}

{
  let stored = null;
  let redraws = 0;
  const manager = createPreferencesManager({ storage: { load: async () => stored, save: async (text) => { stored = text; } } });
  const settings = registerPianorollPreferences(manager, () => redraws++);
  await manager.load();
  assert.equal(settings.snapVelocity, true);
  assert.equal(manager.entries()[0].category, 'Pianoroll');
  assert.equal(manager.entries()[0].label, 'Snap velocity values to 16 step grid.');
  const before = redraws;
  manager.preview(SNAP_VELOCITY_ID, false);
  assert.equal(settings.snapVelocity, false);
  assert.equal(redraws, before + 1);
  manager.restore();
  assert.equal(settings.snapVelocity, true, 'Cancel restores velocity snapping');
  await manager.save({ [SNAP_VELOCITY_ID]: false });
  const reloaded = createPreferencesManager({ storage: { load: async () => stored } });
  const restored = registerPianorollPreferences(reloaded);
  await reloaded.load();
  assert.equal(restored.snapVelocity, false, 'velocity snapping persists across sessions');
  await assert.rejects(manager.save({ [SNAP_VELOCITY_ID]: 0 }), /Invalid value/);
}

{
  let stored = null;
  let selected = 'auto';
  let inputs = [{ name: 'Keyboard' }];
  let selections = 0;
  const midi = { selected: () => selected, select: value => { selected = value; selections++; }, inputs: () => inputs, enable: async () => true };
  const manager = createPreferencesManager({ storage: { load: async () => stored, save: async text => { stored = text; } } });
  registerMidiPreferences(manager, () => midi);
  await manager.load();
  await migrateMidiInput(manager, { getItem: () => 'Disconnected Controller' });
  assert.equal(manager.get(MIDI_INPUT_ID), 'Disconnected Controller', 'legacy device selection migrates into JSON');
  const item = manager.entries()[0];
  assert.equal(item.options(manager.get(MIDI_INPUT_ID)).at(-1).label, 'Disconnected Controller (not connected)');
  manager.preview(MIDI_INPUT_ID, 'Keyboard');
  assert.equal(selected, 'Keyboard');
  manager.restore();
  assert.equal(selected, 'Disconnected Controller', 'Cancel restores the stored device');
  const count = selections;
  manager.restore();
  assert.equal(selections, count, 'unchanged preferences do not release held MIDI notes');
  await manager.save({ [MIDI_INPUT_ID]: 'Keyboard' });
  assert.equal(parsePreferences(stored)[MIDI_INPUT_ID], 'Keyboard');
  await migrateMidiInput(manager, { getItem: () => 'Old Controller' });
  assert.equal(manager.get(MIDI_INPUT_ID), 'Keyboard', 'JSON takes precedence over legacy storage');
  inputs = [{ name: 'New Keyboard' }];
  await item.refresh();
  assert.equal(item.options('Keyboard')[1].value, 'New Keyboard');
  midi.enable = async () => false;
  await assert.rejects(item.refresh(), /MIDI access is unavailable/);
  await assert.rejects(manager.save({ [MIDI_INPUT_ID]: 7 }), /Invalid value/);
}

const fileText = (values) => JSON.stringify({ format: PREFERENCES_FORMAT, version: 1, values });
const color = { id: WOOD_TINT_ID, label: 'Wood Tint', category: 'Interface', type: 'color', defaultValue: '#290000' };
{
  const properties = new Map();
  globalThis.document = { documentElement: { style: { setProperty: (key, value) => properties.set(key, value) } } };
  const manager = createPreferencesManager({ storage: { load: async () => null, save: async () => {} } });
  registerInterfacePreferences(manager);
  await manager.load();
  assert.equal(manager.get(LAUNCH_FULLSCREEN_ID), true);
  await manager.save({ [LAUNCH_FULLSCREEN_ID]: false });
  assert.equal(manager.get(LAUNCH_FULLSCREEN_ID), false);
  await assert.rejects(manager.save({ [LAUNCH_FULLSCREEN_ID]: 'false' }), /Invalid value/);
  assert.equal(properties.get('--panel-divider-width'), '48px');
  manager.preview(PANEL_DIVIDER_WIDTH_ID, 10);
  assert.equal(properties.get('--panel-divider-width'), '10px');
  manager.restore();
  assert.equal(properties.get('--panel-divider-width'), '48px');
  await manager.save({ [PANEL_DIVIDER_WIDTH_ID]: 16 });
  assert.equal(properties.get('--panel-divider-width'), '16px');
  for (const width of [9, 129, 10.5, '16']) await assert.rejects(manager.save({ [PANEL_DIVIDER_WIDTH_ID]: width }), /Invalid value/);
  assert.deepEqual([...properties.keys()], ['--panel-divider-width'], 'other divider sizes are untouched');
  delete globalThis.document;
}
function setup(text = null) {
  const applied = [];
  let saved = text;
  let fail = false;
  const storage = { load: async () => saved, save: async (next) => {
    if (fail) throw new Error('Disk full');
    saved = next;
  } };
  const manager = createPreferencesManager({ storage });
  manager.register({ ...color, apply: (value) => applied.push(value) });
  return { manager, applied, text: () => saved, fail: () => { fail = true; } };
}
{
  const { manager, applied, text, fail } = setup(fileText({ [WOOD_TINT_ID]: '#123456', 'future.option': { keep: true } }));
  await manager.load();
  assert.equal(manager.get(WOOD_TINT_ID), '#123456');
  manager.preview(WOOD_TINT_ID, '#4080c0');
  assert.equal(applied.at(-1), '#4080c0');
  assert.equal(manager.get(WOOD_TINT_ID), '#123456', 'preview does not commit');
  manager.restore();
  assert.equal(applied.at(-1), '#123456', 'cancel restores');
  await manager.save({ [WOOD_TINT_ID]: '#4080c0' });
  assert.equal(parsePreferences(text())[WOOD_TINT_ID], '#4080c0');
  assert.deepEqual(parsePreferences(text())['future.option'], { keep: true }, 'unknown settings survive');
  fail();
  await assert.rejects(manager.save({ [WOOD_TINT_ID]: '#ffffff' }), /Disk full/);
  assert.equal(manager.get(WOOD_TINT_ID), '#4080c0', 'failed writes never commit');
  assert.throws(() => manager.register(color), /already registered/);
  assert.throws(() => manager.get('missing'), /Unknown preference/);
  assert.throws(() => manager.preview(WOOD_TINT_ID, 'red'), /Invalid value/);
  await assert.rejects(manager.save({ missing: true }), /Unknown preference/);
  await assert.rejects(manager.load(), /already been loaded/);
}
{
  const { manager } = setup();
  manager.register({ id: 'audio.enabled', category: 'Audio', label: 'Enabled', type: 'boolean', defaultValue: true });
  manager.register({ id: 'audio.level', category: 'Audio', label: 'Level', type: 'number', min: 0, max: 1, defaultValue: 0.5 });
  manager.register({ id: 'audio.device', category: 'Audio', label: 'Device', type: 'select', defaultValue: 'auto', options: [{ value: 'auto', label: 'Automatic' }] });
  await manager.load();
  await manager.save({ 'audio.enabled': false, 'audio.level': 1, 'audio.device': 'auto' });
  assert.equal(manager.get('audio.enabled'), false);
  await assert.rejects(manager.save({ 'audio.level': 2 }), /Invalid value/);
  await assert.rejects(manager.save({ 'audio.enabled': 'yes' }), /Invalid value/);
  await assert.rejects(manager.save({ 'audio.device': 'missing' }), /Invalid value/);
  assert.throws(() => manager.register({ ...color, id: 'bad', type: 'number' }), /min and max/);
  assert.throws(() => manager.register({ ...color, id: 'bad', type: 'select' }), /string options/);
  assert.throws(() => manager.register({ ...color, id: 'bad', defaultValue: 'invalid' }), /Invalid value/);
}
for (const text of ['{', fileText({ [WOOD_TINT_ID]: 'invalid' }), JSON.stringify({ version: 2 }), JSON.stringify({ format: PREFERENCES_FORMAT, version: 1, values: [] })]) {
  const { manager, text: stored } = setup(text);
  await assert.rejects(manager.load());
  assert.equal(manager.get(WOOD_TINT_ID), color.defaultValue);
  assert.equal(stored(), text, 'corrupt input is not overwritten on load');
}
{
  let finish;
  const manager = createPreferencesManager({ storage: {
    load: async () => fileText({ 'late.enabled': false }),
    save: () => new Promise((resolve) => { finish = resolve; }),
  } });
  manager.register(color);
  await manager.load();
  manager.register({ id: 'late.enabled', category: 'Late', label: 'Enabled', type: 'boolean', defaultValue: true });
  assert.equal(manager.get('late.enabled'), false, 'late registration uses already-loaded values');
  const pending = manager.save({ [WOOD_TINT_ID]: '#abcdef' });
  await assert.rejects(manager.save({ [WOOD_TINT_ID]: '#ffffff' }), /already being saved/);
  finish();
  await pending;
  assert.equal(manager.get(WOOD_TINT_ID), '#abcdef', 'concurrent saves cannot lose a committed change');
}
{
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const storage = preferencesStorage();
  await storage.save(fileText({ test: true }));
  assert.equal(await storage.load(), values.get(PREFERENCES_KEY), 'browser uses a single JSON document');
  values.set(WOOD_TINT_KEY, '#ABCDEF');
  const { manager, text } = setup();
  await manager.load();
  await migrateWoodTint(manager);
  assert.equal(manager.get(WOOD_TINT_ID), '#abcdef', 'legacy tint is normalized and migrated');
  assert.equal(parsePreferences(text())[WOOD_TINT_ID], '#abcdef');
  values.set(WOOD_TINT_KEY, '#000000');
  await migrateWoodTint(manager);
  assert.equal(manager.get(WOOD_TINT_ID), '#abcdef', 'JSON takes precedence over legacy storage');
  const fresh = setup();
  await fresh.manager.load();
  values.set(WOOD_TINT_KEY, 'invalid');
  await assert.rejects(migrateWoodTint(fresh.manager), /invalid/);
  globalThis.modsynthPreferences = { load: async () => 'native', save: async (text) => values.set('native', text) };
  assert.equal(await preferencesStorage().load(), 'native', 'desktop selects the native JSON file backend');
  await preferencesStorage().save('native saved');
  assert.equal(values.get('native'), 'native saved');
  delete globalThis.modsynthPreferences;
  delete globalThis.localStorage;
}
{
  const dir = await mkdtemp(join(tmpdir(), 'philsynth-preferences-'));
  try {
    const handlers = new Map();
    const file = join(dir, 'preferences.json');
    registerPreferences({ handle: (name, fn) => handlers.set(name, fn) }, file, (url) => url === 'http://localhost/');
    const event = { senderFrame: { url: 'http://localhost/' } };
    const load = () => handlers.get('preferences:load')(event);
    const save = (text) => handlers.get('preferences:save')(event, text);
    assert.equal(await load(), null);
    assert.equal(await launchFullscreen(file), true, 'missing file preserves fullscreen launch');
    await save(fileText({}));
    assert.equal(await launchFullscreen(file), true, 'older preferences preserve fullscreen launch');
    for (const fullscreen of [true, false]) {
      await save(fileText({ [LAUNCH_FULLSCREEN_ID]: fullscreen }));
      assert.equal(await launchFullscreen(file), fullscreen, 'launch reads the saved JSON checkbox');
      const calls = [];
      showLaunchWindow({
        setFullScreen: (value) => calls.push(['fullscreen', value]),
        maximize: () => calls.push(['maximize']),
        show: () => calls.push(['show']),
      }, await launchFullscreen(file));
      assert.deepEqual(calls, fullscreen ? [['fullscreen', true], ['show']] : [['maximize'], ['show']], 'launch applies the requested mode before showing');
    }
    await save(fileText({ [LAUNCH_FULLSCREEN_ID]: 'false' }));
    await assert.rejects(launchFullscreen(file), /Invalid Launch/);
    await save(fileText({ [WOOD_TINT_ID]: '#4080c0' }));
    assert.equal(await load(), await readFile(file, 'utf8'));
    assert.deepEqual(await readdir(dir), ['preferences.json'], 'atomic writes leave no temporary files');
    await assert.rejects(save('bad json'));
    await assert.rejects(save('x'.repeat(1024 * 1024 + 1)), /Invalid preferences/);
    await assert.rejects(handlers.get('preferences:load')({ senderFrame: { url: 'https://untrusted.test/' } }), /Untrusted/);
    await assert.rejects(handlers.get('preferences:save')({}, fileText({})), /Untrusted/);
    const before = await readFile(file, 'utf8');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(atomicWrite(file, 'replacement', { signal: controller.signal }), /abort/i);
    assert.equal(await readFile(file, 'utf8'), before, 'aborted atomic writes preserve the original file');
    assert.deepEqual(await readdir(dir), ['preferences.json']);
    await writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(load(), /too large/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log('preferences tests passed');
