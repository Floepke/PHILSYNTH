// Folder browsing for the in-app file dialog of the desktop app (src/filepicker.js), without
// Electron imports so it can be tested in node. The page may list folders, but only files with
// one of the app's own extensions are listed, read or written (see electron/projectfiles.mjs).
import { readdir, stat, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const MAX_ENTRIES = 10000;

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
