// Save / open dialogs for small text files (.clip, .phmod) that start in the folder last used for
// that kind of file. `kind` names the remembered location:
//   Electron              the app's own file dialog (src/filepicker.js); the main process
//                         (electron/projectfiles.mjs) stores the folders per kind in the app's user data
//   Chromium browsers     showSaveFilePicker / showOpenFilePicker with `id: kind`: the browser
//                         remembers the folder per id (per site, across restarts)
//   other browsers        a download / a file input (the browser decides where)
import { CLIP_EXT, MODULE_EXT, MODULE_OPEN_EXTS } from './fileformat.js';
import { pickFile } from './filepicker.js';

// ext: saved files; open: extensions the open dialog offers (older ones included)
export const KINDS = {
  clip: { description: 'PHILSYNTH clip', ext: CLIP_EXT, open: [CLIP_EXT] },
  module: { description: 'PHILSYNTH module', ext: MODULE_EXT, open: MODULE_OPEN_EXTS },
};

const cancelled = (err) => err?.name === 'AbortError';

// -> { name } when saved, null when cancelled. pick: the desktop app's dialog (replaceable for tests)
export async function saveTextFile(kind, suggestedName, text, win = window, pick = pickFile) {
  const { description, ext } = KINDS[kind];
  const files = win.modsynthFiles;
  if (files?.saveFile) {
    const f = await pick(files, { mode: 'save', dialog: kind, title: `Save ${description}`, types: `${description}s (${ext})`, exts: [ext], saveExt: ext, suggestedName });
    return f ? files.saveFile(kind, f.path, text) : null;
  }
  if (typeof win.showSaveFilePicker === 'function') {
    try {
      const handle = await win.showSaveFilePicker({ id: kind, suggestedName, types: [{ description, accept: { 'application/octet-stream': [ext] } }] });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { name: handle.name };
    } catch (err) {
      if (cancelled(err)) return null;
      console.warn('Saving through the file dialog failed, downloading instead:', err);
    }
  }
  const blob = new Blob([text], { type: 'application/octet-stream' });
  const a = Object.assign(win.document.createElement('a'), { href: URL.createObjectURL(blob), download: suggestedName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return { name: suggestedName };
}

// -> { name, text } when a file was picked, null when cancelled
export async function openTextFile(kind, win = window, pick = pickFile) {
  const { description, open } = KINDS[kind];
  const files = win.modsynthFiles;
  if (files?.openFile) {
    const f = await pick(files, { mode: 'open', dialog: kind, title: `Open ${description}`, types: `${description}s (${open.join(', ')})`, exts: open });
    return f ? files.openFile(kind, f.path) : null;
  }
  if (typeof win.showOpenFilePicker === 'function') {
    let handle;
    try {
      [handle] = await win.showOpenFilePicker({ id: kind, multiple: false, types: [{ description, accept: { 'application/octet-stream': open } }] });
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
    const file = await handle.getFile();
    return { name: file.name, text: await file.text() };
  }
  return new Promise((resolve, reject) => {
    const input = Object.assign(win.document.createElement('input'), { type: 'file', accept: open.join(',') });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try { resolve({ name: file.name, text: await file.text() }); } catch (err) { reject(err); }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
