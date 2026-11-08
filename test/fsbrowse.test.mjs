import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { checkName, checkPath, cleanExts, crumbsOf, deleteEntry, listDir, makeDir, places, target, transferEntry, withExt } from '../electron/fsbrowse.mjs';
import { sortEntries, formatSize, findPrefix, baseLength, errorText } from '../src/filepicker.js';

const root = await mkdtemp(join(tmpdir(), 'fsbrowse-'));
try {
  await mkdir(join(root, 'Songs'));
  await mkdir(join(root, '.hidden-dir'));
  await writeFile(join(root, 'a.phproject'), '{}');
  await writeFile(join(root, 'B.PHPROJECT'), '{}');
  await writeFile(join(root, 'old.mds'), '{}');
  await writeFile(join(root, 'notes.txt'), 'secret');
  await writeFile(join(root, '.x.phproject'), '{}');
  await symlink(join(root, 'missing'), join(root, 'broken.phproject')).catch(() => {});

  // only folders and files with the wanted extensions (any case); hidden and broken entries left out
  const r = await listDir(root, ['.phproject', '.mds']);
  assert.equal(r.dir, root);
  assert.deepEqual(r.entries.map((e) => e.name).sort(), ['B.PHPROJECT', 'Songs', 'a.phproject', 'old.mds']);
  const songs = r.entries.find((e) => e.name === 'Songs');
  assert.equal(songs.dir, true);
  assert.equal(songs.path, join(root, 'Songs'));
  assert.equal(r.entries.find((e) => e.name === 'a.phproject').size, 2);
  assert.ok(r.parent && r.parent !== root);
  assert.equal(r.crumbs.at(-1).path, root);
  assert.deepEqual((await listDir(root, [])).entries.map((e) => e.name), ['Songs'], 'no extensions: folders only');
  assert.deepEqual((await listDir(root, ['../x', 'txt', 42])).entries.map((e) => e.name), ['Songs'], 'invalid extensions are ignored');
  await assert.rejects(listDir('relative/path', ['.phproject']), /Invalid path/);
  await assert.rejects(listDir(join(root, 'nope'), ['.phproject']), /ENOENT/);

  // save target: the extension is added; existing files and folders are reported
  assert.deepEqual(await target(root, 'new', '.phproject'), { path: join(root, 'new.phproject'), name: 'new.phproject', exists: false, dir: false });
  assert.deepEqual(await target(root, 'a.phproject', '.phproject'), { path: join(root, 'a.phproject'), name: 'a.phproject', exists: true, dir: false });
  assert.equal((await target(root, 'Songs', '.phproject')).dir, true, 'a folder name opens the folder');
  for (const bad of ['../x', 'a/b', 'a\\b', '..', '', '   ']) await assert.rejects(target(root, bad, '.phproject'), /Invalid name/, bad);

  // new folder
  assert.equal(await makeDir(root, 'Fresh'), join(root, 'Fresh'));
  assert.ok((await listDir(root, [])).entries.some((e) => e.name === 'Fresh'));
  await assert.rejects(makeDir(root, 'Fresh'), /EEXIST/);
  await assert.rejects(makeDir(root, '../escape'), /Invalid name/);

  // File operations never replace an existing item and preserve the original on failure.
  const file = join(root, 'a.phproject');
  const duplicate = await transferEntry(file, false, root);
  assert.equal(duplicate, join(root, 'a copy.phproject'));
  assert.equal(await readFile(duplicate, 'utf8'), '{}');
  assert.equal(await transferEntry(file, false, root), join(root, 'a copy 2.phproject'));
  await writeFile(join(root, 'Songs', 'a.phproject'), 'existing');
  await assert.rejects(transferEntry(file, false, join(root, 'Songs'), true), /EEXIST/);
  assert.equal(await readFile(file, 'utf8'), '{}');
  assert.equal(await readFile(join(root, 'Songs', 'a.phproject'), 'utf8'), 'existing');
  const moved = await transferEntry(duplicate, false, join(root, 'Songs'), true);
  assert.equal(await readFile(moved, 'utf8'), '{}');
  await assert.rejects(lstat(duplicate), /ENOENT/);
  const renamed = await transferEntry(moved, false, join(root, 'Songs'), true, 'renamed.phproject');
  assert.equal(await readFile(renamed, 'utf8'), '{}');
  await assert.rejects(transferEntry(renamed, false, join(root, 'Songs'), true, '../bad.phproject'), /Invalid name/);
  await assert.rejects(transferEntry(renamed, false, join(root, 'Songs'), true, 'bad.exe'), /Unsupported file type/);
  await assert.rejects(deleteEntry(renamed, true), /entry type has changed/);
  await deleteEntry(renamed, false);
  await assert.rejects(lstat(renamed), /ENOENT/);

  // Directory operations include hidden and non-listed files, but not a linked directory's target.
  await mkdir(join(root, 'Songs', 'Sub'));
  await writeFile(join(root, 'Songs', '.secret'), 'hidden');
  await writeFile(join(root, 'Songs', 'Sub', 'notes.txt'), 'notes');
  await assert.rejects(transferEntry(join(root, 'Songs'), true, join(root, 'Songs', 'Sub')), /into itself/);
  const copy = await transferEntry(join(root, 'Songs'), true, root);
  assert.equal(copy, join(root, 'Songs copy'));
  assert.equal(await readFile(join(copy, '.secret'), 'utf8'), 'hidden');
  assert.equal(await readFile(join(copy, 'Sub', 'notes.txt'), 'utf8'), 'notes');
  await deleteEntry(copy, true);
  assert.equal(await readFile(join(root, 'Songs', 'Sub', 'notes.txt'), 'utf8'), 'notes');
  if (process.platform !== 'win32') {
    const link = join(root, 'folder-link');
    await symlink(join(root, 'Songs'), link, 'dir');
    const linkCopy = await transferEntry(link, true, root);
    assert.ok((await lstat(linkCopy)).isSymbolicLink());
    await deleteEntry(link, true);
    await deleteEntry(linkCopy, true);
    assert.equal(await readFile(join(root, 'Songs', '.secret'), 'utf8'), 'hidden');
  }
  await assert.rejects(deleteEntry(sep, true), /filesystem root/);
  await assert.rejects(deleteEntry(join(root, 'notes.txt'), 'file'), /Invalid entry type/);

  // places: only existing folders, no duplicates
  const p = await places({ home: root, desktop: join(root, 'Songs'), documents: root, downloads: join(root, 'missing'), music: null }, 'linux');
  assert.deepEqual(p.filter((x) => x.path.startsWith(root)).map((x) => x.name), ['Home', 'Desktop']);
  assert.ok(p.some((x) => x.path === '/'), 'Linux: the file system root');
} finally {
  await rm(root, { recursive: true, force: true });
}

