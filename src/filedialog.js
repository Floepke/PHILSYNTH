// Save / open dialogs for small text files (.clip, .phmod, .scl) that start in the folder last used
// for that kind of file, and (desktop app only) the open dialog for the audio / pictures modules load. `kind` names the remembered location:
//   Electron              the app's own file dialog (src/filepicker.js); the main process
//                         (electron/projectfiles.mjs) stores the folders per kind in the app's user data
//   Chromium browsers     showSaveFilePicker / showOpenFilePicker with `id: kind`: the browser
//                         remembers the folder per id (per site, across restarts)
//   other browsers        a download / a file input (the browser decides where)
import { fileAccept, CLIP_EXT, MODULE_EXT, MODULE_OPEN_EXTS, AUDIO_OPEN_EXTS, WAVETABLE_OPEN_EXTS, IMAGE_OPEN_EXTS, MIDI_OPEN_EXTS, MAX_MIDI_BYTES } from './fileformat.js';
import { pickFile } from './filepicker.js';

// ext: saved files; open: extensions the open dialog offers (older ones included)
export const KINDS = {
  clip: { description: 'PHILSYNTH clip', ext: CLIP_EXT, open: [CLIP_EXT] },
  module: { description: 'PHILSYNTH module', ext: MODULE_EXT, open: MODULE_OPEN_EXTS },
  scala: { description: 'Scala tuning', ext: '.scl', open: ['.scl', '.scala', '.txt'] },
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
    const input = Object.assign(win.document.createElement('input'), { type: 'file', accept: fileAccept(open, win.navigator) });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try { resolve({ name: file.name, text: await file.text() }); } catch (err) { reject(err); }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

// Audio / pictures for SAMPLER, WAVETABLE and IMAGE SAMPLER: in the desktop app through its own
// dialog (browsers keep the modules' file inputs, see hasMediaDialog).
export const MEDIA_KINDS = {
  sample: { description: 'Audio file', open: AUDIO_OPEN_EXTS },
  wavetable: { description: 'Wavetable', open: WAVETABLE_OPEN_EXTS },
  image: { description: 'Picture', open: IMAGE_OPEN_EXTS },
};
const MIME = {
  '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
};
const mimeOf = (name) => MIME[/\.[^.]+$/.exec(name)?.[0].toLowerCase()] ?? '';

export const hasMediaDialog = (win = window) => typeof win.modsynthFiles?.openBinary === 'function';

// -> a File (name + bytes, as from a file input), null when cancelled. Desktop app only.
export async function openMediaFile(kind, win = window, pick = pickFile) {
  const { description, open } = MEDIA_KINDS[kind];
  const files = win.modsynthFiles;
  const f = await pick(files, { mode: 'open', dialog: kind, title: `Open ${description}`, types: `${description}s (${open.join(', ')})`, exts: open });
  if (!f) return null;
  const { name, data } = await files.openBinary(kind, f.path);
  return new win.File([data], name, { type: mimeOf(name) });
}

// Binary Standard MIDI File import, using the desktop picker or the browser's file picker.
export async function openMidiFile(win = window, pick = pickFile) {
  const files = win.modsynthFiles;
  if (files?.openBinary) {
    const f = await pick(files, { mode: 'open', dialog: 'midi', title: 'Import MIDI', types: 'MIDI files (.mid, .midi)', exts: MIDI_OPEN_EXTS });
    return f ? files.openBinary('midi', f.path) : null;
  }
  const read = async (file) => {
    if (file.size > MAX_MIDI_BYTES) throw new Error('MIDI file is too large (maximum 32 MB)');
    return { name: file.name, data: await file.arrayBuffer() };
  };
  if (typeof win.showOpenFilePicker === 'function') {
    let handle;
    try {
      [handle] = await win.showOpenFilePicker({ id: 'midi', multiple: false, types: [{ description: 'MIDI file', accept: { 'audio/midi': MIDI_OPEN_EXTS } }] });
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
    return read(await handle.getFile());
  }
  return new Promise((resolve, reject) => {
    const input = Object.assign(win.document.createElement('input'), { type: 'file', accept: MIDI_OPEN_EXTS.join(',') });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      try { resolve(await read(file)); } catch (err) { reject(err); }
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
