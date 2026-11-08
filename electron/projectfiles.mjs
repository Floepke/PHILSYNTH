// Files for the desktop app. The page shows its own file dialog (src/filepicker.js) and browses
// folders through 'fs:*' (electron/fsbrowse.mjs); reads and writes only accept the app's own file
// types: projects, clips, modules, Scala tunings (open only), exported WAV/MIDI and the audio /
// pictures modules load (open only).
import { app, ipcMain, BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { notifyFolderChanged } from './kdirnotify.mjs';
import { atomicWrite } from './atomicwrite.mjs';
export { atomicWrite } from './atomicwrite.mjs';
import { checkPath, cleanExts, deleteEntry, hasExt, listDir, makeDir, places, target, transferEntry } from './fsbrowse.mjs';
import { PROJECT_EXT, PROJECT_OPEN_EXTS, CLIP_EXT, MODULE_EXT, MODULE_OPEN_EXTS, AUDIO_OPEN_EXTS, WAVETABLE_OPEN_EXTS, IMAGE_OPEN_EXTS, MIDI_OPEN_EXTS, MAX_MIDI_BYTES } from '../src/fileformat.js';
import { AUDIO_FORMATS } from '../src/audioformat.js';

const bare = (ext) => ext.replace(/^\./, '');
const PROJECT = bare(PROJECT_EXT);
// small files saved / opened through 'file:save' / 'file:open' (see src/filedialog.js)
// ext: saved files; open: what the open dialog offers (older extensions included)
export const FILE_KINDS = {
  clip: { name: 'PHILSYNTH clip', ext: bare(CLIP_EXT), open: [bare(CLIP_EXT)], max: 64 * 1024 * 1024 },
  module: { name: 'PHILSYNTH module', ext: bare(MODULE_EXT), open: MODULE_OPEN_EXTS.map(bare), max: 512 * 1024 * 1024 },
  // Scala tunings for the TUNING module: opened only (same limit as src/modules/tuning.js MAX_SCALA)
  scala: { name: 'Scala tuning', ext: 'scl', open: ['scl', 'scala', 'txt'], max: 256 * 1024, openOnly: true },
};
// audio / pictures the modules load ('file:openBinary'; see src/filedialog.js openMediaFile)
export const MEDIA_KINDS = {
  sample: { open: AUDIO_OPEN_EXTS, max: 512 * 1024 * 1024 },
  wavetable: { open: WAVETABLE_OPEN_EXTS, max: 256 * 1024 * 1024 },
  image: { open: IMAGE_OPEN_EXTS, max: 64 * 1024 * 1024 },
  midi: { open: MIDI_OPEN_EXTS, max: MAX_MIDI_BYTES },
};
const MAX_PATHS = 100;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_AUDIO = 2 * 1024 * 1024 * 1024;
// remembered start folder per dialog
const DIALOG_KINDS = new Set(['project-open', 'project-save', 'clip', 'module', 'scala', 'audio', 'sample', 'wavetable', 'image', 'midi']);
// extensions a save dialog may add / check (fs:target)
const SAVE_EXTS = new Set([PROJECT_EXT, CLIP_EXT, MODULE_EXT, ...AUDIO_FORMATS.map(format => format.ext), '.mid']);

// Ensures the extension (dialogs on some desktops do not add it).
export function withExtension(path, ext = PROJECT) {
  return extname(path).toLowerCase() === `.${ext}` ? path : `${path}.${ext}`;
}

// The folder last used per kind of dialog ('project-open', 'project-save', 'clip', 'module'),
// kept in a JSON file so the dialogs start there after a restart too.
export function createDirMemory(file) {
  let dirs = null;
  async function load() {
    if (dirs) return dirs;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      dirs = data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string')) : {};
    } catch {
      dirs = {};
    }
    return dirs;
  }
  return {
    async get(kind) { return (await load())[kind] ?? null; },
    async remember(kind, path) {
      const d = await load();
      const dir = dirname(path);
      if (d[kind] === dir) return;
      d[kind] = dir;
      await atomicWrite(file, JSON.stringify(d)).catch((err) => console.warn('Could not store dialog folders:', err));
    },
  };
}

