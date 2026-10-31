// MODSYNTH desktop app:  npm start   (or: npx electron .)
// Runs the dev server in-process (static files, disk autosave, live reload) and opens the app
// in a Chromium window where Web MIDI is allowed without a prompt.
import { app, BrowserWindow, Menu, session, shell, systemPreferences } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerProjectFiles } from './projectfiles.mjs';

// MODSYNTH.app (npm run build:mac) is its own app next to the dev app (npm start): own name,
// data folder (~/Library/Application Support/MODSYNTH), single-instance lock and port.
// The dev app gets its own folder: macOS file names ignore case, so 'modsynth' (the package name)
// would be the app's 'MODSYNTH' folder and the shared single-instance lock would stop npm start
// while MODSYNTH.app runs.
if (app.isPackaged) {
  app.setName('MODSYNTH');
  app.setPath('userData', join(app.getPath('appData'), 'MODSYNTH'));
} else {
  app.setPath('userData', join(app.getPath('appData'), 'modsynth-dev'));
}

// A fixed port keeps the same origin, so the browser-storage autosave survives restarts.
const PORT = Number(process.env.MODSYNTH_PORT) || (app.isPackaged ? 8768 : 8767);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// fileSystem: writing the file chosen in the Export Audio save dialog (File System Access API)
const TRUSTED = new Set(['midi', 'midiSysex', 'media', 'clipboard-sanitized-write', 'fullscreen', 'fileSystem']);

// audio may start without a click first (the AudioContext resumes on load)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let server = null;

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
    // MODSYNTH.app: autosaves go to ~/Library/Application Support/MODSYNTH/projects, no live reload
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

function createWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#050505',
    title: 'MODSYNTH',
    show: false,
    fullscreen: true, // F11 toggles
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'), // native project files
    },
  });
  win.once('ready-to-show', () => {
    win.setFullScreen(true); // some window managers (Wayland) ignore the constructor option
    win.show();
  });
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
  // Downloads (fallbacks for Export Audio / Save): the save dialog offers the right format
  win.webContents.session.on('will-download', (_e, item) => {
    if (item.getFilename().endsWith('.wav')) {
      item.setSaveDialogOptions({ title: 'Export Audio', filters: [{ name: 'WAV audio', extensions: ['wav'] }] });
      return;
    }
    if (!item.getFilename().endsWith('.mds')) return;
    item.setSaveDialogOptions({ title: 'Save MODSYNTH project', filters: [{ name: 'MODSYNTH project', extensions: ['mds'] }] });
  });
  win.on('closed', () => (win = null));
  // Windows sends the mouse back button as an app command: the page uses it to go up a patch
  // level (src/main.js), never to navigate back
  win.on('app-command', (e, cmd) => { if (cmd === 'browser-backward' || cmd === 'browser-forward') e.preventDefault(); });
  win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  console.log('MODSYNTH is already running: focusing that window.');
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
    registerProjectFiles(local);
    createWindow(url);
    console.log(`MODSYNTH app running (${url})`);
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
