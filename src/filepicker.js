// The app's own Open / Save dialog for the desktop app (Electron), in the wooden dialog style.
// Browsers keep their own pickers (src/projectfile.js, src/filedialog.js). Folders are browsed
// through window.modsynthFiles (electron/preload.cjs -> electron/fsbrowse.mjs), which only lists
// folders and files with the app's own extensions.
//
//   pickFile(files, { mode: 'open' | 'save', dialog, title, types, exts, saveExt, suggestedName })
//     -> { path, name } of the chosen file, or null when cancelled.
//   dialog: which remembered start folder ('project-open', 'project-save', 'clip', 'module', 'audio', 'midi')
//   types: label of the listed file types; exts: listed extensions; saveExt: added when saving
//   preview(entry | null): optional instrument preview, stopped on deselection / close
//
// Mouse: click opens a folder or selects a file, double-click picks a file. Keys in the list: arrows,
// Home / End, PageUp / PageDown, Enter, Backspace (up a folder), letters jump to a name.
// Saving over an existing file asks first. Right-click manages the listed entries; the in-app
// clipboard is shared between picker sessions, and deletion is permanent after confirmation.
import { confirmDialog } from './dialogs.js';
import { showMenu } from './seq/menu.js';
import { registerShortcutMenu } from './shortcuts.js';

let clipboard = null;

