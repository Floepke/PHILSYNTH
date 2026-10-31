// Project files for the desktop app: native Open / Save As dialogs and writes to the chosen file.
// The page (electron/preload.cjs) only gets files the user picked in one of these dialogs.
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const FILTERS = [{ name: 'MODSYNTH project', extensions: ['mds'] }];
const OPEN_FILTERS = [{ name: 'MODSYNTH project', extensions: ['mds', 'json'] }, { name: 'All files', extensions: ['*'] }];
const MAX_PATHS = 100;
const MAX_BYTES = 512 * 1024 * 1024;

// Ensures the .mds extension (dialogs on some desktops do not add it).
export function withExtension(path) {
  return extname(path).toLowerCase() === '.mds' ? path : `${path}.mds`;
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
  let lastDir = null;

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
    lastDir = dirname(path);
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
      title: 'Open MODSYNTH project',
      defaultPath: lastDir ?? app.getPath('documents'),
      filters: OPEN_FILTERS,
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    const text = await readFile(path, 'utf8');
    await allow(path);
    return { name: basename(path), ref: path, text };
  });

  ipcMain.handle('project:saveAs', async (e, name, text) => {
    const win = check(e);
    textOf(text);
    const file = basename(typeof name === 'string' && name ? name : 'Untitled.mds');
    const r = await dialog.showSaveDialog(win, {
      title: 'Save MODSYNTH project',
      defaultPath: join(lastDir ?? app.getPath('documents'), withExtension(file)),
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
    await allow(path);
    return { name: basename(path), ref: path };
  });

  // Save to a file picked earlier; null makes the page ask with Save As.
  ipcMain.handle('project:save', async (e, ref, text) => {
    check(e);
    textOf(text);
    if (typeof ref !== 'string' || !(await load()).includes(ref)) return null;
    await atomicWrite(ref, text);
    lastDir = dirname(ref);
    return { name: basename(ref), ref };
  });
}
