// PHILSYNTH desktop app:  npm start   (or: npx electron .)
// Runs the dev server in-process (static files, disk autosave, live reload) and opens the app
// in a Chromium window where Web MIDI is allowed without a prompt.
import { app, BrowserWindow, Menu, session, shell, systemPreferences, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerProjectFiles } from './projectfiles.mjs';
import { registerExit } from './exit.mjs';
import { contentSecurityPolicy } from './csp.mjs';
import { registerPreferences, launchFullscreen, showLaunchWindow } from './preferences.mjs';
import { DEFAULT_LAUNCH_FULLSCREEN } from '../src/interfacepreferences.js';

// PHILSYNTH.app (npm run build:mac) is its own app next to the dev app (npm start): own name,
// data folder (~/Library/Application Support/PHILSYNTH), single-instance lock and port.
// The dev app gets its own folder: macOS file names ignore case, so 'modsynth' (the package name)
// would be the app's 'PHILSYNTH' folder and the shared single-instance lock would stop npm start
// while PHILSYNTH.app runs.
if (app.isPackaged) {
  app.setName('PHILSYNTH');
  app.setPath('userData', join(app.getPath('appData'), 'PHILSYNTH'));
} else {
  app.setPath('userData', join(app.getPath('appData'), 'modsynth-dev'));
}

// A fixed port keeps the same origin, so the browser-storage autosave survives restarts.
const PORT = Number(process.env.MODSYNTH_PORT) || (app.isPackaged ? 8768 : 8767);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// fileSystem: writing the file chosen in the Export Audio save dialog (File System Access API)
const TRUSTED = new Set(['midi', 'midiSysex', 'media', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem', 'pointerLock']);

// The PATCH instance workers ask for real-time priority through this module (Node in workers:
// see createWindow; src/dsp/instanceworker.js reads the path, renderer processes inherit it)
process.env.MODSYNTH_REALTIME = join(ROOT, 'electron', 'realtime.cjs');

// audio may start without a click first (the AudioContext resumes on load)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let server = null;
let exit = null;

// macOS keeps its own microphone permission per app (System Settings > Privacy > Microphone)
async function micAccess() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status !== 'not-determined') return false;
  return systemPreferences.askForMediaAccess('microphone');
}

async function startServer() {
  process.env.HOST = '127.0.0.1';
  if (app.isPackaged) {
    // PHILSYNTH.app: autosaves go to ~/Library/Application Support/PHILSYNTH/projects, no live reload
    process.env.MODSYNTH_PROJECTS ??= join(app.getPath('userData'), 'projects');
    process.env.MODSYNTH_NO_WATCH ??= '1';
  }
  server = await import(pathToFileURL(join(ROOT, 'server.mjs')).href);
  try {
    return await server.start(PORT);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.warn(`Port ${PORT} is in use, using a free port (browser-storage autosave starts empty there; the disk autosave still restores)`);
    return server.start(0);
  }
}

function createWindow(url, fullscreen) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#050505',
    title: 'PHILSYNTH',
    icon: join(ROOT, 'src', 'icon.png'),
    show: false,
    fullscreen, // F11 toggles
    webPreferences: {
      // Node only in workers (the PATCH instance workers request real-time priority,
      // electron/realtime.cjs), which needs the renderer unsandboxed; the page itself has no Node
      // and its Content-Security-Policy (electron/csp.mjs) only runs the app's own code.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: true,
      sandbox: false,
      backgroundThrottling: false,
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'), // native project files
    },
  });
  win.once('ready-to-show', () => {
    showLaunchWindow(win, fullscreen);
  });
  exit = registerExit(app, win, (u) => typeof u === 'string' && u.startsWith(url));
  // links to other sites open in the normal browser; the window never leaves the app
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
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
  // Downloads (fallbacks for Export Audio / Save): the save dialog offers the right format
  win.webContents.session.on('will-download', (_e, item) => {
    const audioExt = /\.(wav|mp3|ogg)$/i.exec(item.getFilename())?.[1].toLowerCase();
    if (audioExt) {
      item.setSaveDialogOptions({ title: 'Export Audio', filters: [{ name: `${audioExt.toUpperCase()} audio`, extensions: [audioExt] }] });
      return;
    }
    if (!item.getFilename().endsWith('.phproject')) return;
    item.setSaveDialogOptions({ title: 'Save PHILSYNTH project', filters: [{ name: 'PHILSYNTH project', extensions: ['phproject'] }] });
  });
  win.on('closed', () => (win = null));
  // Windows sends the mouse back button as an app command: the page uses it to go up a patch
  // level (src/main.js), never to navigate back
  win.on('app-command', (e, cmd) => { if (cmd === 'browser-backward' || cmd === 'browser-forward') e.preventDefault(); });
  win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  console.log('PHILSYNTH is already running: focusing that window.');
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
      const ok = TRUSTED.has(permission) && local(details.requestingUrl || wc.getURL());
      if (!ok || permission !== 'media') return callback(ok);
      // microphone (INPUT module): audio only, and macOS must allow it too (asked once)
      if ((details.mediaTypes ?? []).includes('video')) return callback(false);
      micAccess().then(callback, () => callback(false));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => TRUSTED.has(permission) && local(`${origin}/`));
    // read per page load: index.html's inline script is allowed by its hash (live reload edits it)
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${url}*`] }, (details, callback) => {
      if (details.resourceType !== 'mainFrame') return callback({});
      let csp;
      try { csp = contentSecurityPolicy(readFileSync(join(ROOT, 'index.html'), 'utf8')); }
      catch (err) { console.error('Content-Security-Policy:', err); return callback({ cancel: true }); }
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
    registerProjectFiles(local);
    const preferencesFile = join(app.getPath('userData'), 'preferences.json');
    registerPreferences(ipcMain, preferencesFile, local);
    let fullscreen = DEFAULT_LAUNCH_FULLSCREEN;
    try {
      fullscreen = await launchFullscreen(preferencesFile);
    } catch (err) {
      console.error('Could not load launch preferences; starting in full screen:', err);
    }
    createWindow(url, fullscreen);
    console.log(`PHILSYNTH app running (${url})`);
  });

  let quitting = false;
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (win && !exit?.isApproved()) return;
    if (quitting || !server) return;
    // let the last autosave PUT (sent on pagehide) reach the disk before the server goes away
    e.preventDefault();
    quitting = true;
    setTimeout(() => server.stop().finally(() => app.quit()), 300);
  });
}
