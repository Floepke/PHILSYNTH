import { readFile, stat } from 'node:fs/promises';
import { parsePreferences } from '../src/preferences.js';
import { atomicWrite } from './atomicwrite.mjs';

const MAX_BYTES = 1024 * 1024;

export function registerPreferences(ipcMain, file, isLocal) {
  let saving = false;
  const check = (event) => {
    if (!isLocal(event.senderFrame?.url)) throw new Error('Untrusted preferences request');
  };
  ipcMain.handle('preferences:load', async (event) => {
    check(event);
    try {
      if ((await stat(file)).size > MAX_BYTES) throw new Error('Preferences file is too large');
      return await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
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
