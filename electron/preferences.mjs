import { readFile, stat } from 'node:fs/promises';
import { parsePreferences } from '../src/preferences.js';
import { atomicWrite } from './atomicwrite.mjs';
import { LAUNCH_FULLSCREEN_ID, DEFAULT_LAUNCH_FULLSCREEN } from '../src/interfacepreferences.js';

const MAX_BYTES = 1024 * 1024;

export async function readPreferencesFile(file) {
  try {
    if ((await stat(file)).size > MAX_BYTES) throw new Error('Preferences file is too large');
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function launchFullscreen(file) {
  const text = await readPreferencesFile(file);
  const values = text === null ? {} : parsePreferences(text);
  if (!Object.hasOwn(values, LAUNCH_FULLSCREEN_ID)) return DEFAULT_LAUNCH_FULLSCREEN;
  if (typeof values[LAUNCH_FULLSCREEN_ID] !== 'boolean') throw new Error('Invalid Launch in full screen preference');
  return values[LAUNCH_FULLSCREEN_ID];
}

export function showLaunchWindow(window, fullscreen) {
  if (fullscreen) window.setFullScreen(true); // Some Wayland window managers ignore the constructor option.
  else window.maximize();
  window.show();
}

export function registerPreferences(ipcMain, file, isLocal) {
  let saving = false;
  const check = (event) => {
    if (!isLocal(event.senderFrame?.url)) throw new Error('Untrusted preferences request');
  };
  ipcMain.handle('preferences:load', async (event) => {
    check(event);
    return readPreferencesFile(file);
  });
  ipcMain.handle('preferences:save', async (event, text) => {
    check(event);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Invalid preferences data');
    parsePreferences(text);
    if (saving) throw new Error('Preferences are already being saved');
    saving = true;
    try {
      await atomicWrite(file, text);
    } finally {
      saving = false;
    }
  });
}
