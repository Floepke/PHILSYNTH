// Save / open dialogs for small text files (.clip, .synth) that start in the folder last used for
// that kind of file. `kind` names the remembered location:
//   Electron              native dialogs in the main process (electron/projectfiles.mjs), the
//                         folders are stored per kind in the app's user data
//   Chromium browsers     showSaveFilePicker / showOpenFilePicker with `id: kind`: the browser
//                         remembers the folder per id (per site, across restarts)
//   other browsers        a download / a file input (the browser decides where)
export const KINDS = {
  clip: { description: 'PHILSYNTH clip', ext: '.clip' },
  synth: { description: 'PHILSYNTH module', ext: '.synth' },
};

const cancelled = (err) => err?.name === 'AbortError';

// -> { name } when saved, null when cancelled
export async function saveTextFile(kind, suggestedName, text, win = window) {
  const { description, ext } = KINDS[kind];
  if (win.modsynthFiles?.saveFile) return win.modsynthFiles.saveFile(kind, suggestedName, text);
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
export async function openTextFile(kind, win = window) {
  const { description, ext } = KINDS[kind];
  if (win.modsynthFiles?.openFile) return win.modsynthFiles.openFile(kind);
  if (typeof win.showOpenFilePicker === 'function') {
    let handle;
    try {
      [handle] = await win.showOpenFilePicker({ id: kind, multiple: false, types: [{ description, accept: { 'application/octet-stream': [ext] } }] });
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
    const file = await handle.getFile();
    return { name: file.name, text: await file.text() };
  }
  return new Promise((resolve, reject) => {
    const input = Object.assign(win.document.createElement('input'), { type: 'file', accept: ext });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try { resolve({ name: file.name, text: await file.text() }); } catch (err) { reject(err); }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
