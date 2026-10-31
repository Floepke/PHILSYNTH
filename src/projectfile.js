// The current project document: its file name / location and whether it has unsaved changes.
// Classic New / Open / Save / Save As on top of a storage backend:
//   - desktop app: native dialogs + real files (electron/preload.cjs, window.modsynthFiles)
//   - browsers with the File System Access API: file handles, kept in IndexedDB across reloads
//   - other browsers: file input to open, download to save
// A backend: { open() -> { name, ref, text } | null, saveAs(name, text) -> { name, ref } | null,
//              save(ref, text) -> { name, ref } | null (null: no longer writable, use Save As) }
// `ref` identifies the file for later saves (a string, so it survives in the autosave).

export const UNTITLED = 'Untitled';
export const EXT = '.mds';

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

// Project file name for Save As: the document name with the .mds extension.
export function suggestName(name) {
  const base = String(name || UNTITLED).replace(/\.(mds|json)$/i, '');
  return `${base || UNTITLED}${EXT}`;
}

// fingerprint(): what counts as a change (the project without view / selection state)
// serialize(): the text written to the file
// onChange(doc): name or dirty state may have changed
export function createProjectFile({ fingerprint, serialize, backend, onChange = () => {} }) {
  let doc = { name: UNTITLED, ref: null, savedHash: null };
  const current = () => hashText(JSON.stringify(fingerprint()));
  const changed = () => onChange(api.info());
  const set = (next) => {
    doc = next;
    changed();
  };

  async function write(save) {
    const hash = current(); // what is being written, even if edits happen while the dialog is open
    const result = await save(serialize());
    if (!result) return null;
    set({ name: result.name, ref: result.ref ?? null, savedHash: hash });
    return result.name;
  }

  const api = {
    get name() { return doc.name; },
    get ref() { return doc.ref; },
    isDirty() { return doc.savedHash !== current(); },
    info() { return { name: doc.name, ref: doc.ref, dirty: api.isDirty() }; },
    // a fresh, unchanged document (New, or nothing restored on start)
    reset(name = UNTITLED) {
      set({ name, ref: null, savedHash: current() });
    },
    // Open a file: load(data) puts it in the app. Returns the name, or null when cancelled.
    async open(load) {
      const file = await backend.open();
      if (!file) return null;
      const data = JSON.parse(file.text);
      await load(data);
      // older .json projects are not overwritten: Save asks for a new .mds file
      const ref = file.name.toLowerCase().endsWith(EXT) ? file.ref ?? null : null;
      set({ name: file.name, ref, savedHash: current() });
      return file.name;
    },
    // Save to the current file (Save As when it has none). Returns the name, or null when cancelled.
    async save() {
      if (doc.ref === null || doc.ref === undefined) return api.saveAs();
      const name = await write((text) => backend.save(doc.ref, text));
      return name ?? api.saveAs();
    },
    saveAs() {
      return write((text) => backend.saveAs(suggestName(doc.name), text));
    },
    // stored in the autosave, so a restart restores the file name and the unsaved state
    toJSON() {
      return { name: doc.name, ref: typeof doc.ref === 'string' ? doc.ref : null, savedHash: doc.savedHash };
    },
    // from an autosave; one without document info counts as unsaved
    restore(saved) {
      set({
        name: typeof saved?.name === 'string' && saved.name ? saved.name : UNTITLED,
        ref: typeof saved?.ref === 'string' ? saved.ref : null,
        savedHash: typeof saved?.savedHash === 'string' ? saved.savedHash : null,
      });
    },
  };
  return api;
}

// ---- backends ----

// Desktop app: electron/preload.cjs exposes the native file dialogs.
export function electronBackend(files) {
  return {
    open: () => files.open(),
    save: (ref, text) => files.save(ref, text),
    saveAs: (name, text) => files.saveAs(name, text),
  };
}

const TYPES = [{ description: 'PHILSYNTH project', accept: { 'application/x-modsynth': ['.mds'] } }];
const OPEN_TYPES = [{ description: 'PHILSYNTH project', accept: { 'application/x-modsynth': ['.mds', '.json'] } }];

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
  async function writeTo(handle, text) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }
  return {
    async open() {
      let handle;
      try {
        [handle] = await win.showOpenFilePicker({ types: OPEN_TYPES, multiple: false });
      } catch (err) {
        if (cancelled(err)) return null;
        throw err;
      }
      const file = await handle.getFile();
      return { name: file.name, ref: await remember(handle), text: await file.text() };
    },
    async save(ref, text) {
      let handle = handles.get(ref);
      if (!handle) {
        try { handle = await store.get(ref); } catch { handle = null; }
        if (!handle) return null;
        handles.set(ref, handle);
      }
      try {
        if ((await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted'
          && (await handle.requestPermission?.({ mode: 'readwrite' })) === 'denied') return null;
        await writeTo(handle, text);
      } catch (err) {
        console.warn('Saving to the project file failed, asking for a new one:', err);
        return null;
      }
      return { name: handle.name, ref };
    },
    async saveAs(name, text) {
      let handle;
      try {
        handle = await win.showSaveFilePicker({ suggestedName: name, types: TYPES });
      } catch (err) {
        if (cancelled(err)) return null;
        throw err;
      }
      await writeTo(handle, text);
      return { name: handle.name, ref: await remember(handle) };
    },
  };
}

// Any browser: a file input opens, a download saves (each Save downloads the file again).
export function downloadBackend(fileInput, doc = document) {
  const download = (name, text) => {
    const blob = new Blob([text], { type: 'application/octet-stream' });
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
          try { resolve({ name: file.name, ref: null, text: await file.text() }); } catch (err) { reject(err); }
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
  return downloadBackend(fileInput);
}
