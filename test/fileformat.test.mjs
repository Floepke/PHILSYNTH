import assert from 'node:assert/strict';
import { PROJECT_FORMAT, MODULE_FORMAT, CLIP_FORMAT, isFormat, isProject, PROJECT_EXT, MODULE_EXT, PROJECT_OPEN_EXTS, MODULE_OPEN_EXTS } from '../src/fileformat.js';
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

console.log('file format tests passed');
