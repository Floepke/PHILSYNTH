// Small in-app dialogs. Native confirm()/prompt() are avoided: they crash Electron on some
// Linux (Wayland/GTK) desktops and look out of place.
import { SIG_DENS, SIG_NUM_MAX, validSig } from './song.js';

const $ = (id) => document.getElementById(id);

// Resolves with the button value ('ok', 'cancel', ...) when the dialog closes ('' on Escape).
function run(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

export async function confirmDialog(text, { title = 'Are you sure?', ok = 'OK' } = {}) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  return (await run($('confirm-dialog'))) === 'ok';
}

// Ask for a time signature. Resolves with { num, den }, 'delete', or null (cancelled).
export async function sigDialog({ num, den, where = '', title = 'Time signature', canDelete = false }) {
  const n = $('sig-num');
  const d = $('sig-den');
  if (!d.options.length) for (const v of SIG_DENS) d.add(new Option(String(v), v));
  n.max = SIG_NUM_MAX;
  n.value = num;
  d.value = den;
  $('sig-title').textContent = title;
  $('sig-where').textContent = where;
  $('sig-delete').hidden = !canDelete;
  setTimeout(() => n.select());
  const r = await run($('sig-dialog'));
  if (r === 'delete') return 'delete';
  if (r !== 'ok') return null;
  const sig = { num: Math.round(+n.value), den: +d.value };
  return validSig(sig.num, sig.den) ? sig : null;
}