assert.throws(() => checkPath('a\0b'), /Invalid path/);
assert.throws(() => checkPath(42), /Invalid path/);
assert.equal(checkPath(`${sep}a${sep}b${sep}..${sep}c`), `${sep}a${sep}c`);
assert.equal(checkName('  Song  '), 'Song');
assert.deepEqual(cleanExts(['.WAV', 'wav', '.a/b']), ['.wav']);
assert.equal(withExt('Song', '.clip'), 'Song.clip');
assert.equal(withExt('Song.CLIP', '.clip'), 'Song.CLIP');
assert.deepEqual(crumbsOf('/a/b').map((c) => [c.name, c.path]), [['/', '/'], ['a', '/a'], ['b', '/a/b']]);

// dialog helpers (src/filepicker.js)
const sorted = sortEntries([{ name: 'b10', dir: false }, { name: 'B2', dir: false }, { name: 'z', dir: true }, { name: 'a', dir: true }]);
assert.deepEqual(sorted.map((e) => e.name), ['a', 'z', 'B2', 'b10'], 'folders first, natural order, any case');
assert.equal(formatSize(0), '0 B');
assert.equal(formatSize(1536), '1.5 KB');
assert.equal(formatSize(50 * 1024 * 1024), '50 MB');
assert.equal(formatSize(undefined), '');
const names = [{ name: 'Bass' }, { name: 'beat' }, { name: 'Lead' }];
assert.equal(findPrefix(names, 'b'), 0);
assert.equal(findPrefix(names, 'b', 0), 1, 'the same letter again goes to the next match');
assert.equal(findPrefix(names, 'b', 1), 0, 'and wraps around');
assert.equal(findPrefix(names, 'le'), 2);
assert.equal(findPrefix(names, 'x'), -1);
assert.equal(baseLength('Song.phproject'), 4);
assert.equal(baseLength('.rc'), 3);
assert.equal(baseLength('Song'), 4);
assert.equal(errorText(new Error("Error invoking remote method 'fs:list': Error: EACCES: permission denied, scandir '/x'")), "EACCES: permission denied, scandir '/x'");

console.log('fsbrowse tests passed');
