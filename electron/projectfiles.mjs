// Project files for the desktop app: native Open / Save As dialogs and writes to the chosen file.
// The page (electron/preload.cjs) only gets files the user picked in one of these dialogs.
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { notifyFolderChanged } from './kdirnotify.mjs';
import { PROJECT_EXT, PROJECT_OPEN_EXTS, CLIP_EXT, MODULE_EXT, MODULE_OPEN_EXTS } from '../src/fileformat.js';

const bare = (ext) => ext.replace(/^\./, '');
const PROJECT = bare(PROJECT_EXT);
const FILTERS = [{ name: 'PHILSYNTH project', extensions: [PROJECT] }];
const OPEN_FILTERS = [{ name: 'PHILSYNTH project', extensions: PROJECT_OPEN_EXTS.map(bare) }, { name: 'All files', extensions: ['*'] }];
// small files saved / opened through 'file:save' / 'file:open' (see src/filedialog.js)
// ext: saved files; open: what the open dialog offers (older extensions included)
export const FILE_KINDS = {
  clip: { name: 'PHILSYNTH clip', ext: bare(CLIP_EXT), open: [bare(CLIP_EXT)], max: 64 * 1024 * 1024 },
  module: { name: 'PHILSYNTH module', ext: bare(MODULE_EXT), open: MODULE_OPEN_EXTS.map(bare), max: 512 * 1024 * 1024 },
};
const MAX_PATHS = 100;
const MAX_BYTES = 512 * 1024 * 1024;

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

// Write to a temp file next to the target, then rename: a crash never leaves half a project.
export async function atomicWrite(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const exists = (path) => stat(path).then(() => true, () => false);

export function registerProjectFiles(isLocal) {
  const listFile = join(app.getPath('userData'), 'project-paths.json');
  let allowed = null; // paths chosen in the dialogs (most recent last), kept across restarts
  const dirs = createDirMemory(join(app.getPath('userData'), 'dialog-dirs.json'));
  // called right before each dialog opens: KDE's dialog then lists the folder fresh (no F5 needed)
  const startDir = async (kind) => {
    const stored = await dirs.get(kind);
    const dir = stored && await exists(stored) ? stored : app.getPath('documents');
    await notifyFolderChanged(dir);
    return dir;
  };

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

  ipcMain.handle('project:open', async (e) => {
    const win = check(e);
    const r = await dialog.showOpenDialog(win, {
      title: 'Open PHILSYNTH project',
      defaultPath: await startDir('project-open'),
      filters: OPEN_FILTERS,
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    const text = await readFile(path, 'utf8');
    await allow(path);
    await dirs.remember('project-open', path);
    return { name: basename(path), ref: path, text };
  });

  ipcMain.handle('project:saveAs', async (e, name, text) => {
    const win = check(e);
    textOf(text);
    const file = basename(typeof name === 'string' && name ? name : `Untitled.${PROJECT}`);
    const r = await dialog.showSaveDialog(win, {
      title: 'Save PHILSYNTH project',
      defaultPath: join(await startDir('project-save'), withExtension(file)),
      filters: FILTERS,
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (r.canceled || !r.filePath) return null;
    const path = withExtension(r.filePath);
    // the dialog only confirmed overwriting the name without the extension
    if (path !== r.filePath && await exists(path)) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `"${basename(path)}" already exists. Do you want to replace it?`,
      });
      if (response !== 0) return null;
    }
    await atomicWrite(path, text);
    notifyFolderChanged(dirname(path));
    await allow(path);
    await dirs.remember('project-save', path);
    return { name: basename(path), ref: path };
  });

  // Save to a file picked earlier; null makes the page ask with Save As.
  ipcMain.handle('project:save', async (e, ref, text) => {
    check(e);
    textOf(text);
    if (typeof ref !== 'string' || !(await load()).includes(ref)) return null;
    await atomicWrite(ref, text);
    notifyFolderChanged(dirname(ref));
    return { name: basename(ref), ref };
  });

  const kindOf = (kind) => {
    if (!Object.hasOwn(FILE_KINDS, kind)) throw new Error(`Unknown file kind "${kind}"`);
    return FILE_KINDS[kind];
  };
  const confirmReplace = async (win, path) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `"${basename(path)}" already exists. Do you want to replace it?`,
    });
    return response === 0;
  };

  // Clips and modules: a Save dialog in the folder last used for that kind -> { name } or null.
  ipcMain.handle('file:save', async (e, kind, name, text) => {
    const win = check(e);
    const k = kindOf(kind);
    if (typeof text !== 'string' || text.length > k.max) throw new Error('Invalid file data');
    const file = basename(typeof name === 'string' && name ? name : `Untitled.${k.ext}`);
    const r = await dialog.showSaveDialog(win, {
      title: `Save ${k.name}`,
      defaultPath: join(await startDir(kind), withExtension(file, k.ext)),
      filters: [{ name: k.name, extensions: [k.ext] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (r.canceled || !r.filePath) return null;
    const path = withExtension(r.filePath, k.ext);
    if (path !== r.filePath && await exists(path) && !(await confirmReplace(win, path))) return null;
    await atomicWrite(path, text);
    notifyFolderChanged(dirname(path));
    await dirs.remember(kind, path);
    return { name: basename(path) };
  });

  // -> { name, text } or null; starts in the folder last used for that kind.
  ipcMain.handle('file:open', async (e, kind) => {
    const win = check(e);
    const k = kindOf(kind);
    const r = await dialog.showOpenDialog(win, {
      title: `Open ${k.name}`,
      defaultPath: await startDir(kind),
      filters: [{ name: k.name, extensions: k.open }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    if ((await stat(path)).size > k.max) throw new Error('File too large');
    const text = await readFile(path, 'utf8');
    await dirs.remember(kind, path);
    return { name: basename(path), text };
  });
}