// folders first, then by name (case-insensitive, numbers in natural order)
export function sortEntries(entries) {
  return [...entries].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export function formatSize(bytes) {
  if (!(bytes >= 0)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// type-ahead: index of the next entry after `from` whose name starts with `prefix`, or -1
export function findPrefix(entries, prefix, from = -1) {
  const p = prefix.toLowerCase();
  const n = entries.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k + n) % n;
    if (entries[i].name.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

// the file name without its extension, for preselecting in the name field
export const baseLength = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
};

// message of an error from ipcRenderer.invoke, without Electron's prefix
export const errorText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

export function saveExtension(name, selected, formats = []) {
  return formats.find(format => name.toLowerCase().endsWith(format.ext))?.ext ?? selected;
}

export async function pickFile(files, opts, doc = document) {
  const { mode = 'open', dialog, title = mode === 'save' ? 'Save' : 'Open', types = '', exts = [], suggestedName = '' } = opts;
  let saveExt = opts.saveExt ?? exts[0];
  const save = mode === 'save';
  const $ = (id) => doc.getElementById(id);
  const dlg = $('file-dialog');
  const list = $('fd-list');
  const nameInput = $('fd-name');
  const okBtn = $('fd-ok');
  const start = await files.start(dialog);

  let dir = null;
  let parent = null;
  let entries = [];
  let sel = -1;
  let token = 0;
  let editing = null; // new-folder input while it is shown
  let typed = '';
  let typedAt = 0;
  let result = null;
  let menu = null;
  let busy = false;
  let finished = false;
  let previewOn = false;
  let previewToken = 0;
  const ac = new AbortController();
  const on = (el, type, fn) => el.addEventListener(type, fn, { signal: ac.signal });

  $('fd-title').textContent = title;
  $('fd-types').textContent = types;
  const previewBtn = $('fd-preview');
  previewBtn.hidden = save || !opts.preview;
  previewBtn.setAttribute('aria-checked', 'false');
  on(previewBtn, 'click', () => {
    previewOn = !previewOn;
    previewBtn.setAttribute('aria-checked', String(previewOn));
    updatePreview();
  });
  if (save && opts.formats?.length) {
    $('fd-types').textContent = `${types} `;
    const select = doc.createElement('select');
    select.setAttribute('aria-label', 'Audio file format');
    for (const format of opts.formats) select.add(new Option(format.label, format.ext));
    select.value = saveExt;
    on(select, 'change', () => {
      const previous = saveExt;
      saveExt = select.value;
      const name = nameInput.value;
      if (name.toLowerCase().endsWith(previous)) nameInput.value = name.slice(0, -previous.length) + saveExt;
    });
    $('fd-types').append(select);
  }
  $('fd-name-row').hidden = !save;
  okBtn.textContent = save ? 'Save' : 'Open';
  nameInput.value = save ? suggestedName : '';
  error('');

  function error(text) {
    $('fd-error').textContent = text;
  }

  async function updatePreview(entry = entries[sel]) {
    if (!opts.preview) return;
    const mine = ++previewToken;
    error('');
    try {
      await opts.preview(!finished && previewOn && entry && !entry.dir ? entry : null);
    } catch (err) {
      if (!finished && mine === previewToken) error(`Cannot preview instrument: ${errorText(err)}`);
    }
  }

  function stopPreview() {
    if (finished) return;
    finished = true;
    token++;
    updatePreview(null);
  }

  function renderPlaces() {
    const box = $('fd-places');
    box.replaceChildren(...start.places.map((p) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'fd-place';
      b.textContent = p.name;
      b.title = p.path;
      b.setAttribute('aria-current', String(p.path === dir));
      b.onclick = () => { if (!busy) go(p.path); };
      return b;
    }));
  }

  function renderCrumbs(crumbs) {
    const nav = $('fd-crumbs');
    const parts = [];
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const s = doc.createElement('span');
        s.className = 'fd-sep';
        s.textContent = '›';
        parts.push(s);
      }
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'fd-crumb';
      b.textContent = c.name;
      b.title = c.path;
      b.onclick = () => { if (!busy) go(c.path); };
      parts.push(b);
    });
    nav.replaceChildren(...parts);
    nav.scrollLeft = nav.scrollWidth; // the current folder stays in sight
  }

  function renderList() {
    const rows = entries.map((e, i) => {
      const row = doc.createElement('div');
      row.className = `fd-row${e.dir ? ' fd-dir' : ''}`;
      row.setAttribute('role', 'option');
      row.dataset.i = i;
      row.setAttribute('aria-selected', String(i === sel));
      const icon = doc.createElement('span');
      icon.className = 'fd-icon';
      icon.setAttribute('aria-hidden', 'true');
      const name = doc.createElement('span');
      name.className = 'fd-file';
      name.textContent = e.name;
      name.title = e.name;
      const size = doc.createElement('span');
      size.className = 'fd-size';
      size.textContent = e.dir ? '' : formatSize(e.size);
      const date = doc.createElement('span');
      date.className = 'fd-date';
      date.textContent = formatDate(e.mtime);
      row.append(icon, name, size, date);
      return row;
    });
    if (!rows.length) {
      const empty = doc.createElement('div');
      empty.className = 'fd-empty';
      empty.textContent = 'No matching files in this folder';
      rows.push(empty);
    }
    list.replaceChildren(...rows);
    $('fd-up').disabled = !parent;
    updateOk();
  }

  function updateOk() {
    okBtn.disabled = !save && !(entries[sel]);
  }

  function select(i, { scroll = true } = {}) {
    if (!entries.length) return;
    sel = Math.max(0, Math.min(entries.length - 1, i));
    for (const row of list.querySelectorAll('.fd-row')) row.setAttribute('aria-selected', String(+row.dataset.i === sel));
    if (scroll) list.querySelector(`.fd-row[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
    const e = entries[sel];
    if (save && e && !e.dir) nameInput.value = e.name;
    updateOk();
    updatePreview();
  }

  async function go(path, selectName = null) {
    if (finished) return false;
    updatePreview(null);
    menu?.();
    menu = null;
    const my = ++token;
    try {
      const r = await files.list(path, exts);
      if (my !== token) return false;
      dir = r.dir;
      parent = r.parent;
      entries = sortEntries(r.entries);
      sel = -1;
      error('');
      renderCrumbs(r.crumbs);
      renderPlaces();
      renderList();
      list.scrollTop = 0;
      if (selectName !== null) {
        const i = entries.findIndex((e) => e.name === selectName);
        if (i >= 0) select(i);
      }
      return true;
    } catch (err) {
      if (my !== token) return false;
      error(`Cannot open "${path}": ${errorText(err)}`);
      return false;
    }
  }

  function up() {
    if (!parent || busy) return;
    const from = dir.split(/[\\/]/).filter(Boolean).pop() ?? null;
    go(parent, from);
  }

  function finish(path, name) {
    result = { path, name };
    stopPreview();
    dlg.close();
  }

  // Enter / double-click / OK on entry i (or the OK button without a selection)
  async function activate(i) {
    if (busy) return;
    const e = entries[i];
    if (e?.dir) return go(e.path);
    if (e && !save) return finish(e.path, e.name);
    if (!save) return error('Choose a file.');
    if (e) nameInput.value = e.name;
    return accept();
  }

  async function accept() {
    if (busy) return;
    if (!save) return activate(sel);
    const name = nameInput.value.trim();
    if (!name) {
      error('Type a file name.');
      nameInput.focus();
      return;
    }
    if (!dir) return;
    let t;
    try {
      t = await files.target(dir, name, saveExtension(name, saveExt, opts.formats));
    } catch (err) {
      error(errorText(err) === 'Invalid name' ? 'A file name cannot contain / or \\.' : errorText(err));
      return;
    }
    if (t.dir) {
      // a folder name was typed: open it, keep the suggested name
      if (await go(t.path)) nameInput.value = suggestedName;
      return;
    }
    if (t.exists && !(await confirmDialog(`"${t.name}" already exists in this folder. Do you want to replace it?`, { title: 'Replace file?', ok: 'Replace' }))) {
      nameInput.focus();
      return;
    }
    finish(t.path, t.name);
  }

  function newFolder() {
    if (editing || busy || !dir) return;
    const row = doc.createElement('div');
    row.className = 'fd-row fd-dir fd-new';
    const icon = doc.createElement('span');
    icon.className = 'fd-icon';
    const input = doc.createElement('input');
    input.className = 'fd-new-name';
    input.value = 'New folder';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'New folder name');
    row.append(icon, input);
    list.prepend(row);
    list.scrollTop = 0;
    editing = input;
    input.focus();
    input.select();
    const close = () => {
      editing = null;
      row.remove();
    };
    input.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        list.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return close();
        try {
          await files.mkdir(dir, name);
          close();
          await go(dir, name);
          list.focus();
        } catch (err) {
          error(`Cannot create the folder: ${errorText(err)}`);
          input.focus();
        }
      }
    });
    input.addEventListener('blur', () => { if (editing === input) setTimeout(() => { if (editing === input && doc.activeElement !== input) close(); }); });
  }

  function renameEntry(entry, row) {
    if (editing || busy) return;
    const label = row.querySelector('.fd-file');
    const input = doc.createElement('input');
    input.className = 'fd-new-name';
    input.value = entry.name;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'New name');
    label.replaceWith(input);
    editing = input;
    input.focus();
    input.setSelectionRange(0, entry.dir ? entry.name.length : baseLength(entry.name));
    const close = () => {
      if (editing !== input) return;
      editing = null;
      input.replaceWith(label);
    };
    input.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        list.focus();
      } else if (e.key === 'Enter' && !busy) {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) { error('Type a name.'); return; }
        if (name === entry.name) { close(); list.focus(); return; }
        busy = true;
        input.disabled = true;
        try {
          const path = await files.transfer(entry.path, entry.dir, dir, true, name);
          if (clipboard?.path === entry.path) { clipboard.path = path; clipboard.name = name; }
          close();
          await go(dir, name);
          list.focus();
        } catch (err) {
          error(`Cannot rename "${entry.name}": ${errorText(err)}`);
          input.disabled = false;
          input.focus();
        } finally {
          busy = false;
        }
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => { if (!busy && editing === input && doc.activeElement !== input) close(); });
    });
  }

  async function paste(destination) {
    if (!clipboard || busy) return;
    const item = clipboard;
    busy = true;
    try {
      const path = await files.transfer(item.path, item.dir, destination, item.cut);
      if (item.cut && clipboard === item) clipboard = null;
      if (dir === destination) await go(dir, path.split(/[\\/]/).pop());
      else await go(dir);
      list.focus();
    } catch (err) {
      error(`Cannot paste "${item.name}": ${errorText(err)}`);
    } finally {
      busy = false;
    }
  }

  async function removeEntry(entry) {
    if (busy) return;
    busy = true;
    try {
      const kind = entry.dir ? 'folder' : 'file';
      const description = entry.dir
        ? `Permanently delete folder "${entry.name}" and all its contents, including hidden files?`
        : `Permanently delete file "${entry.name}"?`;
      if (!(await confirmDialog(description, { title: `Delete ${kind}?`, ok: 'Yes', cancel: 'No', focus: 'cancel' }))) return;
      if (entry.dir && !(await confirmDialog(`Are you absolutely sure? The folder "${entry.name}" and everything inside it will be permanently deleted.`, {
        title: 'Confirm folder deletion', ok: 'Yes', cancel: 'No', focus: 'cancel',
      }))) return;
      await files.deleteEntry(entry.path, entry.dir);
      if (clipboard?.path === entry.path) clipboard = null;
      await go(dir);
      list.focus();
    } catch (err) {
      error(`Cannot delete "${entry.name}": ${errorText(err)}`);
    } finally {
      busy = false;
    }
  }

  function fileMenuItems(entry, row) {
    const destination = entry?.dir ? entry.path : dir;
    return entry ? [
      { label: 'Cut', action: () => { clipboard = { ...entry, cut: true }; } },
      { label: 'Copy', action: () => { clipboard = { ...entry, cut: false }; } },
      { label: 'Paste', disabled: !clipboard, action: () => paste(destination) },
      '-',
      { label: 'Rename', action: () => renameEntry(entry, row) },
      { label: 'Delete', action: () => removeEntry(entry) },
    ] : [{ label: 'Paste', disabled: !clipboard, action: () => paste(destination) }];
  }
  const unregisterShortcuts = registerShortcutMenu('filepicker', () => fileMenuItems(
    entries[sel], list.querySelector(`.fd-row[data-i="${sel}"]`),
  ), { active: () => dlg.open && !busy && !editing && doc.activeElement === list, dialog: 'file-dialog' });
  on(list, 'contextmenu', (e) => {
    e.preventDefault();
    if (busy || editing) return;
    const row = e.target.closest('.fd-row[data-i]');
    const entry = row ? entries[+row.dataset.i] : null;
    if (entry) select(+row.dataset.i, { scroll: false });
    menu = showMenu({ x: e.clientX, y: e.clientY, items: fileMenuItems(entry, row), shortcutScope: 'filepicker', container: dlg, className: 'fd-context-menu', onClose: () => { menu = null; } });
  });

  on(list, 'click', (e) => {
    if (busy) return;
    const row = e.target.closest('.fd-row[data-i]');
    if (!row) return;
    if (entries[+row.dataset.i]?.dir) go(entries[+row.dataset.i].path);
    else select(+row.dataset.i, { scroll: false });
  });
  on(list, 'dblclick', (e) => {
    if (busy) return;
    const row = e.target.closest('.fd-row[data-i]');
    if (row && !entries[+row.dataset.i]?.dir) activate(+row.dataset.i);
  });
  on(list, 'keydown', (e) => {
    if (busy) return;
    if (e.target !== list) return;
    const page = Math.max(1, Math.floor(list.clientHeight / (list.querySelector('.fd-row')?.offsetHeight || 24)) - 1);
    const moves = { ArrowDown: sel + 1, ArrowUp: sel < 0 ? 0 : sel - 1, Home: 0, End: entries.length - 1, PageDown: sel + page, PageUp: sel - page };
    if (e.key in moves && !(e.altKey && e.key === 'ArrowUp')) {
      e.preventDefault();
      select(moves[e.key]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sel >= 0) activate(sel);
      else accept();
    } else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
      e.preventDefault();
      up();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      e.preventDefault();
      const now = e.timeStamp;
      typed = now - typedAt < 800 ? typed + e.key : e.key;
      typedAt = now;
      const i = findPrefix(entries, typed, typed.length > 1 ? sel - 1 : sel);
      if (i >= 0) select(i);
    }
  });
  on(nameInput, 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      accept();
    }
  });
  on($('fd-up'), 'click', up);
  on($('fd-mkdir'), 'click', newFolder);
  on(okBtn, 'click', () => (save ? accept() : activate(sel)));
  on($('fd-cancel'), 'click', () => {
    if (busy) return;
    stopPreview();
    dlg.close();
  });
  // Escape closes the dialog, except while a new folder is being named
  on(dlg, 'cancel', (e) => {
    if (editing || busy) e.preventDefault();
    else stopPreview();
  });

  const closed = new Promise((resolve) => {
    on(dlg, 'close', () => {
      stopPreview();
      menu?.();
      unregisterShortcuts();
      ac.abort();
      editing = null;
      resolve(result);
    });
  });
  dlg.returnValue = '';
  dlg.showModal();
  if (!(await go(start.dir)) && start.places[0]) await go(start.places[0].path);
  if (finished) return closed;
  if (save) {
    nameInput.focus();
    nameInput.setSelectionRange(0, baseLength(nameInput.value));
  } else list.focus();
  return closed;
}
