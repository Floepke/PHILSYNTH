// Run: xvfb-run -a node_modules/.bin/electron test/history-ui.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
app.whenReady().then(async () => {
  let server;
  let win;
  try {
    const index = (await readFile(resolve(root, 'index.html'), 'utf8'))
      .replace('<script type="module" src="src/main.js"></script>', `<script type="module">
        import { Engine } from '/src/engine.js';
        import { PatchRuntime } from '/src/patch.js';
        import { dspTestHost } from '/test/dsphost.mjs';
        Engine.prototype.init = async function () {
          this.ctx = { currentTime: 0, state: 'running' };
          this.dsp = dspTestHost().dsp;
          this.root = await PatchRuntime.create(this, this.dsp.destination);
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => Object.assign(new EventTarget(), { inputs: new Map() }) });
        await import('/src/main.js');
      </script>`);
    server = http.createServer(async (req, res) => {
      try {
        const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
        let body = path === root ? index : await readFile(path);
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.historyTest = { engine, undoHistory, seq };\n';
        res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error(event.message);
    });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const run = (code) => win.webContents.executeJavaScript(code);
    for (let i = 0; !(await run('!!window.historyTest')); i++) {
      if (i > 100) throw new Error('Application did not initialize');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await run(`(async () => {
      const { addClip, emptySong } = await import('/src/song.js');
      const { engine, seq, undoHistory } = window.historyTest;
      engine.song = emptySong();
      const osc = await engine.root.addModule('OSC');
      const clip = addClip(engine.song, { length: 16, target: osc.id });
      clip.notes.push({ pitch: 60, start: 0, length: 1, vel: 0.8 });
      engine.song.selected = clip.id;
      seq.reload();
      undoHistory.reset();
      window.rollKey = (key, props = {}) => {
        const cv = document.querySelector('#roll canvas');
        cv.focus();
        cv.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...props }));
      };
    })()`);
    const pitch = () => run('window.historyTest.engine.song.clips[0].notes[0].pitch');
    for (let i = 1; i <= 3; i++) {
      await run("window.rollKey('a', { ctrlKey: true }); window.rollKey('ArrowRight')");
      assert.equal(await pitch(), 60 + i);
    }
    for (let i = 2; i >= 0; i--) {
      await run("window.rollKey('z', { ctrlKey: true })");
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(await pitch(), 60 + i, `undo ${3 - i} restores the previous piano-roll edit`);
      assert.equal(await run("document.getElementById('status').textContent"), 'Undo');
    }
    for (let i = 1; i <= 3; i++) {
      await run("window.rollKey('z', { ctrlKey: true, shiftKey: true })");
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(await pitch(), 60 + i, `redo ${i} restores the piano-roll edit`);
    }
    await run("window.rollKey('z', { ctrlKey: true })");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await pitch(), 62);
    await run("window.rollKey('a', { ctrlKey: true }); window.rollKey('ArrowLeft')");
    assert.equal(await pitch(), 61);
    await run("window.rollKey('y', { ctrlKey: true })");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await pitch(), 61, 'a new edit after undo clears the redo branch');
    assert.equal(await run("document.getElementById('status').textContent"), 'Nothing to undo / redo.');
    await run("window.rollKey('z', { metaKey: true })");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await pitch(), 62, 'Cmd+Z undoes the new branch independently');
    console.log('piano-roll history UI tests passed');
    win.show();
    await run(`(() => {
      window.modsynthFiles = {};
      window.rulerLocks = 0;
      const cv = document.querySelector('#arranger canvas');
      const request = cv.requestPointerLock.bind(cv);
      cv.requestPointerLock = () => { window.rulerLocks++; return request(); };
    })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const rulerPoint = await run(`(() => {
      const cv = document.querySelector('#arranger canvas'), b = cv.getBoundingClientRect();
      const g = cv.getContext('2d');
      g.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      const x0 = Math.round(14 + g.measureText('TimeLine:').width);
      const v = window.historyTest.seq.viewState().arranger;
      return { x: Math.round(b.left + x0 + 6.1 * v.ppq - v.sx), y: Math.round(b.top + 51) };
    })()`);
    for (const clickCount of [1, 2]) {
      win.webContents.sendInputEvent({ type: 'mouseDown', ...rulerPoint, button: 'left', clickCount });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...rulerPoint, button: 'left', clickCount });
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(await run('window.historyTest.engine.song.restart'), 8, 'real desktop double-click places restart at the nearest barline');
    assert.equal(await run('window.rulerLocks'), 0, 'clicks never enter pointer lock');
    console.log('desktop ruler double-click tests passed');
  } finally {
    win?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}).then(() => app.quit()).catch((err) => { console.error(err); app.exit(1); });
