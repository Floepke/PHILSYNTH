// Run on Linux: xvfb-run -a node_modules/.bin/electron test/woodtheme.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { DEFAULT_WOOD_TINT } from '../src/woodtheme.js';
import { hexToRgb, rgbToHex } from '../src/modcolor.js';

const defaultTint = rgbToHex(...hexToRgb(DEFAULT_WOOD_TINT).map((v) => Math.min(216, Math.max(24, v))));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') console.error(event.message);
  });
  let server;
  try {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    await win.loadURL(`data:text/html,${encodeURIComponent(`<style>${css}</style>
      <div class="splitter"><span id="clock">12:00</span></div>
      <div class="splitter horizontal"></div>
      <div id="seq-bar"><select><option>A</option></select><input value="1"></div>
      <div id="seq-transport"><button class="seq-play playing">Play</button></div>
      <dialog open><p>Text</p><menu><button>OK</button></menu></dialog>
      <div class="ctx-menu"><button class="ctx-item">Item</button></div>
      <div class="module" style="--mod-color: #ff0000"></div>`)}`);
    const results = await win.webContents.executeJavaScript(`(async () => {
      const surfaces = ['body', '.splitter', '.splitter.horizontal', '#seq-bar select',
        '#seq-bar input', 'dialog', 'dialog menu button', '.ctx-menu'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector));
        return { selector, background: style.backgroundColor, image: style.backgroundImage, filter: style.filter };
      });
      const textures = [];
      for (const axis of ['h', 'v']) {
        const url = getComputedStyle(document.documentElement).getPropertyValue('--wood-' + axis).trim();
        const image = new Image();
        image.src = url.slice(5, -2);
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let min = 255, max = 0, tint = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          min = Math.min(min, pixels[i]);
          max = Math.max(max, pixels[i]);
          tint = Math.max(tint, Math.abs(pixels[i] - pixels[i + 1]), Math.abs(pixels[i] - pixels[i + 2]));
        }
        textures.push({ axis, min, max, tint });
      }
      return { surfaces, textures,
        ink: getComputedStyle(document.querySelector('dialog p')).color,
        playing: getComputedStyle(document.querySelector('.playing')).backgroundColor,
        moduleColor: getComputedStyle(document.querySelector('.module')).getPropertyValue('--mod-color').trim() };
    })()`);
    for (const { selector, background, image, filter } of results.surfaces) {
      const [r, g, b] = background.match(/[\d.]+/g).map(Number);
      assert.equal(r, g, selector + ' has neutral background');
      assert.equal(g, b, selector + ' has neutral background');
      assert.ok(image.includes('data:image/svg+xml'), selector + ' retains wood texture');
      assert.equal(filter, 'none', selector + ' does not desaturate its children');
    }
    for (const { axis, min, max, tint } of results.textures) {
      assert.equal(tint, 0, axis + ' grain is grayscale');
      assert.ok(max - min > 20, axis + ' grain retains visible tonal variation');
      assert.ok(max < 128, axis + ' grain stays dark');
    }
    assert.equal(results.ink, 'rgb(229, 229, 229)');
    assert.equal(results.playing, 'rgb(255, 90, 54)', 'playback indicator retains its color');
    assert.equal(results.moduleColor, '#ff0000', 'module color is unchanged');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
      .replace('<script type="module" src="src/main.js"></script>', `<script type="module">
        import { initWoodTheme } from '/src/woodtheme.js';
        import { createPreferencesManager } from '/src/preferences.js';
        import { createPreferencesDialog } from '/src/preferencesdialog.js';
        import { registerInterfacePreferences } from '/src/interfacepreferences.js';
        window.themeErrors = [];
        window.preferencesManager = createPreferencesManager();
        initWoodTheme(window.preferencesManager);
        registerInterfacePreferences(window.preferencesManager);
        window.preferencesManager.register({ id: 'test.enabled', category: 'Testing', label: 'Enabled', type: 'boolean', defaultValue: true });
        window.preferencesManager.register({ id: 'test.level', category: 'Testing', label: 'Level', type: 'number', min: 0, max: 1, defaultValue: 0.5 });
        window.preferencesManager.register({ id: 'test.mode', category: 'Testing', label: 'Mode', type: 'select', defaultValue: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }] });
        await window.preferencesManager.load();
        window.openPreferences = createPreferencesDialog(window.preferencesManager);
      </script>`);
    const routes = new Map([
      ['/', ['text/html', html]],
      ['/style.css', ['text/css', css]],
      ...['woodtheme', 'modcolor', 'preferences', 'preferencesdialog', 'interfacepreferences'].map(name => [`/src/${name}.js`, ['text/javascript',
        readFileSync(new URL('../src/' + name + '.js', import.meta.url), 'utf8')]]),
    ]);
    server = http.createServer((req, res) => {
      const route = routes.get(req.url);
      res.writeHead(route ? 200 : 404, { 'Content-Type': route?.[0] ?? 'text/plain' });
      res.end(route?.[1] ?? 'Not found');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await win.loadURL(url);
    const run = code => win.webContents.executeJavaScript(code);
    const tint = () => run("document.documentElement.style.getPropertyValue('--wood-tint')");
    const change = rgb => run(`(() => {
      ['r', 'g', 'b'].forEach((c, i) => { document.getElementById('pref-interface-woodTint-' + c).value = ${JSON.stringify(rgb)}[i]; });
      document.getElementById('pref-interface-woodTint-r').dispatchEvent(new Event('input'));
    })()`);
    const submit = value => run(`document.querySelector('#preferences-dialog form').requestSubmit(document.querySelector('#preferences-dialog button[value="${value}"]'))`);
    const open = () => run('window.openPreferences()');
    const flushClose = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await tint(), defaultTint, 'existing default tint is preserved');
    await open();
    assert.equal(await run("document.activeElement.id"), 'preferences-categories', 'category list receives focus');
    assert.deepEqual(await run("Array.from(document.getElementById('preferences-categories').options, o => o.text)"), ['Interface', 'Testing']);
    await change([64, 128, 192]);
    assert.equal(await tint(), '#4080c0', 'RGB input previews immediately');
    assert.equal(await run("localStorage.getItem('philsynth:preferences')"), null, 'preview does not save');
    const tintedGrain = await run(`(async () => {
      const image = new Image();
      const url = getComputedStyle(document.documentElement).getPropertyValue('--wood-h').trim();
      image.src = url.slice(5, -2);
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255, max = 0, blue = true;
      for (let i = 0; i < data.length; i += 4) {
        min = Math.min(min, data[i + 2]); max = Math.max(max, data[i + 2]);
        blue &&= data[i + 2] > data[i + 1] && data[i + 1] > data[i];
      }
      return { min, max, blue };
    })()`);
    assert.equal(tintedGrain.blue, true, 'tint colors the rendered grain');
    assert.ok(tintedGrain.max - tintedGrain.min > 20, 'tinted grain keeps tonal detail');
    await submit('cancel');
    await flushClose();
    assert.equal(await tint(), defaultTint, 'Cancel restores the previous tint');
    await open();
    await change([64, 128, 192]);
    await submit('ok');
    await flushClose();
    await win.loadURL(url);
    assert.equal(await tint(), '#4080c0', 'saved tint survives reload');
    await open();
    await run("document.querySelector('.preference-reset').click()");
    assert.equal(await tint(), defaultTint, 'Reset previews the existing default');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await flushClose();
    assert.equal(await run("document.getElementById('preferences-dialog').open"), false, 'Escape closes the dialog');
    assert.equal(await tint(), '#4080c0', 'Escape restores saved tint');
    await open();
    await change([0, 0, 0]);
    assert.equal(await tint(), '#181818', 'black preserves a grain floor');
    await change([255, 255, 255]);
    assert.equal(await tint(), '#d8d8d8', 'white preserves shading headroom');
    await run("Storage.prototype.setItem = () => { throw new Error('Storage blocked'); }; void 0");
    await submit('ok');
    assert.equal(await run("document.getElementById('preferences-dialog').open"), true, 'save failures keep the dialog open');
    assert.match(await run("document.getElementById('preferences-error').textContent"), /Could not save.*Storage blocked/);
    await submit('cancel');
    await flushClose();
    assert.equal(await tint(), '#4080c0');
    await win.loadURL(url);
    await open();
    await change([128, 64, 32]);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    assert.equal(await run("document.getElementById('preferences-categories').value"), 'Testing', 'keyboard selects categories');
    await run(`(() => {
      const input = document.getElementById('pref-test-enabled');
      input.checked = false; input.dispatchEvent(new Event('change'));
      const mode = document.getElementById('pref-test-mode');
      mode.value = 'manual'; mode.dispatchEvent(new Event('change'));
      const level = document.getElementById('pref-test-level');
      level.value = 0.75; level.dispatchEvent(new Event('change'));
    })()`);
    await run(`(() => {
      const list = document.getElementById('preferences-categories');
      list.value = 'Interface'; list.dispatchEvent(new Event('change'));
    })()`);
    assert.equal(await run("document.getElementById('pref-interface-woodTint-r').value"), '128', 'drafts survive category switches');
    await submit('ok');
    await flushClose();
    assert.equal(await run("window.preferencesManager.get('test.enabled')"), false);
    assert.equal(await run("window.preferencesManager.get('test.mode')"), 'manual');
    assert.equal(await run("window.preferencesManager.get('test.level')"), 0.75);
    assert.equal(await tint(), '#804020');
    await win.loadURL(url);
    assert.equal(await tint(), '#804020', 'multiple categories save together');
    const dividerSizes = () => run(`(() => {
      const panel = document.getElementById('panel-split');
      const grip = getComputedStyle(panel, '::after');
      return {
        panel: panel.getBoundingClientRect().width,
        upper: document.getElementById('seq-split').getBoundingClientRect().height,
        lower: document.getElementById('seq-hsplit').getBoundingClientRect().height,
        grip: parseFloat(grip.width) + 4,
        room: getComputedStyle(document.getElementById('patcher')).getPropertyValue('--panel-room')
      };
    })()`);
    await open();
    const before = await dividerSizes();
    const widthInput = 'pref-interface-controllerPanelDividerWidth';
    await run(`(() => {
      const input = document.getElementById('${widthInput}');
      input.value = 10; input.dispatchEvent(new Event('change'));
    })()`);
    const minimum = await dividerSizes();
    assert.equal(minimum.panel, 10, 'only controller divider changes to minimum width');
    assert.equal(minimum.upper, before.upper);
    assert.equal(minimum.lower, before.lower);
    assert.ok(minimum.panel >= minimum.grip + 4, 'grip fits with padding');
    assert.ok(minimum.room.includes('10px'), 'panel layout accounts for the independent divider width');
    await submit('cancel'); await flushClose();
    assert.equal((await dividerSizes()).panel, 48, 'Cancel restores divider width');
    await open();
    await run(`(() => {
      const input = document.getElementById('${widthInput}');
      input.value = 16; input.dispatchEvent(new Event('change'));
    })()`);
    await submit('ok'); await flushClose();
    await win.loadURL(url);
    assert.equal((await dividerSizes()).panel, 16, 'divider width survives reload');
    win.webContents.setZoomFactor(1.5);
    const scaled = await dividerSizes();
    assert.equal(scaled.panel, 16, 'CSS width is preserved under app scaling');
    assert.equal(win.webContents.getZoomFactor(), 1.5, 'app scaling remains active');
    assert.equal(scaled.upper, before.upper);
    assert.equal(scaled.lower, before.lower);
    win.webContents.setZoomFactor(1);
    assert.deepEqual(await run('window.themeErrors'), []);
    console.log('preferences controls passed: categories, keyboard navigation, drafts, live preview, Cancel, Reset, persistence, extremes, and storage errors');
    console.log('wood theme tests passed: neutral surfaces, dark textured grain, and preserved signal colors');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  } finally {
    server?.close();
  }
});
