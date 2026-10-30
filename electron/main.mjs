// ModSynth desktop app:  npm start   (or: npx electron .)
// Runs the dev server in-process (static files, disk autosave, live reload) and opens the app
// in a Chromium window where Web MIDI is allowed without a prompt.
import { app, BrowserWindow, Menu, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A fixed port keeps the same origin, so the browser-storage autosave survives restarts.
const PORT = Number(process.env.MODSYNTH_PORT) || 8767;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRUSTED = new Set(['midi', 'midiSysex', 'media', 'clipboard-sanitized-write', 'fullscreen']);

// audio may start without a click first (the AudioContext resumes on load)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let server = null;

async function startServer() {
  process.env.HOST = '127.0.0.1';
  server = await import(pathToFileURL(join(ROOT, 'server.mjs')).href);
  try {
    return await server.start(PORT);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.warn(`Port ${PORT} is in use, using a free port (browser-storage autosave starts empty there; the disk autosave still restores)`);
    return server.start(0);
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#050505',
    title: 'ModSynth',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  // links to other sites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  // No menu bar (Alt is used for duplicating modules); keep the useful shortcuts.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) win.webContents.toggleDevTools();
    else if (input.key === 'F5' || (ctrl && !input.shift && key === 'r')) win.webContents.reload();
    else if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (ctrl && (key === '=' || key === '+')) win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
    else if (ctrl && key === '-') win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
    else if (ctrl && key === '0') win.webContents.setZoomLevel(0);
    else if (ctrl && key === 'q') app.quit();
    else return;
    e.preventDefault();
  });
  win.on('closed', () => (win = null));
  win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const port = await startServer();
    const url = `http://127.0.0.1:${port}/`;
    const local = (u) => typeof u === 'string' && u.startsWith(url);
    // Web MIDI (and the other trusted features) are granted to the app's own pages only
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(TRUSTED.has(permission) && local(details.requestingUrl || wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => TRUSTED.has(permission) && local(`${origin}/`));
    createWindow(url);
    console.log(`ModSynth app running (${url})`);
  });

  let quitting = false;
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting || !server) return;
    // let the last autosave PUT (sent on pagehide) reach the disk before the server goes away
    e.preventDefault();
    quitting = true;
    setTimeout(() => server.stop().finally(() => app.quit()), 300);
  });
}
