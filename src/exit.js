import { confirmDialog } from './dialogs.js';

let pending = false;

export async function exitToOS(persist, notify) {
  if (pending) return;
  pending = true;
  try {
    const dialog = document.getElementById('confirm-dialog');
    const keys = (e) => {
      if (!['Escape', 'Enter'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) dialog.close(e.key === 'Enter' ? 'ok' : 'cancel');
    };
    dialog.addEventListener('keydown', keys);
    let yes;
    try {
      yes = await confirmDialog('Your project will be autosaved before closing.', {
        title: 'Exit to OS?', ok: 'Yes', cancel: 'No',
      });
    } finally {
      dialog.removeEventListener('keydown', keys);
    }
    if (!yes) return;
    const saved = await persist.flush();
    if (!saved.local && !saved.disk) {
      notify('Exit cancelled: autosave failed. Use Save in the main menu (top-right logo) to keep your project before closing.');
      return;
    }
    if (window.modsynthExit) {
      window.modsynthExit.confirm();
      return;
    }
    // Browsers may refuse to close a manually opened tab.
    window.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!window.closed) notify('Your browser did not close this tab. Close the tab or window manually to exit.');
  } catch (err) {
    console.error('Could not exit PHILSYNTH:', err);
    notify(`Exit failed: ${err.message}`);
  } finally {
    pending = false;
  }
}
