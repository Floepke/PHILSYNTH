// The current project document: its file name / location and whether it has unsaved changes.
// Classic New / Open / Save / Save As on top of a storage backend:
//   - desktop app: the app's own file dialog (src/filepicker.js) + real files (window.modsynthFiles)
//   - browsers with the File System Access API: file handles, kept in IndexedDB across reloads
//   - other browsers: file input to open, download to save
// A backend opens { name, ref, bytes } and saves through a lazy encode() function.
// `ref` identifies the file for later saves (a string, so it survives in the autosave).

import { PROJECT_EXT, PROJECT_OPEN_EXTS, fileAccept } from './fileformat.js';
import { pickFile } from './filepicker.js';
import { readProjectArchive, readProjectBytes, readStreamedProjectArchive } from './projectarchive.js';
import { isProjectZip } from './projectzip.js';
import { stageProjectStream } from './audioeditor/projectstage.js';

export const UNTITLED = 'Untitled';
export const EXT = PROJECT_EXT;

// Fast 53-bit string hash (cyrb53), enough to notice changes.
export function hashText(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Project file name for Save As: the document name with the .phproject extension.
export function suggestName(name) {
  const base = String(name || UNTITLED).replace(/\.(phproject|mds|json)$/i, '');
  return `${base || UNTITLED}${EXT}`;
}

// fingerprint(): what counts as a change (the project without view / selection state)
// serialize(): captures the file state, returning an async encoder
// onChange(doc): name or dirty state may have changed
export function createProjectFile({ fingerprint, serialize, backend, getAudioAssets = null, onChange = () => {} }) {
  let doc = { name: UNTITLED, ref: null, savedHash: null, diskVersion: null };
  const current = () => hashText(JSON.stringify(fingerprint()));
  const changed = () => onChange(api.info());
  const set = (next) => {
    doc = next;
    changed();
  };

  async function write(save) {
    const hash = current(); // what is being written, even if edits happen while the dialog is open
    const encode = serialize();
    const result = await save(encode);
    if (!result) return null;
    set({ name: result.name, ref: result.ref ?? null, savedHash: hash, diskVersion: encode.diskVersion ?? 2 });
    return result.name;
  }

  const api = {
    get name() { return doc.name; },
    get ref() { return doc.ref; },
    isDirty() { return doc.savedHash !== current(); },
    info() { return { name: doc.name, ref: doc.ref, dirty: api.isDirty() }; },
    // a fresh, unchanged document (New, or nothing restored on start)
    reset(name = UNTITLED) {
      set({ name, ref: null, savedHash: current(), diskVersion: null });
    },
    // Open a file: load(data) puts it in the app. Returns the name, or null when cancelled.
    async open(load) {
      const file = await backend.open();
      if (!file) return null;
      let archive, error;
      try {
        archive = file.blob
          ? await readStreamedProjectArchive(file.blob, getAudioAssets)
          : await readProjectArchive(file.bytes);
      } catch (cause) { error = cause; }
      if (file.cleanup) {
        try { await file.cleanup(); }
        catch (cause) {
          if (archive?.imported?.length) {
            const failures = [cause];
            for (const id of archive.imported) {
              try { await getAudioAssets().discard(id); } catch (cleanupError) { failures.push(cleanupError); }
            }
            cause = failures.length > 1 ? new AggregateError(failures, 'Project import cleanup failed') : cause;
          }
          error = error ? new AggregateError([error, cause], 'Project import and cleanup failed') : cause;
        }
      }
      if (error) throw error;
      const { data, version } = archive;
      await load(data);
      const ref = version >= 2 && file.name.toLowerCase().endsWith(EXT) ? file.ref ?? null : null;
      set({ name: file.name, ref, savedHash: current(), diskVersion: version });
      return file.name;
    },
    // Save to the current file (Save As when it has none). Returns the name, or null when cancelled.
    async save() {
      if (doc.ref === null || doc.ref === undefined) return api.saveAs();
      const name = await write((encode) => backend.save(doc.ref, encode));
      return name ?? api.saveAs();
    },
    saveAs() {
      const name = doc.diskVersion === 1 && doc.name.toLowerCase().endsWith(EXT)
        ? `${doc.name.slice(0, -EXT.length)} (v3)${EXT}` : suggestName(doc.name);
      return write((encode) => backend.saveAs(name, encode));
    },
    // stored in the autosave, so a restart restores the file name and the unsaved state
    toJSON() {
      return { name: doc.name, ref: doc.ref, savedHash: doc.savedHash, diskVersion: doc.diskVersion };
    },
    // from an autosave; one without document info counts as unsaved
    restore(saved) {
      const diskVersion = saved?.diskVersion === 3 ? 3 : saved?.diskVersion === 2 ? 2 : saved?.diskVersion === 1 || typeof saved?.ref === 'string' ? 1 : null;
      set({
        name: typeof saved?.name === 'string' && saved.name ? saved.name : UNTITLED,
        ref: diskVersion >= 2 && typeof saved?.ref === 'string' ? saved.ref : null,
        savedHash: typeof saved?.savedHash === 'string' ? saved.savedHash : null,
        diskVersion,
      });
    },
  };
  return api;
}

// ---- backends ----

// Desktop app: the app's own file dialog (src/filepicker.js) picks the path, the main process
// (electron/preload.cjs) reads / writes it. `pick` is replaceable for tests.
export function electronBackend(files, pick = pickFile) {
  async function streamSave(path, encode, saveAs) {
    if (!files.startProjectStream) throw new Error('Streaming project saves are unavailable');
    const stream = await files.startProjectStream(path, saveAs);
    if (!stream) return null;
    try { await encode.writeTo((bytes) => files.writeProjectStream(stream.id, bytes)); }
    catch (error) {
      try { await files.abortProjectStream(stream.id); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project save and cleanup failed'); }
      throw error;
    }
    return files.finishProjectStream(stream.id);
  }
  return {
    async open() {
      const f = await pick(files, { mode: 'open', dialog: 'project-open', title: 'Open PHILSYNTH project', types: `PHILSYNTH projects (${PROJECT_OPEN_EXTS.join(', ')})`, exts: PROJECT_OPEN_EXTS });
      if (!f) return null;
      if (!files.openProjectStream) return files.open(f.path);
      const info = await files.openProjectStream(f.path);
      if (isProjectZip(info.header) && info.header.length >= 6 && info.header[4] === 45 && info.header[5] === 0) {
        return { name: info.name, ref: info.ref, ...await stageProjectStream(files, info) };
      }
      await files.closeProjectStream(info.id);
      return files.open(f.path);
    },
    save: async (ref, encode) => encode.writeTo ? streamSave(ref, encode, false) : files.save(ref, await encode()),
    async saveAs(name, encode) {
      const f = await pick(files, { mode: 'save', dialog: 'project-save', title: 'Save PHILSYNTH project', types: `PHILSYNTH projects (${EXT})`, exts: [EXT], saveExt: EXT, suggestedName: name });
      return f ? encode.writeTo ? streamSave(f.path, encode, true) : files.saveAs(f.path, await encode()) : null;
    },
  };
}

const TYPES = [{ description: 'PHILSYNTH project', accept: { 'application/x-philsynth': [EXT] } }];
const OPEN_TYPES = [{ description: 'PHILSYNTH project', accept: { 'application/x-philsynth': PROJECT_OPEN_EXTS } }];

async function fileContents(file) {
  const header = new Uint8Array(await file.slice(0, 6).arrayBuffer());
  if (isProjectZip(header) && header.length >= 6 && header[4] === 45 && header[5] === 0) return { blob: file };
  return { bytes: await readProjectBytes(file) };
}

// Small IndexedDB store for file handles (they cannot go into JSON / localStorage).
function handleStore(dbName = 'modsynth-files') {
  let db = null;
  const open = () => (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const store = (await open()).transaction('handles', mode).objectStore('handles');
    return new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, value) => run('readwrite', (s) => s.put(value, key)),
  };
}

// Browsers with showOpenFilePicker / showSaveFilePicker (Chromium).
export function fsaBackend(win = window) {
  const store = handleStore();
  const handles = new Map();
  const remember = async (handle) => {
    const ref = `fsa:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    handles.set(ref, handle);
    try { await store.put(ref, handle); } catch { /* still works until the page reloads */ }
    return ref;
  };
  const cancelled = (err) => err?.name === 'AbortError';
  async function writeTo(handle, encode) {
    const file = await handle.getFile();
    if (file.size && !isProjectZip(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) {
      throw new Error('Choose a different file name to preserve the existing project');
    }
    const writable = await handle.createWritable();
    try {
      if (encode.writeTo) await encode.writeTo((bytes) => writable.write(bytes));
      else await writable.write(await encode());
      await writable.close();
    } catch (err) {
      try { await writable.abort(); }
      catch (cleanupError) { throw new AggregateError([err, cleanupError], 'Project save and cleanup failed'); }
      throw err;
    }
  }
  return {
    async open() {
      let handle;
      try {
        // id: the browser starts in the folder the last project was opened from
        [handle] = await win.showOpenFilePicker({ id: 'project-open', types: OPEN_TYPES, multiple: false });
      } catch (err) {
        if (cancelled(err)) return null;
        throw err;
      }
      const file = await handle.getFile();
      const contents = await fileContents(file);
      return { name: file.name, ref: contents.blob || isProjectZip(contents.bytes) ? await remember(handle) : null, ...contents };
    },
    async save(ref, encode) {
      let handle = handles.get(ref);
      if (!handle) {
        try { handle = await store.get(ref); } catch { handle = null; }
        if (!handle) return null;
        handles.set(ref, handle);
      }
      try {
        if ((await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted'
          && (await handle.requestPermission?.({ mode: 'readwrite' })) === 'denied') return null;
      } catch (err) {
        console.warn('Saving to the project file failed, asking for a new one:', err);
        return null;
      }
      try {
        await writeTo(handle, encode);
      } catch (err) {
        if (encode.writeTo) throw err;
        console.warn('Saving to the project file failed, asking for a new one:', err);
        return null;
      }
      return { name: handle.name, ref };
    },
    async saveAs(name, encode) {
      let handle;
      try {
        handle = await win.showSaveFilePicker({ id: 'project-save', suggestedName: name, types: TYPES });
      } catch (err) {
        if (cancelled(err)) return null;
        throw err;
      }
      await writeTo(handle, encode);
      return { name: handle.name, ref: await remember(handle) };
    },
  };
}

// Any browser: a file input opens, a download saves (each Save downloads the file again).
export function downloadBackend(fileInput, doc = document) {
  const download = async (name, encode) => {
    if (encode.writeTo && !encode.downloadable) throw new Error('Saving audio clips requires a browser with file system access or the desktop app');
    const blob = new Blob([await encode()], { type: 'application/octet-stream' });
    const a = Object.assign(doc.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return { name, ref: `download:${name}` };
  };
  return {
    open() {
      return new Promise((resolve, reject) => {
        fileInput.value = '';
        const done = async () => {
          fileInput.removeEventListener('change', done);
          fileInput.removeEventListener('cancel', cancel);
          const file = fileInput.files[0];
          fileInput.value = '';
          if (!file) return resolve(null);
          try { resolve({ name: file.name, ref: null, ...await fileContents(file) }); } catch (err) { reject(err); }
        };
        const cancel = () => {
          fileInput.removeEventListener('change', done);
          fileInput.removeEventListener('cancel', cancel);
          resolve(null);
        };
        fileInput.addEventListener('change', done);
        fileInput.addEventListener('cancel', cancel);
        fileInput.click();
      });
    },
    save: (ref, text) => download(String(ref).replace(/^download:/, ''), text),
    saveAs: (name, text) => download(name, text),
  };
}

export function pickBackend(win = window, fileInput = null) {
  if (win.modsynthFiles) return electronBackend(win.modsynthFiles);
  if (typeof win.showSaveFilePicker === 'function' && typeof win.showOpenFilePicker === 'function' && win.indexedDB) {
    return fsaBackend(win);
  }
  if (fileInput) fileInput.accept = fileAccept(PROJECT_OPEN_EXTS, win.navigator);
  return downloadBackend(fileInput);
}