const exists = (path) => stat(path).then(() => true, () => false);

export function registerProjectFiles(isLocal) {
  const listFile = join(app.getPath('userData'), 'project-paths.json');
  let allowed = null; // paths opened / saved as projects (most recent last), kept across restarts
  const dirs = createDirMemory(join(app.getPath('userData'), 'dialog-dirs.json'));

  async function load() {
    if (allowed) return allowed;
    try {
      const list = JSON.parse(await readFile(listFile, 'utf8'));
      allowed = Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
    } catch {
      allowed = [];
    }
    return allowed;
  }
  async function allow(path) {
    const list = (await load()).filter((p) => p !== path);
    list.push(path);
    allowed = list.slice(-MAX_PATHS);
    await atomicWrite(listFile, JSON.stringify(allowed)).catch((err) => console.warn('Could not store project paths:', err));
  }

  const check = (e) => {
    if (!isLocal(e.senderFrame?.url)) throw new Error('Not allowed');
    return BrowserWindow.fromWebContents(e.sender) ?? undefined;
  };
  const textOf = (text) => {
    if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('Invalid project data');
    return text;
  };
  const kindOf = (kind) => {
    if (!Object.hasOwn(FILE_KINDS, kind)) throw new Error(`Unknown file kind "${kind}"`);
    return FILE_KINDS[kind];
  };
  // a path picked in the dialog, with one of `exts`
  const fileOf = (path, exts) => {
    const p = checkPath(path);
    if (!hasExt(p, exts)) throw new Error(`Not a ${exts.join(' / ')} file`);
    return p;
  };
  const readSmall = async (path, max) => {
    if ((await stat(path)).size > max) throw new Error('File too large');
    return readFile(path, 'utf8');
  };
  const written = (path) => notifyFolderChanged(dirname(path));
  const audioWrites = new Map();
  const audioKey = (e, id) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('Invalid audio export id');
    return `${e.sender.id}:${id}`;
  };

  // ---- the in-app file dialog ----
  // -> { dir, places }: the folder last used for that dialog (else Documents) and the sidebar
  ipcMain.handle('fs:start', async (e, kind) => {
    check(e);
    if (!DIALOG_KINDS.has(kind)) throw new Error(`Unknown dialog "${kind}"`);
    const stored = await dirs.get(kind);
    const dir = stored && await exists(stored) ? stored : app.getPath('documents');
    const get = (name) => { try { return app.getPath(name); } catch { return null; } };
    return { dir, places: await places({ home: get('home'), desktop: get('desktop'), documents: get('documents'), downloads: get('downloads'), music: get('music') }) };
  });
  ipcMain.handle('fs:list', (e, dir, exts) => { check(e); return listDir(dir, exts); });
  ipcMain.handle('fs:target', (e, dir, name, ext) => {
    check(e);
    if (!SAVE_EXTS.has(ext)) throw new Error('Invalid extension');
    return target(dir, name, ext);
  });
  ipcMain.handle('fs:mkdir', (e, dir, name) => { check(e); return makeDir(dir, name); });
  ipcMain.handle('fs:transfer', async (e, path, isDir, dir, move, name) => {
    check(e);
    const dest = await transferEntry(path, isDir, dir, move, name);
    written(dest);
    if (move) written(path);
    return dest;
  });
  ipcMain.handle('fs:delete', async (e, path, isDir) => {
    check(e);
    await deleteEntry(path, isDir);
    written(path);
  });

  // ---- projects ----
  ipcMain.handle('project:open', async (e, path) => {
    check(e);
    const p = fileOf(path, cleanExts(PROJECT_OPEN_EXTS));
    const text = await readSmall(p, MAX_BYTES);
    await allow(p);
    await dirs.remember('project-open', p);
    return { name: basename(p), ref: p, text };
  });

  ipcMain.handle('project:saveAs', async (e, path, text) => {
    check(e);
    textOf(text);
    const p = fileOf(withExtension(checkPath(path)), [PROJECT_EXT]);
    await atomicWrite(p, text);
    written(p);
    await allow(p);
    await dirs.remember('project-save', p);
    return { name: basename(p), ref: p };
  });

  // Save to a file opened / saved before; null makes the page ask with Save As.
  ipcMain.handle('project:save', async (e, ref, text) => {
    check(e);
    textOf(text);
    if (typeof ref !== 'string' || !(await load()).includes(ref)) return null;
    try { await stat(ref); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    await atomicWrite(ref, text);
    written(ref);
    return { name: basename(ref), ref };
  });

  // ---- clips and modules ----
  ipcMain.handle('file:save', async (e, kind, path, text) => {
    check(e);
    const k = kindOf(kind);
    if (k.openOnly) throw new Error(`${k.name} files cannot be saved`);
    if (typeof text !== 'string' || text.length > k.max) throw new Error('Invalid file data');
    const p = fileOf(withExtension(checkPath(path), k.ext), [`.${k.ext}`]);
    await atomicWrite(p, text);
    written(p);
    await dirs.remember(kind, p);
    return { name: basename(p) };
  });

  ipcMain.handle('file:open', async (e, kind, path) => {
    check(e);
    const k = kindOf(kind);
    const p = fileOf(path, k.open.map((x) => `.${x}`));
    const text = await readSmall(p, k.max);
    await dirs.remember(kind, p);
    return { name: basename(p), text };
  });

  // ---- audio / pictures for SAMPLER, WAVETABLE, IMAGE SAMPLER: -> { name, data } (the bytes) ----
  ipcMain.handle('file:openBinary', async (e, kind, path) => {
    check(e);
    if (!Object.hasOwn(MEDIA_KINDS, kind)) throw new Error(`Unknown file kind "${kind}"`);
    const k = MEDIA_KINDS[kind];
    const p = fileOf(path, k.open);
    if ((await stat(p)).size > k.max) throw new Error('File too large');
    const data = await readFile(p);
    await dirs.remember(kind, p);
    return { name: basename(p), data };
  });

  // ---- Export MIDI: Standard MIDI File bytes ----
  ipcMain.handle('midi:save', async (e, path, data) => {
    check(e);
    const p = fileOf(withExtension(checkPath(path), 'mid'), ['.mid']);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes || bytes.byteLength > MAX_MIDI_BYTES || bytes.byteLength < 14 ||
      bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 104 || bytes[3] !== 100) throw new Error('Invalid MIDI data');
    await atomicWrite(p, bytes);
    written(p);
    await dirs.remember('midi', p);
    return { name: basename(p) };
  });

  // ---- Export Audio: encoded WAV / MP3 / Ogg bytes ----
  ipcMain.handle('audio:cancel', (e, id) => {
    check(e);
    audioWrites.get(audioKey(e, id))?.abort();
  });
  ipcMain.handle('audio:save', async (e, path, data, id) => {
    check(e);
    const key = audioKey(e, id);
    if (audioWrites.has(key)) throw new Error('Audio export already running');
    const checked = checkPath(path);
    const ext = extname(checked).toLowerCase();
    const audioExts = AUDIO_FORMATS.map(format => format.ext);
    const p = fileOf(audioExts.includes(ext) ? checked : withExtension(checked, 'wav'), audioExts);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes || bytes.byteLength > MAX_AUDIO) throw new Error('Invalid audio data');
    const controller = new AbortController();
    audioWrites.set(key, controller);
    try {
      await atomicWrite(p, bytes, { signal: controller.signal });
      written(p);
      await dirs.remember('audio', p);
      return { name: basename(p) };
    } catch (err) {
      if (controller.signal.aborted) return { cancelled: true };
      throw err;
    } finally {
      audioWrites.delete(key);
    }
  });
}
