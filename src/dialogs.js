// Small in-app dialogs. Native confirm()/prompt() are avoided: they crash Electron on some
// Linux (Wayland/GTK) desktops and look out of place.
import { SIG_DENS, SIG_NUM_MAX, validSig, normalizeGridBeats, isBlack } from './song.js';

const $ = (id) => document.getElementById(id);

// Resolves with the button value ('ok', 'cancel', ...) when the dialog closes ('' on Escape).
function run(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

export async function confirmDialog(text, { title = 'Are you sure?', ok = 'OK', cancel = 'Cancel', focus = 'ok' } = {}) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  $('confirm-cancel').textContent = cancel;
  const result = run($('confirm-dialog'));
  if (focus === 'cancel') $('confirm-cancel').focus();
  return (await result) === 'ok';
}

export async function infoDialog(text, { title = 'Information' } = {}) {
  const cancel = $('confirm-cancel');
  cancel.hidden = true;
  try {
    await confirmDialog(text, { title });
  } finally {
    cancel.hidden = false;
  }
}

// Classic Yes / No / Cancel before the project is replaced. Resolves 'yes', 'no' or 'cancel' (also Escape).
export async function unsavedDialog(name, { action = 'closing it' } = {}) {
  $('unsaved-title').textContent = `Save changes to "${name}"?`;
  $('unsaved-text').textContent = `Your changes will be lost if you don't save them before ${action}.`;
  const r = await run($('unsaved-dialog'));
  return r === 'yes' || r === 'no' ? r : 'cancel';
}

export async function exportLevelDialog() {
  const result = await run($('export-level-dialog'));
  return result === 'original' || result === 'normalize' ? result : null;
}

// Ask for a time signature. Resolves with { num, den, gridBeats }, 'delete', or null (cancelled).
export async function sigDialog({ num, den, gridBeats, where = '', title = 'Time signature', canDelete = false }) {
  const n = $('sig-num');
  const d = $('sig-den');
  if (!d.options.length) for (const v of SIG_DENS) d.add(new Option(String(v), v));
  n.max = SIG_NUM_MAX;
  n.value = num;
  d.value = den;
  let count = num;
  let enabled = new Set(normalizeGridBeats(gridBeats, num));
  const preview = $('sig-measure');
  function paintMeasure(event) {
    const next = Math.round(+n.value);
    if (!validSig(next, +d.value)) return;
    if (event) enabled = new Set(normalizeGridBeats(undefined, next));
    count = next;
    $('sig-measure-title').textContent = `Grid beats in one ${count}/${d.value} measure`;
    preview.replaceChildren();
    const stave = document.createElement('div');
    stave.className = 'sig-stave';
    stave.setAttribute('aria-hidden', 'true');
    for (let pitch = 48; pitch < 72; pitch++) {
      if (!isBlack(pitch)) continue;
      const line = document.createElement('span');
      line.className = 'sig-stave-line';
      line.classList.toggle('three', [6, 8, 10].includes(pitch % 12));
      line.classList.toggle('central', pitch === 61 || pitch === 63);
      line.style.left = `${(pitch - 48 + 0.5) * 100 / 24}%`;
      stave.append(line);
    }
    preview.append(stave);
    for (let beat = 0; beat < count; beat++) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sig-beat';
      row.classList.toggle('bar', beat === 0);
      row.setAttribute('aria-label', `Beat ${beat + 1} grid line`);
      row.setAttribute('aria-pressed', enabled.has(beat));
      const label = document.createElement('span');
      label.className = 'sig-beat-label';
      label.textContent = beat + 1;
      row.append(label);
      row.addEventListener('click', () => {
        if (enabled.has(beat)) enabled.delete(beat); else enabled.add(beat);
        row.setAttribute('aria-pressed', enabled.has(beat));
      });
      preview.append(row);
    }
  }
  n.addEventListener('input', paintMeasure);
  d.addEventListener('change', paintMeasure);
  paintMeasure();
  $('sig-title').textContent = title;
  $('sig-where').textContent = where;
  $('sig-delete').hidden = !canDelete;
  setTimeout(() => n.select());
  let r;
  try {
    r = await run($('sig-dialog'));
  } finally {
    n.removeEventListener('input', paintMeasure);
    d.removeEventListener('change', paintMeasure);
  }
  if (r === 'delete') return 'delete';
  if (r !== 'ok') return null;
  const sig = { num: Math.round(+n.value), den: +d.value, gridBeats: [...enabled].sort((a, b) => a - b) };
  return validSig(sig.num, sig.den) ? sig : null;
}
