import assert from 'node:assert/strict';
import { kdirNotifyArgs, notifyFolderChanged } from '../electron/kdirnotify.mjs';

assert.deepEqual(kdirNotifyArgs('/home/me/My Music'),
  ['--session', '--type=signal', '/', 'org.kde.KDirNotify.FilesAdded', 'string:file:///home/me/My%20Music']);

const calls = [];
const run = (cmd, args, opts, cb) => { calls.push([cmd, args.at(-1)]); cb(null); };
assert.equal(await notifyFolderChanged('/a', { platform: 'linux', run }), true);
assert.deepEqual(calls, [['dbus-send', 'string:file:///a']]);
assert.equal(await notifyFolderChanged('/a', { platform: 'darwin', run }), false, 'only on Linux');
assert.equal(await notifyFolderChanged('', { platform: 'linux', run }), false);
assert.equal(calls.length, 1);
// failures never reject: the dialog opens anyway
assert.equal(await notifyFolderChanged('/a', { platform: 'linux', run: (c, a, o, cb) => cb(new Error('no bus')) }), false);
assert.equal(await notifyFolderChanged('/a', { platform: 'linux', run: () => { throw new Error('ENOENT'); } }), false);

console.log('kdirnotify tests passed');
