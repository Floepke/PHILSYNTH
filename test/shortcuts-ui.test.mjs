// Run: xvfb-run -a node_modules/.bin/electron test/shortcuts-ui.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
app.whenReady().then(async () => {
  let server, win;
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
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.shortcutTest = { engine, transport, seq, preferencesManager };\n';
        res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') console.error(event.message);
    });
    const run = (code) => win.webContents.executeJavaScript(code);
    const wait = async (condition) => {
      for (let i = 0; !(await run(condition)); i++) {
        if (i > 150) throw new Error(`Timed out: ${condition}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const setup = async () => {
      await wait('!!window.shortcutTest');
      await run(`
        window.press = (key, props = {}, target = document.activeElement) => {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...props }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true, ...props }));
        };
        window.learnButton = button => {
          button.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true, cancelable: true }));
          button.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }));
        };
        void 0;
      `);
    };
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await setup();
    await run(`
      document.getElementById('brand').click();
      window.preferencesItem = [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Preferences'));
      window.learnButton(window.preferencesItem);
    `);
    assert.equal(await run("document.getElementById('shortcut-dialog').open"), true);
    assert.match(await run("document.getElementById('shortcut-description').textContent"), /Preferences/);
    assert.equal(await run("document.getElementById('shortcut-current').hidden"), true, 'unassigned actions do not show a stale shortcut');
    assert.equal(await run("!!document.querySelector('.ctx-menu')"), false, 'learning closes the menu');
    await run("window.press('K', { ctrlKey: true, shiftKey: true })");
    await wait("!document.getElementById('shortcut-dialog').open");
    assert.equal(await run("document.getElementById('preferences-dialog').open"), false, 'learning does not execute the action');
    await run("window.press('K', { ctrlKey: true, shiftKey: true })");
    assert.equal(await run("document.getElementById('preferences-dialog').open"), true, 'learned menu action works after menu removal');
    await run("document.getElementById('preferences-dialog').close('cancel')");

    await run("window.learnButton(document.getElementById('spectrum-toggle'))");
    assert.equal(await run("document.getElementById('shortcut-dialog').open"), true, 'icon buttons support learning');
    assert.equal(await run("!!document.querySelector('.ctx-menu')"), false, 'right-click does not open the containing patcher menu');
    await run("window.press('K', { ctrlKey: true, shiftKey: true })");
    assert.equal(await run("document.getElementById('shortcut-dialog').open"), true);
    assert.match(await run("document.getElementById('shortcut-message').textContent"), /already assigned.*Preferences/);
    await run("window.press('L', { ctrlKey: true, shiftKey: true })");
    await wait("!document.getElementById('shortcut-dialog').open");
    const before = await run("document.getElementById('spectrum-toggle').getAttribute('aria-pressed')");
    await run("window.press('L', { ctrlKey: true, shiftKey: true })");
    assert.notEqual(await run("document.getElementById('spectrum-toggle').getAttribute('aria-pressed')"), before);

    await run("window.learnButton(document.getElementById('seq-stop')); window.press('B', { ctrlKey: true, shiftKey: true })");
    await wait("!document.getElementById('shortcut-dialog').open");
    await run("window.stopCount = 0; window.originalStop = window.shortcutTest.transport.stop; window.shortcutTest.transport.stop = () => window.stopCount++; window.press(\"'\")");
    assert.equal(await run('window.stopCount'), 0, 'replaced default transport key is suppressed');
    await run("window.press('B', { ctrlKey: true, shiftKey: true })");
    assert.equal(await run('window.stopCount'), 1, 'custom transport shortcut invokes the live button');
    await run("window.shortcutTest.transport.stop = window.originalStop; void 0");

    await Promise.all([new Promise((resolve) => win.webContents.once('did-finish-load', resolve)), win.reload()]);
    await setup();
    await run("window.press('K', { ctrlKey: true, shiftKey: true })");
    assert.equal(await run("document.getElementById('preferences-dialog').open"), true, 'mapping survives page reload');
    await run(`
      const categories = document.getElementById('preferences-categories');
      categories.value = 'Keyboard';
      categories.dispatchEvent(new Event('change'));
    `);
    assert.match(await run("document.getElementById('preferences-content').textContent"), /3 custom shortcut/);
    await run("document.getElementById('preferences-dialog').close('cancel')");
    await run("document.getElementById('brand').click()");
    assert.match(await run("[...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Preferences')).textContent"), /Ctrl\+Shift\+K/);
    await run(`(async () => {
      const { closeMenu } = await import('/src/seq/menu.js');
      closeMenu();
      window.learnButton(document.getElementById('seq-stop'));
    })()`);
    assert.equal(await run("document.getElementById('shortcut-reset').hidden"), false);
    assert.equal(await run("document.querySelector('#shortcut-current strong').textContent"), 'Ctrl+Shift+B',
      'custom shortcut is shown in bold');
    assert.equal(await run("document.getElementById('shortcut-current').hidden"), false);
    await run("document.getElementById('shortcut-reset').click()");
    await wait("!document.getElementById('shortcut-dialog').open");
    assert.equal(await run("window.shortcutTest.preferencesManager.get('keyboard.shortcuts')['button/seq-stop']"), undefined);
    await run("window.learnButton(document.getElementById('seq-stop'))");
    assert.equal(await run("document.querySelector('#shortcut-current strong').textContent"), "'",
      'restored default shortcut is shown in bold');
    await run("document.getElementById('shortcut-cancel').click()");

    await run(`(async () => {
      const { addClip, emptySong } = await import('/src/song.js');
      const { engine, seq } = window.shortcutTest;
      engine.song = emptySong();
      const osc = await engine.root.addModule('OSC');
      const clip = addClip(engine.song, { length: 16, target: osc.id });
      clip.notes.push({ pitch: 60, start: 0.13, length: 1, vel: 0.8 });
      engine.song.selected = clip.id;
      seq.reload();
      const cv = document.querySelector('#roll canvas');
      cv.focus();
      window.press('a', { ctrlKey: true }, cv);
      const { showMenu } = await import('/src/seq/menu.js');
      const { shortcutRegistry } = await import('/src/shortcuts.js');
      const quantize = shortcutRegistry.actions().find(a => a.id === 'pianoroll/quantize');
      showMenu({ x: 200, y: 100, shortcutScope: 'pianoroll', items: [{ id: 'quantize', label: quantize.label, action: quantize.run }] });
      window.learnButton(document.querySelector('.ctx-item'));
      window.press('J', { ctrlKey: true, shiftKey: true });
    })()`);
    await wait("!document.getElementById('shortcut-dialog').open");
    await run("window.press('q')");
    assert.equal(await run("window.shortcutTest.engine.song.clips[0].notes[0].start"), 0.13, 'old quantize key no longer edits notes');
    await run("window.press('J', { ctrlKey: true, shiftKey: true })");
    assert.notEqual(await run("window.shortcutTest.engine.song.clips[0].notes[0].start"), 0.13, 'custom menu shortcut edits the focused piano roll');
    await run(`(async () => {
      const { addClip } = await import('/src/song.js');
      const { engine, seq } = window.shortcutTest;
      const clip = addClip(engine.song, { start: 16, length: 16, target: engine.song.clips[0].target });
      clip.notes.push({ pitch: 62, start: 0.13, length: 1, vel: 0.8 });
      engine.song.selected = clip.id;
      seq.reload();
      document.querySelector('#roll canvas').focus();
      window.press('J', { ctrlKey: true, shiftKey: true });
    })()`);
    assert.notEqual(await run("window.shortcutTest.engine.song.clips[1].notes[0].start"), 0.13, 'learned actions follow the newly selected clip');
    await run(`
      window.shortcutTest.engine.song.clips[0].notes[0].start = 0.13;
      window.press('K', { ctrlKey: true, shiftKey: true });
      window.press('J', { ctrlKey: true, shiftKey: true });
    `);
    assert.equal(await run("window.shortcutTest.engine.song.clips[0].notes[0].start"), 0.13, 'editor mappings do not run behind modal dialogs');
    await run("document.getElementById('preferences-dialog').close('cancel')");

    for (const [label, key, kind] of [
      ['Insert clip', 'F6', 'midi'],
      ['Insert automation clip', 'F7', 'auto'],
      ['Load Clip…', 'F8', null],
    ]) {
      await run(`{
        const cv = document.querySelector('#arranger canvas');
        const r = cv.getBoundingClientRect();
        cv.focus();
        cv.dispatchEvent(new PointerEvent('pointerdown', {
          button: 2, clientX: r.right - ${key === 'F7' ? 80 : 40}, clientY: r.bottom - 40,
          bubbles: true, cancelable: true,
        }));
        const item = [...document.querySelectorAll('.ctx-item')].find(b => b.querySelector('span')?.textContent === ${JSON.stringify(label)});
        if (!item) throw new Error('Missing timeline menu action: ' + ${JSON.stringify(label)});
        window.learnButton(item);
      }`);
      assert.equal(await run("document.getElementById('shortcut-dialog').open"), true,
        `${label} supports learning while an existing clip remains selected`);
      await run(`window.press('${key}', { altKey: true, shiftKey: true })`);
      await wait("!document.getElementById('shortcut-dialog').open");
      if (kind) {
        const count = await run('window.shortcutTest.engine.song.clips.length');
        await run(`{
          const cv = document.querySelector('#arranger canvas');
          const r = cv.getBoundingClientRect();
          cv.focus();
          cv.dispatchEvent(new PointerEvent('pointermove', {
            clientX: r.right - 120, clientY: r.bottom - 60, bubbles: true,
          }));
          window.press('${key}', { altKey: true, shiftKey: true });
        }`);
        assert.equal(await run('window.shortcutTest.engine.song.clips.length'), count + 1,
          `${label} runs even with a clip selected`);
        assert.equal(await run("window.shortcutTest.engine.song.clips.at(-1).kind ?? 'midi'"), kind);
      }
    }

    await run("window.learnButton(document.getElementById('seq-stop')); document.getElementById('shortcut-cancel').click()");
    assert.equal(await run("window.shortcutTest.preferencesManager.get('keyboard.shortcuts')['button/seq-stop']"), undefined, 'Cancel leaves the mapping unchanged');
    await run(`
      window.dynamicCount = 0;
      const button = document.createElement('button');
      button.textContent = 'Dynamic test action';
      button.onclick = () => window.dynamicCount++;
      document.getElementById('panel-content').append(button);
      window.learnButton(button);
      window.press('H', { ctrlKey: true, shiftKey: true });
    `);
    await wait("!document.getElementById('shortcut-dialog').open");
    await run(`
      const old = [...document.querySelectorAll('button')].find(b => b.textContent === 'Dynamic test action');
      const replacement = old.cloneNode(true);
      replacement.onclick = () => { window.dynamicCount += 10; };
      old.replaceWith(replacement);
      document.querySelector('#roll canvas').focus();
      window.press('H', { ctrlKey: true, shiftKey: true });
    `);
    assert.equal(await run('window.dynamicCount'), 10, 'generic mappings resolve the live replacement button without stale callbacks');
    console.log('keyboard shortcut UI tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    app.exit(process.exitCode ?? 0);
  }
});
