// Run on Linux: xvfb-run -a node_modules/.bin/electron test/woodtheme.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import http from 'node:http';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
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
        window.themeErrors = [];
        window.openWoodTint = initWoodTheme(message => window.themeErrors.push(message));
      </script>`);
    const routes = new Map([
      ['/', ['text/html', html]],
      ['/style.css', ['text/css', css]],
      ...['woodtheme', 'modcolor'].map(name => [`/src/${name}.js`, ['text/javascript',
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
      ['r', 'g', 'b'].forEach((c, i) => { document.getElementById('wood-' + c).value = ${JSON.stringify(rgb)}[i]; });
      document.getElementById('wood-r').dispatchEvent(new Event('input'));
    })()`);
    const submit = value => run(`document.querySelector('#wood-dialog form').requestSubmit(document.querySelector('#wood-dialog button[value="${value}"]'))`);
    const open = () => run('window.openWoodTint()');
    const flushClose = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await tint(), '#585858', 'charcoal is the default');
    await open();
    await change([64, 128, 192]);
    assert.equal(await tint(), '#4080c0', 'RGB input previews immediately');
    assert.equal(await run("localStorage.getItem('philsynth:woodTint')"), null, 'preview does not save');
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
    assert.equal(await tint(), '#585858', 'Cancel restores the previous tint');
    await open();
    await change([64, 128, 192]);
    await submit('ok');
    await flushClose();
    await win.loadURL(url);
    assert.equal(await tint(), '#4080c0', 'saved tint survives reload');
    await open();
    await run("document.getElementById('wood-reset').click()");
    assert.equal(await tint(), '#585858', 'Reset previews gray');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await flushClose();
    assert.equal(await run("document.getElementById('wood-dialog').open"), false, 'Escape closes the dialog');
    assert.equal(await tint(), '#4080c0', 'Escape restores saved tint');
    await open();
    await change([0, 0, 0]);
    assert.equal(await tint(), '#181818', 'black preserves a grain floor');
    await change([255, 255, 255]);
    assert.equal(await tint(), '#d8d8d8', 'white preserves shading headroom');
    await run("Storage.prototype.setItem = () => { throw new Error('Storage blocked'); }; void 0");
    await submit('ok');
    assert.equal(await run("document.getElementById('wood-dialog').open"), true, 'save failures keep the dialog open');
    assert.match(await run("document.getElementById('wood-error').textContent"), /Could not save.*Storage blocked/);
    await submit('cancel');
    await flushClose();
    assert.equal(await tint(), '#4080c0');
    assert.deepEqual(await run('window.themeErrors'), []);
    console.log('wood tint controls passed: live preview, Cancel, Reset, persistence, extremes, and storage errors');
    console.log('wood theme tests passed: neutral surfaces, dark textured grain, and preserved signal colors');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  } finally {
    server?.close();
  }
});
