// Folder browsing for the in-app file dialog of the desktop app (src/filepicker.js), without
// Electron imports so it can be tested in node. Individual operations only accept supported file
// types; folder operations include all contents, including hidden and other file types.
import { constants } from 'node:fs';
import { copyFile, cp, link, lstat, readlink, readdir, realpath, rename, rm, rmdir, stat, mkdir, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { PROJECT_OPEN_EXTS, MODULE_OPEN_EXTS, CLIP_EXT, AUDIO_OPEN_EXTS, WAVETABLE_OPEN_EXTS, IMAGE_OPEN_EXTS } from '../src/fileformat.js';

const MAX_ENTRIES = 10000;
const FILE_EXTS = new Set([...PROJECT_OPEN_EXTS, ...MODULE_OPEN_EXTS, CLIP_EXT,
  ...AUDIO_OPEN_EXTS, ...WAVETABLE_OPEN_EXTS, ...IMAGE_OPEN_EXTS, '.scl', '.scala', '.txt']);

// An absolute, normalized path from the page, or an error.
export function checkPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) throw new Error('Invalid path');
  return resolve(path);
}

// a plain file / folder name typed in the dialog (no folders, no '..')
export function checkName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n) || n.length > 255) throw new Error('Invalid name');
  return n;
}

// ['.phproject', ...] -> lower-case list, every entry starting with a dot
export function cleanExts(exts) {
  if (!Array.isArray(exts)) return [];
  return exts.filter((e) => typeof e === 'string' && /^\.[a-z0-9]{1,12}$/i.test(e)).map((e) => e.toLowerCase());
}

export const hasExt = (path, exts) => exts.includes(extname(path).toLowerCase());

// Ensures `ext` ('.phproject') on a file name.
export const withExt = (name, ext) => (extname(name).toLowerCase() === ext ? name : `${name}${ext}`);

// Path segments for the dialog's path bar: [{ name, path }], the root first.
export function crumbsOf(dir) {
  const { root } = parse(dir);
  const out = [{ name: root.replace(/[\\/]+$/, '') || sep, path: root }];
  let path = root;
  for (const part of dir.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    path = join(path, part);
    out.push({ name: part, path });
  }
  return out;
}

// -> { dir, parent, crumbs, entries: [{ name, path, dir, size, mtime }] }: folders and the files with
// one of `exts`; hidden entries (starting with a dot) are left out.
export async function listDir(dir, exts) {
  const d = checkPath(dir);
  const want = cleanExts(exts);
  const items = (await readdir(d, { withFileTypes: true })).filter((it) => !it.name.startsWith('.')).slice(0, MAX_ENTRIES);
  const entries = (await Promise.all(items.map(async (it) => {
    const path = join(d, it.name);
    let isDir = it.isDirectory();
    if (!isDir && !it.isFile() && !it.isSymbolicLink()) return null;
    let st = null;
    try { st = await stat(path); } catch { return null; } // broken link, no access
    isDir = st.isDirectory();
    if (!isDir && !(st.isFile() && hasExt(it.name, want))) return null;
    return { name: it.name, path, dir: isDir, size: isDir ? 0 : st.size, mtime: st.mtimeMs };
  }))).filter(Boolean);
  const parent = dirname(d);
  return { dir: d, parent: parent === d ? null : parent, crumbs: crumbsOf(d), entries };
}

// The file a save dialog would write: `name` (gets `ext`) in `dir` -> { path, name, exists, dir }.
// dir: true when that name is an existing folder (the dialog opens it instead).
export async function target(dir, name, ext) {
  const d = checkPath(dir);
  const n = checkName(name);
  const folder = await stat(join(d, n)).then((s) => s.isDirectory(), () => false);
  if (folder) return { path: join(d, n), name: n, exists: true, dir: true };
  const file = withExt(n, ext);
  const path = join(d, file);
  const exists = await stat(path).then(() => true, () => false);
  return { path, name: file, exists, dir: false };
}

export async function makeDir(dir, name) {
  const path = join(checkPath(dir), checkName(name));
  await mkdir(path);
  return path;
}

async function entryOf(path, expectedDir) {
  const p = checkPath(path);
  if (dirname(p) === p) throw new Error('Cannot modify a filesystem root');
  if (typeof expectedDir !== 'boolean') throw new Error('Invalid entry type');
  const link = await lstat(p);
  const info = link.isSymbolicLink() ? await stat(p) : link;
  if (info.isDirectory() !== expectedDir || (!info.isDirectory() && !info.isFile())) throw new Error('The entry type has changed');
  if (!expectedDir && !FILE_EXTS.has(extname(p).toLowerCase())) throw new Error('Unsupported file type');
  return { path: p, link, dir: expectedDir };
}

