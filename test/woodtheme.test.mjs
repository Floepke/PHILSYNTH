// Run on Linux: xvfb-run -a node_modules/.bin/electron test/woodtheme.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { DEFAULT_WOOD_TINT } from '../src/woodtheme.js';
import { hexToRgb, rgbToHex } from '../src/modcolor.js';

const defaultTint = rgbToHex(...hexToRgb(DEFAULT_WOOD_TINT).map((v) => Math.min(216, Math.max(24, v))));
const focusRgb = tint => hexToRgb(tint).map(v => Math.round(v * 0.85 + 255 * 0.15));

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
    const focusResults = await win.webContents.executeJavaScript(`(() => {
      const workspace = document.createElement('div');
      workspace.id = 'workspace';
      workspace.style.cssText = 'position:fixed;inset:0;z-index:100';
      workspace.innerHTML = '<section id="seq"><div id="roll" class="seq-view"><canvas tabindex="0"></canvas></div></section>' +
        '<div></div><section id="patcher"><aside id="panel"><input></aside><div></div><main id="canvas" tabindex="-1"></main></section>' +
        '<div></div><div id="arranger" class="seq-view"><canvas tabindex="0"></canvas></div>';
      document.body.append(workspace);
      const panes = ['seq', 'patcher', 'arranger'].map(id => workspace.querySelector('#' + id));
      const sizes = () => panes.map(el => [el.clientWidth, el.clientHeight]);
      const before = sizes();
      const cases = [];
      const sample = document.createElement('canvas').getContext('2d');
      const rgb = color => {
        sample.fillStyle = color;
        sample.fillRect(0, 0, 1, 1);
        return [...sample.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      for (const selector of ['#roll canvas', '#canvas', '#panel input', '#arranger canvas']) {
        workspace.querySelector(selector).focus();
        const focused = panes.filter(el => getComputedStyle(el, '::after').content === '""');
        const el = focused[0];
        const style = el && getComputedStyle(el, '::after');
        const rect = el && el.getBoundingClientRect();
        cases.push({ selector, focused: focused.map(el => el.id), sizes: sizes(),
          width: style?.borderTopWidth, color: style && rgb(style.borderTopColor), pointerEvents: style?.pointerEvents,
          hitThrough: el?.contains(document.elementFromPoint(rect.left + 1, rect.top + 1)) });
      }
      document.activeElement.blur();
      const blurred = panes.filter(el => getComputedStyle(el, '::after').content === '""').map(el => el.id);
      workspace.remove();
      return { before, cases, blurred, tint: getComputedStyle(document.documentElement).getPropertyValue('--wood-tint').trim() };
    })()`);
    for (const [i, expected] of ['seq', 'patcher', 'patcher', 'arranger'].entries()) {
      const result = focusResults.cases[i];
      assert.deepEqual(result.focused, [expected], `${result.selector}: only its pane has the focus border`);
      assert.equal(result.width, '2px');
      assert.deepEqual(result.color, focusRgb(focusResults.tint), 'focus border is a subtle lightening of the wood tint');
      assert.equal(result.pointerEvents, 'none', 'focus border never captures pointer gestures');
      assert.ok(result.hitThrough, 'pane content remains reachable through the border');
      assert.deepEqual(result.sizes, focusResults.before, 'focus does not resize the panes');
    }
    assert.deepEqual(focusResults.blurred, [], 'no focus border when focus leaves the panes');
    const results = await win.webContents.executeJavaScript(`(async () => {
      const dialogs = [];
      const module = document.querySelector('.module');
      const name = document.createElement('span');
      name.className = 'module-name custom';
      module.append(name);
      name.textContent = 'Short';
      const shortWidth = module.getBoundingClientRect().width;
      name.textContent = 'A very long module name that must be completely visible '.repeat(20);
      const moduleStyle = getComputedStyle(name);
      const moduleSizing = {
        shortWidth, width: module.getBoundingClientRect().width, viewport: innerWidth,
        labelWidth: name.clientWidth, textWidth: name.scrollWidth,
        overflow: moduleStyle.overflow, maxWidth: moduleStyle.maxWidth,
      };
      for (const modal of [false, true]) {
        const dialog = document.createElement('dialog');
        document.body.append(dialog);
        modal ? dialog.showModal() : dialog.show();
        const style = getComputedStyle(dialog);
        const backdrop = getComputedStyle(dialog, '::backdrop');
        dialogs.push({ modal, animation: style.animationName, transition: style.transitionDuration,
          opacity: style.opacity, transform: style.transform, backdropAnimation: backdrop.animationName,
          backdropBackground: backdrop.backgroundColor, backdropFilter: backdrop.backdropFilter });
        dialog.close();
        dialog.remove();
      }
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
      return { surfaces, textures, dialogs, moduleSizing,
        ink: getComputedStyle(document.querySelector('dialog p')).color,
        playing: getComputedStyle(document.querySelector('.playing')).backgroundColor,
        moduleColor: getComputedStyle(document.querySelector('.module')).getPropertyValue('--mod-color').trim() };
    })()`);
    assert.ok(results.moduleSizing.width > results.moduleSizing.viewport, 'long module names can grow beyond the viewport');
    assert.ok(results.moduleSizing.width > results.moduleSizing.shortWidth, 'module width follows its name');
    assert.equal(results.moduleSizing.labelWidth, results.moduleSizing.textWidth, 'full module name fits without clipping');
    assert.equal(results.moduleSizing.maxWidth, 'none', 'custom names have no width cap');
    for (const dialog of results.dialogs) {
      assert.equal(dialog.animation, 'none', 'dialogs open without animation');
      assert.equal(dialog.transition, '0s', 'dialogs open without transition');
      assert.equal(dialog.opacity, '1', 'dialogs are immediately fully visible');
      assert.equal(dialog.transform, 'none', 'dialogs open without movement or scaling');
      assert.equal(dialog.backdropAnimation, 'none', 'modal backdrops do not animate');
      assert.equal(dialog.backdropBackground, 'rgba(0, 0, 0, 0)', 'dialogs do not darken the background');
      assert.equal(dialog.backdropFilter, 'none', 'dialogs do not blur the background');
    }
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
        import { registerTimelinePreferences } from '/src/timelinepreferences.js';
        import { registerMidiPreferences } from '/src/midipreferences.js';
        import { sigDialog } from '/src/dialogs.js';
        import { showMenu, closeMenu } from '/src/seq/menu.js';
        import { initPaneFocus } from '/src/panefocus.js';
        window.initPaneFocus = initPaneFocus;
        window.openTestMenu = () => showMenu({ x: 620, y: 300, items: [
          { label: 'Export…', children: Array.from({ length: 60 }, (_, i) => ({
            label: i === 0 ? 'Export Audio…' : 'Export destination ' + i,
            shortcut: i === 0 ? 'Ctrl+E' : '',
            action: () => { window.menuChoice = i; },
          })) },
          { label: 'Exit', action() {} },
        ] });
        window.closeTestMenu = closeMenu;
        window.openSig = (options) => { window.sigResult = undefined; sigDialog(options).then(result => { window.sigResult = result; }); };
        window.themeErrors = [];
        window.preferencesManager = createPreferencesManager();
        initWoodTheme(window.preferencesManager);
        registerInterfacePreferences(window.preferencesManager);
        window.preferencesManager.register({ id: 'test.enabled', category: 'Testing', label: 'Enabled', type: 'boolean', defaultValue: true });
        window.preferencesManager.register({ id: 'test.level', category: 'Testing', label: 'Level', type: 'number', min: 0, max: 1, defaultValue: 0.5 });
        window.preferencesManager.register({ id: 'test.mode', category: 'Testing', label: 'Mode', type: 'select', defaultValue: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual' }] });
        window.timelineDisplay = registerTimelinePreferences(window.preferencesManager);
        window.midiSelection = 'auto';
        window.midiDevices = [{ name: 'Keyboard' }];
        registerMidiPreferences(window.preferencesManager, () => ({
          selected: () => window.midiSelection,
          select: value => { window.midiSelection = value; },
          inputs: () => window.midiDevices,
          enable: async () => { window.midiDevices = [{ name: 'Keyboard' }, { name: 'New Controller' }]; return true; },
        }));
        await window.preferencesManager.load();
        window.openPreferences = createPreferencesDialog(window.preferencesManager);
      </script>`);
    const routes = new Map([
      ['/', ['text/html', html]],
      ['/style.css', ['text/css', css]],
      ['/src/seq/menu.js', ['text/javascript', readFileSync(new URL('../src/seq/menu.js', import.meta.url), 'utf8')]],
      ...['panefocus', 'woodtheme', 'modcolor', 'preferences', 'preferencesdialog', 'interfacepreferences', 'timelinepreferences', 'midipreferences', 'midi', 'modmidi', 'dialogs', 'song', 'curve', 'fileformat'].map(name => [`/src/${name}.js`, ['text/javascript',
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
    await run(`(() => {
      const fixture = document.createElement('div');
      fixture.id = 'focus-fixture';
      fixture.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;background:#111';
      fixture.innerHTML = ['roll', 'patch', 'timeline'].map(id =>
        '<section id="focus-' + id + '" style="flex:1"><canvas tabindex="0" style="width:150px;height:100px"></canvas>' +
        '<input type="checkbox"><button>Action</button></section>').join('');
      document.body.append(fixture);
      window.focusCounts = {};
      const panes = [...fixture.children];
      for (const pane of panes) {
        window.focusCounts[pane.id] = {};
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) {
          pane.addEventListener(type, () => {
            const counts = window.focusCounts[pane.id];
            counts[type] = (counts[type] || 0) + 1;
          });
        }
      }
      window.initPaneFocus(panes.map(element => ({
        element, focus: () => element.querySelector('canvas').focus({ preventScroll: true }),
      })));
      document.activeElement.blur();
    })()`);
    const mouse = async (selector, { button = 'left', clickCount = 1, drag = false } = {}) => {
      const { x, y } = await run(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
      if (drag) win.webContents.sendInputEvent({ type: 'mouseMove', x: x + 20, y: y + 20 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: x + (drag ? 20 : 0), y: y + (drag ? 20 : 0), button, clickCount });
      await run('new Promise(resolve => requestAnimationFrame(resolve))');
    };
    const counts = id => run(`window.focusCounts['focus-${id}']`);
    for (const id of ['roll', 'patch', 'timeline']) {
      await mouse(`#focus-${id} canvas`);
      assert.equal(await run("document.activeElement.parentElement.id"), `focus-${id}`, 'first click focuses the pane');
      assert.deepEqual(await counts(id), {}, 'activating click reaches no editing handlers');
      await mouse(`#focus-${id} canvas`);
      assert.deepEqual(await counts(id), { pointerdown: 1, mousedown: 1, pointerup: 1, mouseup: 1, click: 1 }, 'second click edits normally');
    }
    await run("document.activeElement.blur(); window.focusCounts['focus-roll'] = {}");
    await mouse('#focus-roll canvas', { drag: true });
    assert.deepEqual(await counts('roll'), {}, 'activating drag is consumed through mouseup and click');
    await run("document.activeElement.blur(); window.focusCounts['focus-roll'] = {}");
    await mouse('#focus-roll canvas', { clickCount: 1 });
    await mouse('#focus-roll canvas', { clickCount: 2 });
    assert.equal((await counts('roll')).click, 1, 'only the second click of an activating double-click edits');
    assert.equal((await counts('roll')).dblclick, undefined, 'activating click cannot open a double-click action');
    await mouse('#focus-roll canvas', { clickCount: 1 });
    await mouse('#focus-roll canvas', { clickCount: 2 });
    assert.equal((await counts('roll')).dblclick, 1, 'double-clicks in a focused pane work normally');
    await mouse('#focus-patch input');
    assert.equal(await run("document.querySelector('#focus-patch input').checked"), false, 'activating click does not toggle a native control');
    await mouse('#focus-patch input');
    assert.equal(await run("document.querySelector('#focus-patch input').checked"), true, 'next click operates the control');
    await run("document.activeElement.blur(); window.focusCounts['focus-timeline'] = {}");
    await mouse('#focus-timeline canvas', { button: 'right' });
    assert.equal((await counts('timeline')).pointerdown, 1, 'right-click keeps its existing behavior');
    await run("document.activeElement.blur(); window.focusCounts['focus-patch'] = {}");
    await mouse('#focus-patch canvas', { button: 'middle' });
    assert.equal((await counts('patch')).pointerdown, 1, 'middle-button panning is not gated');
    await run("document.querySelector('#focus-roll canvas').focus(); window.focusCounts['focus-roll'] = {}");
    await mouse('#focus-roll canvas');
    assert.equal((await counts('roll')).click, 1, 'programmatically or keyboard-focused panes edit immediately');
    await run("document.getElementById('focus-fixture').remove()");
    console.log('pane focus tests passed: activation clicks, drags, double-clicks, native controls and existing focus');
    const tint = () => run("document.documentElement.style.getPropertyValue('--wood-tint')");
    const borderRgb = () => run(`(() => {
      const probe = document.createElement('div');
      probe.style.borderColor = 'var(--pane-focus)';
      document.body.append(probe);
      const sample = document.createElement('canvas').getContext('2d');
      sample.fillStyle = getComputedStyle(probe).borderTopColor;
      sample.fillRect(0, 0, 1, 1);
      probe.remove();
      return [...sample.getImageData(0, 0, 1, 1).data].slice(0, 3);
    })()`);
    const change = rgb => run(`(() => {
      ['r', 'g', 'b'].forEach((c, i) => { document.getElementById('pref-interface-woodTint-' + c).value = ${JSON.stringify(rgb)}[i]; });
      document.getElementById('pref-interface-woodTint-r').dispatchEvent(new Event('input'));
    })()`);
    const submit = value => run(`document.querySelector('#preferences-dialog form').requestSubmit(document.querySelector('#preferences-dialog button[value="${value}"]'))`);
    const open = () => run('window.openPreferences()');
    const flushClose = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await tint(), defaultTint, 'existing default tint is preserved');
    assert.deepEqual(await borderRgb(), focusRgb(defaultTint), 'focus color follows the loaded wood tint');
    await open();
    assert.equal(await run("document.activeElement.id"), 'preferences-categories', 'category list receives focus');
    assert.deepEqual(await run("Array.from(document.getElementById('preferences-categories').options, o => o.text)"), ['Interface', 'Testing', 'Timeline', 'MIDI']);
    const groups = await run(`Array.from(document.querySelectorAll('#preferences-content fieldset'), group => ({
      label: group.querySelector('legend')?.textContent,
      border: getComputedStyle(group).borderTopWidth,
      padding: getComputedStyle(group).paddingTop
    }))`);
    assert.deepEqual(groups.map(g => g.label), ['Wood Tint', 'Launch in full screen', 'Controller Panel Divider Width']);
    assert.ok(groups.every(g => g.border === '1px' && g.padding === '16px'), 'each setting has a visible padded groupbox');
    await change([64, 128, 192]);
    assert.equal(await tint(), '#4080c0', 'RGB input previews immediately');
    assert.deepEqual(await borderRgb(), focusRgb('#4080c0'), 'focus color follows the live color preview');
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
    assert.deepEqual(await borderRgb(), focusRgb(defaultTint), 'Cancel restores the matching focus color');
    await open();
    await change([64, 128, 192]);
    await submit('ok');
    await flushClose();
    await win.loadURL(url);
    assert.equal(await tint(), '#4080c0', 'saved tint survives reload');
    await open();
    await run("document.querySelector('.preference-reset').click()");
    assert.equal(await tint(), defaultTint, 'Reset previews the existing default');
    assert.deepEqual(await borderRgb(), focusRgb(defaultTint), 'Reset restores the default focus color');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await flushClose();
    assert.equal(await run("document.getElementById('preferences-dialog').open"), false, 'Escape closes the dialog');
    assert.equal(await tint(), '#4080c0', 'Escape restores saved tint');
    await open();
    await change([0, 0, 0]);
    assert.equal(await tint(), '#181818', 'black preserves a grain floor');
    assert.deepEqual(await borderRgb(), focusRgb('#181818'), 'dark tints retain a visible focus border');
    await change([255, 255, 255]);
    assert.equal(await tint(), '#d8d8d8', 'white preserves shading headroom');
    assert.deepEqual(await borderRgb(), focusRgb('#d8d8d8'), 'light tints retain a matching focus border');
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
    await run("document.getElementById('preferences-categories').focus()");
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
    assert.equal(await run("document.getElementById('pref-interface-launchFullscreen').checked"), true, 'fullscreen checkbox defaults on');
    await run(`(() => {
      const input = document.getElementById('pref-interface-launchFullscreen');
      input.checked = false; input.dispatchEvent(new Event('change'));
    })()`);
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
    assert.equal(await run("window.preferencesManager.get('interface.launchFullscreen')"), true, 'Cancel keeps the saved launch mode');
    await open();
    await run(`(() => {
      const input = document.getElementById('${widthInput}');
      input.value = 16; input.dispatchEvent(new Event('change'));
      const fullscreen = document.getElementById('pref-interface-launchFullscreen');
      fullscreen.checked = false; fullscreen.dispatchEvent(new Event('change'));
    })()`);
    await submit('ok'); await flushClose();
    await win.loadURL(url);
    assert.equal((await dividerSizes()).panel, 16, 'divider width survives reload');
    assert.equal(await run("window.preferencesManager.get('interface.launchFullscreen')"), false, 'launch mode survives reload');
    assert.equal(win.isFullScreen(), false, 'saving launch preference does not change the current window');
    win.webContents.setZoomFactor(1.5);
    const scaled = await dividerSizes();
    assert.equal(scaled.panel, 16, 'CSS width is preserved under app scaling');
    assert.equal(win.webContents.getZoomFactor(), 1.5, 'app scaling remains active');
    assert.equal(scaled.upper, before.upper);
    assert.equal(scaled.lower, before.lower);
    win.webContents.setZoomFactor(1);
    await open();
    const timelineCategory = () => run(`(() => {
      const list = document.getElementById('preferences-categories');
      list.value = 'Timeline'; list.dispatchEvent(new Event('change'));
    })()`);
    await timelineCategory();
    assert.deepEqual(await run("Array.from(document.querySelectorAll('#preferences-content legend'), el => el.textContent)"), ['Show Input Grid', 'Show Vertical Barlines']);
    assert.deepEqual(await run("Array.from(document.querySelectorAll('#preferences-content input'), el => el.checked)"), [true, true]);
    const hideTimeline = () => run(`document.querySelectorAll('#preferences-content input').forEach(input => {
      input.checked = false; input.dispatchEvent(new Event('change'));
    })`);
    await hideTimeline();
    assert.deepEqual(await run('window.timelineDisplay'), { showInputGrid: false, showVerticalBarlines: false });
    await submit('cancel'); await flushClose();
    assert.deepEqual(await run('window.timelineDisplay'), { showInputGrid: true, showVerticalBarlines: true });
    await open(); await timelineCategory(); await hideTimeline();
    await submit('ok'); await flushClose();
    await win.loadURL(url);
    assert.deepEqual(await run('window.timelineDisplay'), { showInputGrid: false, showVerticalBarlines: false }, 'timeline display preferences survive reload');
    assert.deepEqual(await run('window.themeErrors'), []);
    await open();
    const midiCategory = () => run(`(() => {
      const list = document.getElementById('preferences-categories');
      list.value = 'MIDI'; list.dispatchEvent(new Event('change'));
    })()`);
    await midiCategory();
    assert.deepEqual(await run("Array.from(document.querySelector('#pref-midi-input').options, o => o.value)"), ['auto', 'Keyboard']);
    await run("document.querySelector('#pref-midi-input').value = 'Keyboard'; document.querySelector('#pref-midi-input').dispatchEvent(new Event('change'))");
    assert.equal(await run('window.midiSelection'), 'Keyboard');
    await run("document.querySelector('.preference-refresh').click()");
    await flushClose();
    assert.deepEqual(await run("Array.from(document.querySelector('#pref-midi-input').options, o => o.value)"), ['auto', 'Keyboard', 'New Controller']);
    assert.equal(await run("document.querySelector('#pref-midi-input').value"), 'Keyboard', 're-scan preserves the draft');
    await submit('cancel'); await flushClose();
    assert.equal(await run('window.midiSelection'), 'auto', 'Cancel restores MIDI input');
    await open(); await midiCategory();
    await run("document.querySelector('#pref-midi-input').value = 'New Controller'; document.querySelector('#pref-midi-input').dispatchEvent(new Event('change'))");
    await submit('ok'); await flushClose();
    await win.loadURL(url);
    assert.equal(await run('window.midiSelection'), 'New Controller', 'input selection persists through reload');
    await open(); await midiCategory();
    assert.equal(await run("document.querySelector('#pref-midi-input option:checked').textContent"), 'New Controller (not connected)');
    await run("document.querySelector('.preference-reset').click()");
    assert.equal(await run('window.midiSelection'), 'auto');
    await submit('cancel'); await flushClose();
    assert.equal(await run('window.midiSelection'), 'New Controller');
    await run("window.openSig({ num: 7, den: 8 })");
    assert.equal(await run("document.querySelectorAll('#sig-measure .sig-beat').length"), 7);
    assert.equal(await run("document.querySelectorAll('#sig-measure .sig-stave-line').length"), 10, 'two octaves have ten black-key stave lines, not key rectangles');
    assert.equal(await run("document.querySelectorAll('#sig-measure .sig-stave-line.three').length"), 6, 'three-line groups are thicker');
    assert.equal(await run("document.querySelectorAll('#sig-measure .sig-stave-line.central').length"), 2, 'central C#4 and D#4 lines are dashed');
    const measureSize = () => run(`(() => {
      const dialog = document.getElementById('sig-dialog').getBoundingClientRect();
      const preview = document.getElementById('sig-measure');
      const rows = Array.from(preview.querySelectorAll('button'), row => row.getBoundingClientRect());
      return { height: preview.clientHeight, dialogHeight: dialog.height, fits: preview.scrollHeight === preview.clientHeight,
        rowsFit: rows.every(row => row.height > 0) && Math.abs(rows.at(-1).bottom - preview.getBoundingClientRect().bottom) < 1 };
    })()`);
    const initialMeasureSize = await measureSize();
    assert.ok(initialMeasureSize.height > 200, 'editor uses the available window height');
    assert.ok(initialMeasureSize.fits && initialMeasureSize.rowsFit);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('DOM.enable');
    await win.webContents.debugger.sendCommand('CSS.enable');
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    for (const index of [0, 1]) {
      await run(`document.querySelectorAll('#sig-measure button')[${index}].style.transition = 'none'`);
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId, selector: `#sig-measure button:nth-of-type(${index + 1})`,
      });
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      assert.equal(await run(`getComputedStyle(document.querySelectorAll('#sig-measure button')[${index}]).backgroundColor`),
        'rgba(255, 255, 255, 0.14)', 'hover highlight is visible on both light and shaded beats');
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
    win.webContents.debugger.detach();
    assert.equal(await run(`(() => {
      const thin = document.querySelector('.sig-stave-line').getBoundingClientRect().width;
      const thick = document.querySelector('.sig-stave-line.three').getBoundingClientRect().width;
      return Math.abs(thick / thin - 2) < 0.02;
    })()`), true, 'stave thickness matches the piano-roll two/three grouping');
    await run("document.querySelectorAll('#sig-measure button')[0].click(); document.querySelectorAll('#sig-measure button')[2].click()");
    assert.deepEqual(await run("Array.from(document.querySelectorAll('#sig-measure button'), row => row.getAttribute('aria-pressed'))"), ['false', 'true', 'false', 'true', 'true', 'true', 'true']);
    await run("document.querySelector('#sig-dialog form').requestSubmit(document.querySelector('#sig-dialog button[value=\"ok\"]'))");
    await flushClose();
    assert.deepEqual(await run('window.sigResult'), { num: 7, den: 8, gridBeats: [1, 3, 4, 5, 6] });
    await run("window.openSig({ num: 7, den: 8, gridBeats: [0, 2, 6] })");
    await run("document.getElementById('sig-num').value = 3; document.getElementById('sig-num').dispatchEvent(new Event('input'))");
    assert.equal(await run("document.querySelectorAll('#sig-measure button').length"), 3);
    assert.equal(await run("Array.from(document.querySelectorAll('#sig-measure button')).every(row => row.getAttribute('aria-pressed') === 'true')"), true, 'numerator edits reset every beat to enabled');
    assert.deepEqual(await measureSize(), initialMeasureSize, 'changing numerator keeps dialog and measure height fixed');
    await run("document.getElementById('sig-num').value = 32; document.getElementById('sig-num').dispatchEvent(new Event('input'))");
    assert.deepEqual(await measureSize(), initialMeasureSize, 'even 32 beats fit the same editor area');
    await run("document.getElementById('sig-num').value = 5; document.getElementById('sig-num').dispatchEvent(new Event('input'))");
    await run("document.querySelector('#sig-dialog form').requestSubmit(document.querySelector('#sig-dialog button[value=\"ok\"]'))");
    await flushClose();
    assert.deepEqual(await run('window.sigResult'), { num: 5, den: 8, gridBeats: [0, 1, 2, 3, 4] }, 'numerator changes save all beats enabled');
    await run("window.openSig({ num: 7, den: 8, gridBeats: [0, 2, 6] })");
    assert.equal(await run("document.querySelectorAll('#sig-measure button[aria-pressed=\"true\"]').length"), 3, 'opening preserves saved beat selections');
    await run("document.getElementById('sig-den').value = 4; document.getElementById('sig-den').dispatchEvent(new Event('change'))");
    assert.equal(await run("document.querySelectorAll('#sig-measure button[aria-pressed=\"true\"]').length"), 7, 'denominator changes reset every beat to enabled');
    await run("document.querySelector('#sig-dialog form').requestSubmit(document.querySelector('#sig-dialog button[value=\"ok\"]'))");
    await flushClose();
    assert.deepEqual(await run('window.sigResult'), { num: 7, den: 4, gridBeats: [0, 1, 2, 3, 4, 5, 6] });
    await run("window.openSig({ num: 7, den: 8, gridBeats: [] })");
    await run("document.querySelector('#sig-measure button').click()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await flushClose();
    assert.equal(await run('window.sigResult'), null, 'Escape discards measure edits');
    win.show();
    win.setContentSize(640, 360);
    await run("window.openSig({ num: 32, den: 8 })");
    assert.equal(await run("document.querySelectorAll('#sig-measure button').length"), 32);
    assert.equal(await run(`(() => {
      const dialog = document.getElementById('sig-dialog').getBoundingClientRect();
      const preview = document.getElementById('sig-measure');
      return dialog.top >= 0 && dialog.bottom <= innerHeight && preview.scrollHeight === preview.clientHeight;
    })()`), true, 'all 32 beats fit without measure scrolling in a short viewport');
    assert.ok((await measureSize()).rowsFit, 'entire measure scales to the editor height');
    const shortHeight = (await measureSize()).height;
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width: 640, height: 720 },
      viewSize: { width: 640, height: 720 }, deviceScaleFactor: 1, scale: 1,
    });
    await run(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 2000;
      function resized() {
        if (innerHeight > 660) return resolve();
        if (performance.now() > deadline) return reject(new Error('Window resize did not reach the renderer: ' + innerHeight));
        requestAnimationFrame(resized);
      }
      resized();
    })`);
    await flushClose();
    const tallHeight = (await measureSize()).height;
    assert.ok(tallHeight > shortHeight + 300, `editor grows with available window space: ${shortHeight} to ${tallHeight}`);
    await run("document.querySelector('#sig-dialog button[value=\"cancel\"]').click()");
    await flushClose();
    await run('window.openTestMenu(); true');
    const menuWidth = await run("document.querySelector('.ctx-menu').getBoundingClientRect().width");
    await run("document.querySelector('.ctx-menu > button').click()");
    assert.ok(await run("document.querySelector('.ctx-menu').getBoundingClientRect().width") >= menuWidth, 'inline expansion grows only when wider children need room');
    assert.equal(await run(`(() => {
      const label = document.querySelector('.ctx-group button > span');
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getClientRects().length === 1;
    })()`), true, 'expanded item labels fit on one row when the viewport has room');
    assert.equal(await run(`(() => {
      const menu = document.querySelector('.ctx-menu');
      const r = menu.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight &&
        menu.scrollHeight > menu.clientHeight && getComputedStyle(menu).overflowY === 'auto';
    })()`), true, 'large folded menus fit the viewport and scroll vertically');
    await run(`document.querySelector('.ctx-menu').dispatchEvent(new WheelEvent('wheel', { bubbles: true }))`);
    assert.equal(await run("!!document.querySelector('.ctx-menu')"), true, 'wheel inside the menu does not dismiss it');
    await run("document.querySelector('.ctx-menu').scrollTop = 500");
    assert.ok(await run("document.querySelector('.ctx-menu').scrollTop > 0"));
    await run("document.querySelector('.ctx-group button').click()");
    assert.equal(await run('window.menuChoice'), 0);
    assert.equal(await run("!!document.querySelector('.ctx-menu')"), false);
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width: 200, height: 240 },
      viewSize: { width: 200, height: 240 }, deviceScaleFactor: 1, scale: 1,
    });
    await flushClose();
    await run('window.openTestMenu(); true');
    await run("document.querySelector('.ctx-menu > button').click()");
    assert.equal(await run(`(() => {
      const r = document.querySelector('.ctx-menu').getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    })()`), true, 'folded menus also fit very small screens');
    await run('window.closeTestMenu(); true');
    console.log('measure editor tests passed: two octaves, beat toggles, numerator changes, and cancellation');
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
