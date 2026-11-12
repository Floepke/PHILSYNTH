import assert from 'node:assert/strict';
import { PROJECT_FORMAT, MODULE_FORMAT, CLIP_FORMAT, isFormat, isProject, jsonFileText, PROJECT_EXT, MODULE_EXT, PROJECT_OPEN_EXTS, MODULE_OPEN_EXTS, fileAccept } from '../src/fileformat.js';
import { KINDS } from '../src/filedialog.js';

assert.equal(PROJECT_FORMAT, 'philsynth');
assert.ok(isProject({ format: 'philsynth' }));
assert.ok(isProject({ format: 'modsynth' }), 'projects from before the rename open');
assert.ok(!isProject({ format: 'philsynth-clip' }));
assert.ok(!isProject(null));
assert.ok(isFormat('modsynth-module', MODULE_FORMAT));
assert.ok(isFormat('modsynth-clip', CLIP_FORMAT));
assert.ok(!isFormat('modsynth-clip', MODULE_FORMAT));

assert.equal(PROJECT_EXT, '.phproject');
assert.equal(MODULE_EXT, '.phmod');
assert.deepEqual(PROJECT_OPEN_EXTS, ['.phproject', '.mds', '.json']);
assert.deepEqual(MODULE_OPEN_EXTS, ['.phmod', '.synth']);

// browser dialogs: save new extensions, open old ones too
assert.deepEqual(KINDS.module.open, ['.phmod', '.synth']);
assert.equal(KINDS.module.ext, '.phmod');
assert.deepEqual(KINDS.clip.open, ['.clip']);

for (const format of [PROJECT_FORMAT, MODULE_FORMAT, CLIP_FORMAT]) {
  const data = { format, name: 'A "name"\nwith spaces', nested: [{ text: 'a  b', values: [0, 1, null] }] };
  const text = jsonFileText(data);
  assert.equal(text, JSON.stringify(data), `${format}: compact JSON`);
  assert.ok(!text.includes('\n'), `${format}: one physical line`);
  assert.deepEqual(JSON.parse(text), data, `${format}: content round-trips`);
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(data, null, 2)), `${format}: less disk space`);
}

// iOS greys out unknown extensions (.phproject) in a filtered file input: there the input lists all files.
{
  const exts = ['.phproject', '.mds'];
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', platform: 'iPhone', maxTouchPoints: 5 };
  const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };
  assert.equal(fileAccept(exts, iphone), '');
  assert.equal(fileAccept(exts, ipad), '', 'iPadOS reports a Mac with touch');
  assert.equal(fileAccept(exts, mac), '.phproject,.mds');
  assert.equal(fileAccept(exts, undefined), '.phproject,.mds');
}

console.log('file format tests passed');
