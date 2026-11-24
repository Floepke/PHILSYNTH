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
        ${process.env.TEST_PLATFORM ? `Object.defineProperty(navigator, 'platform', { value: ${JSON.stringify(process.env.TEST_PLATFORM)} });` : ''}
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
    const mac = await run("/Mac|iPhone|iPad/.test(navigator.platform)");
    await run(mac ? "window.press(',', { metaKey: true })" : "window.press('p', { ctrlKey: true })");
    assert.equal(await run("document.getElementById('preferences-dialog').open"), true,
      'platform default opens Preferences');
    await run("document.getElementById('preferences-dialog').close('cancel'); document.activeElement.blur()");
    if (process.argv.includes('--preferences-only')) {
      await run(`document.getElementById('brand').click();
        const item = [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Preferences'));
        window.learnButton(item);
        window.press('K', { ctrlKey: true, shiftKey: true });`);
      await wait("!document.getElementById('shortcut-dialog').open");
      await run(mac ? "window.press(',', { metaKey: true })" : "window.press('p', { ctrlKey: true })");
      assert.equal(await run("document.getElementById('preferences-dialog').open"), false,
        'custom binding suppresses the Preferences default');
      await run("window.press('K', { ctrlKey: true, shiftKey: true })");
      assert.equal(await run("document.getElementById('preferences-dialog').open"), true,
        'custom binding opens Preferences');
      console.log('Preferences shortcut UI tests passed');
      return;
    }
    const appVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
    await run(`document.getElementById('brand').click();
      [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.trim() === 'Version…').click();`);
    await wait("document.getElementById('version-text').textContent !== 'Loading version…'");
    assert.equal(await run("document.getElementById('version-dialog').open"), true);
    assert.equal(await run("document.getElementById('version-text').textContent"), `PHILSYNTH ${appVersion}`);
    await run("document.querySelector('#version-dialog button').click()");
    assert.equal(await run("document.getElementById('version-dialog').open"), false);
    await run(`window.originalFetch = window.fetch;
      window.fetch = () => Promise.resolve(new Response('', { status: 404 }));
      document.getElementById('brand').click();
      [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.trim() === 'Version…').click();`);
    await wait("document.getElementById('version-text').textContent !== 'Loading version…'");
    assert.equal(await run("document.getElementById('version-text').textContent"), 'Could not load app version: HTTP 404');
    await run("document.querySelector('#version-dialog button').click(); window.fetch = window.originalFetch; void 0;");
    await run("window.press('m')");
    assert.equal(await run('window.shortcutTest.transport.metronome'), true, 'M enables the metronome');
    await run("window.press('m')");
    assert.equal(await run('window.shortcutTest.transport.metronome'), false, 'M disables the metronome');
    await run(`(async () => {
      const { addClip } = await import('/src/song.js');
      const { engine, seq } = window.shortcutTest;
      const clip = addClip(engine.song, { length: 4 });
      engine.song.selected = clip.id;
      seq.reload();
      window.press('n');
    })()`);
    assert.equal(await run('window.shortcutTest.seq.recordArmed()'), true, 'N arms MIDI recording');
    await run("window.press('n')");
    assert.equal(await run('window.shortcutTest.seq.recordArmed()'), false, 'N disarms MIDI recording');
    await run("window.press('-', { code: 'Minus' })");
    assert.match(await run("document.getElementById('status').textContent"), /Computer keyboard: C3–E4/,
      'octave down reports the new keyboard range');
    await run(`document.getElementById('seq-name').focus();
      window.press('=', { code: 'Equal' });`);
    assert.match(await run("document.getElementById('status').textContent"), /Computer keyboard: C3–E4/,
      'typing in a field does not change the keyboard octave');
    await run("document.activeElement.blur(); window.press('=', { code: 'Equal' })");
    assert.match(await run("document.getElementById('status').textContent"), /Computer keyboard: C4–E5/,
      'octave up restores the original range');
    await run(`
      const input = document.getElementById('seq-name');
      input.focus();
      window.press('m', {}, input);
      window.press('n', {}, input);
    `);
    assert.equal(await run('window.shortcutTest.transport.metronome'), false, 'typing M does not toggle the metronome');
    assert.equal(await run('window.shortcutTest.seq.recordArmed()'), false, 'typing N does not arm recording');
    await run('document.activeElement.blur()');
    await run(`(() => {
      const { transport } = window.shortcutTest;
      window.transportCalls = [];
      window.transportMethods = { play: transport.play, playClip: transport.playClip, stop: transport.stop };
      transport.play = options => { window.transportCalls.push(options?.fromStart ? 'restart' : 'play'); return true; };
      transport.playClip = () => { window.transportCalls.push('loop'); return true; };
      transport.stop = () => { window.transportCalls.push('stop'); };
    })()`);
    for (const selector of ['#patcher canvas', '#roll canvas', '#arranger canvas', '#spectrum-toggle', '#seq-record']) {
      await run(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        target.focus();
        window.transportCalls.length = 0;
        for (const key of [',', '.', '/', "'", ' ']) window.press(key, {}, target);
        window.press('m', {}, target);
        window.press('n', {}, target);
      })()`);
      assert.deepEqual(await run('window.transportCalls'), ['restart', 'play', 'loop', 'stop', 'play'],
        `transport shortcuts work from ${selector}`);
      assert.equal(await run('window.shortcutTest.transport.metronome'), true, `M works from ${selector}`);
      assert.equal(await run('window.shortcutTest.seq.recordArmed()'), true, `N works from ${selector}`);
      await run(`window.press('m'); window.press('n')`);
    }
    await run(`(async () => {
      const { engine, seq } = window.shortcutTest;
      const target = await engine.root.addModule('OSC');
      window.dropdownTarget = target.id;
      seq.reload();
      window.transportCalls.length = 0;
    })()`);
    const clickAt = async (point) => {
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({
        type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    for (const selector of ['#seq-free-time', '#seq-free-time + span']) {
      const before = await run("document.getElementById('seq-free-time').checked");
      const point = await run(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })()`);
      await clickAt(point);
      assert.equal(await run("document.getElementById('seq-free-time').checked"), !before, 'mouse click toggles Free Timing');
      assert.equal(await run("document.activeElement.id === 'seq-free-time'"), false, 'Free Timing does not retain mouse focus');
      await run(`window.transportCalls.length = 0;
        for (const key of [',', '.', '/', "'", ' ']) window.press(key);
        window.press('f');`);
      assert.deepEqual(await run('window.transportCalls'), ['restart', 'play', 'loop', 'stop', 'play'],
        'transport shortcuts work after clicking Free Timing');
      assert.equal(await run("document.getElementById('seq-free-time').checked"), before,
        'Free Timing shortcut still works after clicking its checkbox or label');
    }
    const dropdownPoint = await run(`(() => {
      const b = document.getElementById('seq-target').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    await clickAt(dropdownPoint);
    await wait("document.getElementById('seq-target').matches(':open')");
    const optionPoint = await run(`(() => {
      const b = [...document.getElementById('seq-target').options].find(o => +o.value === window.dropdownTarget).getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    await clickAt(optionPoint);
    await wait("!document.getElementById('seq-target').matches(':open')");
    assert.equal(await run("document.getElementById('seq-target').value"), String(await run('window.dropdownTarget')));
    assert.equal(await run("document.activeElement.id === 'seq-target'"), false, 'picking a destination releases dropdown focus');
    await run(`window.transportCalls.length = 0;
      for (const key of [',', '.', '/', "'", ' ']) window.press(key);`);
    assert.deepEqual(await run('window.transportCalls'), ['restart', 'play', 'loop', 'stop', 'play'],
      'transport shortcuts work immediately after picking a destination');
    await clickAt(dropdownPoint);
    await wait("document.getElementById('seq-target').matches(':open')");
    await clickAt(optionPoint);
    assert.equal(await run("document.activeElement.id === 'seq-target'"), false,
      'choosing the same destination also releases focus without a change event');
    await clickAt(dropdownPoint);
    await wait("document.getElementById('seq-target').matches(':open')");
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await wait("!document.getElementById('seq-target').matches(':open')");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await run("document.activeElement.id === 'seq-target'"), false,
      'cancelling the mouse-opened dropdown releases focus');
    await run(`(() => {
      const dialog = document.getElementById('preferences-dialog');
      dialog.showModal();
      window.transportCalls.length = 0;
      for (const key of [',', '.', '/', "'", ' ', 'm', 'n']) window.press(key, {}, dialog);
    })()`);
    assert.deepEqual(await run('window.transportCalls'), [], 'modal dialogs block transport shortcuts');
    assert.equal(await run('window.shortcutTest.transport.metronome'), false);
    assert.equal(await run('window.shortcutTest.seq.recordArmed()'), false);
    await run(`document.getElementById('preferences-dialog').close('cancel');
      Object.assign(window.shortcutTest.transport, window.transportMethods);
      document.activeElement.blur();`);
    await run(`
      document.getElementById('brand').click();
      window.preferencesItem = [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Preferences'));
      window.learnButton(window.preferencesItem);
    `);
    assert.equal(await run("document.getElementById('shortcut-dialog').open"), true);
    assert.match(await run("document.getElementById('shortcut-description').textContent"), /Preferences/);
    assert.equal(await run("document.getElementById('shortcut-current').hidden"), false, 'Preferences shows its default shortcut');
    assert.equal(await run("!!document.querySelector('.ctx-menu')"), false, 'learning closes the menu');
    await run("window.press('K', { ctrlKey: true, shiftKey: true })");
    await wait("!document.getElementById('shortcut-dialog').open");
    assert.equal(await run("document.getElementById('preferences-dialog').open"), false, 'learning does not execute the action');
    await run(mac ? "window.press(',', { metaKey: true })" : "window.press('p', { ctrlKey: true })");
    assert.equal(await run("document.getElementById('preferences-dialog').open"), false, 'custom Preferences shortcut replaces the default');
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
    assert.deepEqual(await run(`(() => {
      const box = getComputedStyle(document.getElementById('shortcut-current'));
      const key = getComputedStyle(document.getElementById('shortcut-current-value'));
      return { bordered: box.borderTopWidth === '1px', coloured: box.backgroundImage.includes('linear-gradient'),
        separateLine: key.display === 'block', prominent: parseFloat(key.fontSize) >= 22 };
    })()`), { bordered: true, coloured: true, separateLine: true, prominent: true },
    'current mapping has a distinct coloured box and a large separate shortcut');
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
    await run("window.press('Q', { shiftKey: true })");
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
