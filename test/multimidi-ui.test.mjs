// Linux: xvfb-run -a node_modules/.bin/electron test/multimidi-ui.test.mjs --no-sandbox
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
app.whenReady().then(async () => {
  let server, win;
  try {
    server = http.createServer(async (req, res) => {
      try {
        const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
        let body = await readFile(path === root ? resolve(root, 'index.html') : path);
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.velocityTest = { engine, select, seq, undoHistory };\n';
        res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.wasm') ? 'application/wasm' : 'text/html' });
        res.end(body);
      } catch (error) {
        if (error.code !== 'ENOENT') console.error(error);
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: true, width: 1200, height: 1100, webPreferences: { backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' && !event.message.includes('404')) {
        errors.push(event.message);
        console.error(event.message);
      }
    });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const run = (code) => win.webContents.executeJavaScript(`(async () => {
      try { return await (${code}); }
      catch (error) { console.error(error.stack); throw error; }
    })()`);
    const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; !(await run('!!window.velocityTest')); i++) {
      if (i > 200) throw new Error('Application did not initialize');
      await wait(20);
    }
    await run(`(async () => {
      const { engine, select, seq, undoHistory } = window.velocityTest;
      const entry = await engine.root.addModule('MULTIMIDI');
      window.velocityId = entry.id;
      seq.applyView({ panelWidth: 450, top: 0, bottom: 1 });
      select({ kind: 'module', entry });
      undoHistory.reset();
      window.velocityState = () => engine.root.modules.get(window.velocityId).state;
    })()`);
    await wait();
    assert.equal(await run(`(() => {
      const panel = document.getElementById('panel');
      const rows = [...panel.querySelectorAll('.ctl')];
      const key = panel.querySelector('.p2c-view');
      const curve = panel.querySelector('.curve-editor');
      return rows.length === 13 && !!(rows.at(-1).compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING)
        && !!(key.compareDocumentPosition(curve) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`), true, 'both reused graph editors appear after all MULTIMIDI controllers');

    const point = async (selector, x, y, keyMap = false) => {
      await run(`document.querySelector('${selector}').scrollIntoView({ block: 'center' })`);
      await wait();
      return run(`(() => {
        const cv = document.querySelector('${selector}'), r = cv.getBoundingClientRect();
        return { x: Math.round(r.left + cv.clientLeft + ${keyMap ? `${x} * cv.clientWidth` : `12 + ${x} * (cv.clientWidth - 24)`}),
          y: Math.round(r.top + cv.clientTop + ${keyMap ? `6 + ${y} * (cv.clientHeight - 36)` : `12 + ${y} * (cv.clientWidth - 24)`}) };
      })()`);
    };
    const click = async (p, clickCount = 1) => {
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...p, clickCount });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...p, clickCount });
      await wait(20);
    };
    await click(await point('.p2c-view canvas', 60.5 / 128, 0.75, true));
    const trimmed = await run('window.velocityState().velocityMap[60]');
    assert.ok(Math.abs(trimmed - 0.25) < 0.01, 'drawing trims the chosen key to 25%');
    assert.deepEqual(await run('window.velocityState().velocityMap.slice(59, 62)'), [1, trimmed, 1], 'neighbouring keys remain independent');
    const p = await point('.curve-editor canvas', 0.5, 0.75);
    await click(p);
    await click(p, 2);
    assert.equal(await run('window.velocityState().velocityCurve.points.length'), 3, 'double-click inserts a response point');
    assert.equal(await run('window.velocityState().velocityMap[60]'), trimmed, 'response edits preserve key trims');
    await run('window.velocityTest.undoHistory.travel(-1)');
    assert.equal(await run('window.velocityState().velocityCurve.points.length'), 2, 'undo restores the previous response');
    assert.equal(await run('window.velocityState().velocityMap[60]'), trimmed);
    await run('window.velocityTest.undoHistory.travel(1)');
    await wait();
    assert.equal(await run('window.velocityState().velocityCurve.points.length'), 3, 'redo restores custom response');
    await run(`window.velocityTest.select({ kind: 'module', entry: window.velocityTest.engine.root.modules.get(window.velocityId) })`);
    await wait();
    await run(`document.querySelector('.p2c-tools button:last-child').click()`);
    assert.equal(await run('window.velocityState().velocityMap.every(v => v === 1)'), true, 'Reset restores all keys to full velocity');
    assert.equal(await run('window.velocityState().velocityCurve.points.length'), 3, 'key reset does not reset response');
    await run(`([...document.querySelectorAll('#panel button')].find(b => b.textContent === 'Reset response')).click()`);
    assert.deepEqual(await run('window.velocityState().velocityCurve.points.map(p => [p.x, p.y])'), [[0, 0], [1, 1]]);
    assert.deepEqual(errors, [], 'app and worklet have no errors while editing velocity maps');
    console.log('MULTIMIDI velocity editor UI tests passed');
  } finally {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