async function copyEntry(entry, destination) {
  if (entry.link.isSymbolicLink()) {
    await symlink(await readlink(entry.path), destination, entry.dir ? 'dir' : 'file');
  } else if (entry.dir) {
    await mkdir(destination, { mode: entry.link.mode });
    try {
      for (const name of await readdir(entry.path)) {
        await cp(join(entry.path, name), join(destination, name), {
          recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true,
        });
      }
    } catch (err) {
      throw new Error(`Copy incomplete; the partially copied folder remains at "${destination}": ${err.message}`);
    }
  } else {
    await copyFile(entry.path, destination, constants.COPYFILE_EXCL);
  }
}

async function moveEntry(entry, destination) {
  if (!entry.link.isSymbolicLink() && entry.dir) {
    await mkdir(destination, { mode: entry.link.mode });
    try {
      await rename(entry.path, destination);
      return;
    } catch (err) {
      try { await rmdir(destination); }
      catch (cleanup) { throw new Error(`Could not remove the reserved destination "${destination}": ${cleanup.message}`); }
      if (!['EXDEV', 'EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
    }
  } else if (!entry.link.isSymbolicLink()) {
    try {
      await link(entry.path, destination);
      try { await unlink(entry.path); }
      catch (err) { throw new Error(`Linked to "${destination}", but could not remove the original: ${err.message}`); }
      return;
    } catch (err) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(err.code)) throw err;
    }
  }
  await copyEntry(entry, destination);
  try {
    if (entry.link.isSymbolicLink() || !entry.dir) await unlink(entry.path);
    else await rm(entry.path, { recursive: true });
  } catch (err) {
    throw new Error(`Copied to "${destination}", but could not remove the original: ${err.message}`);
  }
}

// Copy or move without replacing an existing entry; a copy in the same folder gets a new name.
export async function transferEntry(path, expectedDir, destinationDir, move = false, newName = null) {
  if (typeof move !== 'boolean') throw new Error('Invalid transfer');
  const entry = await entryOf(path, expectedDir);
  const dir = checkPath(destinationDir);
  if (!(await stat(dir)).isDirectory()) throw new Error('Destination is not a folder');
  const name = newName === null ? basename(entry.path) : checkName(newName);
  if (!entry.dir && !FILE_EXTS.has(extname(name).toLowerCase())) throw new Error('Unsupported file type');
  if (entry.dir && !entry.link.isSymbolicLink()) {
    const source = await realpath(entry.path);
    const dest = await realpath(dir);
    if (dest === source || dest.startsWith(source.endsWith(sep) ? source : source + sep)) {
      throw new Error('Cannot move or copy a folder into itself');
    }
  }
  let destination = join(dir, name);
  if (destination === entry.path && move) {
    if (newName !== null) return destination;
    throw new Error('The item is already in this folder');
  }
  if (move) {
    await moveEntry(entry, destination);
  } else if (destination === entry.path) {
    const ext = entry.dir ? '' : extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    for (let n = 1; ; n++) {
      destination = join(dir, `${base} copy${n === 1 ? '' : ` ${n}`}${ext}`);
      try { await copyEntry(entry, destination); break; }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
  } else {
    await copyEntry(entry, destination);
  }
  return destination;
}

export async function deleteEntry(path, expectedDir) {
  const entry = await entryOf(path, expectedDir);
  if (entry.link.isSymbolicLink() || !entry.dir) await unlink(entry.path);
  else await rm(entry.path, { recursive: true });
}

// Sidebar places: { name, path } of the usual folders and mounted volumes that exist.
export async function places({ home, desktop, documents, downloads, music }, platform = process.platform) {
  const list = [
    { name: 'Home', path: home },
    { name: 'Desktop', path: desktop },
    { name: 'Documents', path: documents },
    { name: 'Downloads', path: downloads },
    { name: 'Music', path: music },
  ];
  const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
  const children = async (p) => {
    try { return (await readdir(p, { withFileTypes: true })).filter((d) => !d.name.startsWith('.')).map((d) => ({ name: d.name, path: join(p, d.name) })); } catch { return []; }
  };
  if (platform === 'darwin') list.push(...await children('/Volumes'));
  else if (platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') list.push({ name: `${l}:`, path: `${l}:\\` });
  } else {
    list.push({ name: 'Computer', path: '/' });
    const user = basename(home || '');
    list.push(...await children(join('/media', user)), ...await children(join('/run/media', user)));
  }
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!p.path || seen.has(p.path) || !(await isDir(p.path))) continue;
    seen.add(p.path);
    out.push(p);
  }
  return out;
}
