import { confirmDialog } from './dialogs.js';

let pending = false;

export async function exitToOS(persist, notify) {
  if (pending) return;
  pending = true;
  try {
    const yes = await confirmDialog('Your project will be autosaved before closing.', {
      title: 'Exit to OS?', ok: 'Yes', cancel: 'No',
    });
    if (!yes) return;
    const saved = await persist.flush();
    if (!saved.local && !saved.disk) {
      notify('Exit cancelled: autosave failed. Use Save in the main menu (top-left logo) to keep your project before closing.');
      return;
    }
    // Closes the Electron window. Browsers may refuse to close a manually opened tab.
    window.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!window.closed) notify('Your browser did not close this tab. Close the tab or window manually to exit.');
  } catch (err) {
    console.error('Could not exit MODSYNTH:', err);
    notify(`Exit failed: ${err.message}`);
  } finally {
    pending = false;
  }
}
