// Linux: xvfb-run -a node_modules/.bin/electron test/multimidi-ui.test.mjs --no-sandbox
// Shared key-map UI: MULTIMIDI velocity editing and TUNING keyboard selection.
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
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.velocityTest = { engine, select, seq, undoHistory, render };\n';
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
    assert.deepEqual(await run(`[...document.querySelectorAll('#panel .panel-editor-title')].map(h => h.textContent)`),
      ['Velocity per key', 'Velocity response'], 'velocity editors share the standard panel headings without duplicates');
    const headingMetrics = () => run(`(() => {
      const h = document.querySelector('.panel-header');
      return {
        height: h.getBoundingClientRect().height,
        headings: [...document.querySelectorAll('.panel-header h2, .panel-editor-title')].map(el => ({
          whiteSpace: getComputedStyle(el).whiteSpace, overflow: getComputedStyle(el).textOverflow,
          title: el.getAttribute('data-tip') ?? el.title, text: el.textContent, height: el.getBoundingClientRect().height,
        })),
      };
    })()`);
    const wideHeadings = await headingMetrics();
    await run(`document.getElementById('panel-shell').style.width = '200px'`);
    await wait();
    const narrowHeadings = await headingMetrics();
    assert.equal(narrowHeadings.height, wideHeadings.height, 'module header height stays fixed on a narrow panel');
    assert.deepEqual(narrowHeadings.headings, wideHeadings.headings, 'editor heading heights stay fixed on resize');
    assert.ok(narrowHeadings.headings.every(h => h.whiteSpace === 'nowrap' && h.overflow === 'ellipsis' && h.title === h.text),
      `all panel headings are single-line, ellipsized and expose their complete text: ${JSON.stringify(narrowHeadings.headings)}`);
    await run(`document.getElementById('panel-shell').style.removeProperty('width')`);
    await wait();

    const point = async (selector, x, y, keyMap = false) => {
      await run(`document.querySelector('${selector}').scrollIntoView({ block: 'center' })`);
      await wait();
      return run(`(() => {
        const cv = document.querySelector('${selector}'), r = cv.getBoundingClientRect();
        return { x: Math.round(r.left + cv.clientLeft + ${keyMap ? `${x} * cv.clientWidth` : `12 + ${x} * (cv.clientWidth - 24)`}),
          y: Math.round(r.top + cv.clientTop + ${keyMap ? `6 + ${y} * (cv.clientHeight - 36)` : `12 + ${y} * (cv.clientHeight - 24)`}) };
      })()`);
    };
    const click = async (p, clickCount = 1) => {
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...p, clickCount });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', ...p, clickCount });
      await wait(20);
    };
    const scrollTrack = await run(`(() => {
      const p = document.getElementById('panel'), t = document.getElementById('panel-scroll'), r = t.getBoundingClientRect();
      p.scrollTop = 0;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * .8), hidden: t.hidden };
    })()`);
    assert.equal(scrollTrack.hidden, false);
    await click({ x: scrollTrack.x, y: scrollTrack.y });
    await wait();
    assert.equal(await run(`(() => {
      const p = document.getElementById('panel'), t = document.getElementById('panel-scroll'), h = document.getElementById('panel-scroll-thumb');
      const r = t.getBoundingClientRect(), b = h.getBoundingClientRect();
      return p.scrollTop > 0 && Math.abs(b.top + b.height / 2 - ${scrollTrack.y}) < 2;
    })()`), true, 'actual controller-panel track click jumps to the clicked position');
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

    await run(`(async () => {
      const { engine, select, undoHistory } = window.velocityTest;
      const entry = await engine.root.addModule('TUNING');
      const state = structuredClone(entry.state);
      state.map[61] = 61.375;
      state.map[64] = 63.875;
      engine.root.setState(entry.id, state);
      window.tuningId = entry.id;
      window.tuningState = () => engine.root.modules.get(window.tuningId).state;
      select({ kind: 'module', entry });
      undoHistory.reset();
    })()`);
    const tuningBefore = await run('JSON.stringify(window.tuningState())');
    const stripPoint = async (key, start = 0, span = 128) => {
      await run(`document.querySelector('.p2c-view canvas').scrollIntoView({ block: 'center' })`);
      await wait();
      return run(`(() => {
        const cv = document.querySelector('.p2c-view canvas'), r = cv.getBoundingClientRect();
        return { x: Math.round(r.left + cv.clientLeft + (${key} + .5 - ${start}) / ${span} * cv.clientWidth),
          y: Math.round(r.top + cv.clientTop + cv.clientHeight - 22) };
      })()`);
    };
    const selectedTuning = () => run(`({
      key: document.querySelector('.tuning-key-name').textContent,
      values: [...document.querySelectorAll('.tuning-key input')].map(i => Number(i.value)),
    })`);
    await click(await stripPoint(61));
    assert.deepEqual(await selectedTuning(), { key: 'C#4 (61)', values: [61.375, 37.5] },
      'clicking a black piano key shows its exact stored pitch and cents');
    await click(await stripPoint(64));
    assert.deepEqual(await selectedTuning(), { key: 'E4 (64)', values: [63.875, -12.5] },
      'clicking a white piano key updates both fields without drawing');
    await run("document.querySelector('.tuning-cents').click()");
    await click(await stripPoint(61));
    assert.deepEqual((await selectedTuning()).values, [61.375, 37.5], 'selection also works in Cents view');
    await run("document.querySelectorAll('.p2c-zoom')[1].click()");
    // With no sounding note, zoom centres on the map: 64 keys starting at 32.
    await click(await stripPoint(64, 32, 64));
    assert.deepEqual((await selectedTuning()).values, [63.875, -12.5], 'selection respects keyboard zoom');
    const from = await stripPoint(64, 32, 64);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', ...from, clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x + 60, y: from.y });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: from.x + 60, y: from.y, clickCount: 1 });
    await wait();
    assert.deepEqual((await selectedTuning()).values, [63.875, -12.5], 'dragging the keyboard scrolls without selecting another note');
    assert.equal(await run('JSON.stringify(window.tuningState())'), tuningBefore, 'keyboard selection and scrolling never change tuning');
    assert.equal(await run('window.velocityTest.undoHistory.travel(-1)'), false, 'selection creates no undo edit');
    assert.deepEqual(errors, [], 'tuning selection has no app or worklet errors');
    console.log('TUNING keyboard selection UI tests passed');
    await run(`(async () => {
      const { addClip, addAutoClip, cloneClip } = await import('/src/song.js');
      const { engine, seq, undoHistory } = window.velocityTest;
      engine.song.clips = [];
      const a = addClip(engine.song, { start: 0, length: 4, target: window.velocityId });
      const b = addAutoClip(engine.song, { start: 0, length: 4, y: 34, target: window.velocityId });
      const c = cloneClip(engine.song, a); c.y = 68;
      window.colorIds = [a.id, b.id, c.id];
      engine.song.selected = a.id;
      engine.root.recolor(window.velocityId, '#123456');
      seq.reload();
      seq.applyView({ top: .4, bottom: .6, arranger: { sx: 0, sy: 0, ppq: 16 } });
      undoHistory.reset();
      window.clipColors = () => window.colorIds.map(id => engine.song.clips.find(c => c.id === id).color);
      window.clipPointer = (type, lane, props = {}) => {
        const cv = document.querySelector('#arranger canvas'), r = cv.getBoundingClientRect();
        cv.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + 86,
          clientY: r.top + 68 + lane * 34 + 17, pointerId: 1, button: 0, ...props }));
      };
      window.openClipColorMenu = (lane = 0) => {
        window.clipPointer('pointerdown', lane, { button: 2, buttons: 2 });
        window.clipPointer('pointerup', lane, { button: 2 });
        [...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('Set Clip Color')).click();
      };
    })()`);
    await wait();
    await run(`(() => {
      window.clipPointer('pointerdown', 0);
      window.clipPointer('pointerup', 0);
      window.clipPointer('pointerdown', 1, { ctrlKey: true });
      window.clipPointer('pointerup', 1, { ctrlKey: true });
      window.openClipColorMenu();
    })()`);
    assert.equal(await run("document.getElementById('color-title').textContent"), 'Color of 3 clips');
    await run(`(() => {
      for (const [channel, value] of [['r', 171], ['g', 205], ['b', 239]]) {
        const slider = document.getElementById('color-' + channel);
        slider.value = value; slider.dispatchEvent(new Event('input'));
      }
      document.getElementById('color-dialog').close('ok');
    })()`);
    await wait();
    assert.deepEqual(await run('window.clipColors()'), ['#abcdef', '#abcdef', '#abcdef'], 'mixed selection also updates unselected linked clones');
    assert.equal(await run('window.velocityTest.undoHistory.travel(-1)'), true);
    assert.deepEqual(await run('window.clipColors()'), [null, null, null], 'one undo restores the entire group');
    assert.equal(await run('window.velocityTest.undoHistory.travel(-1)'), false, 'no second edit');
    assert.equal(await run('window.velocityTest.undoHistory.travel(1)'), true);
    await wait();
    await run("(() => { window.openClipColorMenu(); document.getElementById('color-dialog').close('cancel'); })()");
    await wait();
    assert.deepEqual(await run('window.clipColors()'), ['#abcdef', '#abcdef', '#abcdef'], 'cancel preserves colors');
    await run(`(() => {
      window.clipPointer('pointerdown', 0);
      window.clipPointer('pointerup', 0);
      window.openClipColorMenu();
      document.getElementById('color-reset').click();
      document.getElementById('color-dialog').close('ok');
    })()`);
    await wait();
    assert.deepEqual(await run('window.clipColors()'), [null, '#abcdef', null], 'source reset clears its whole linked group only');
    assert.equal(await run("document.getElementById('workspace').style.getPropertyValue('--clip-color')"), '#123456', 'reset uses connected module custom color');
    await run(`(() => {
      window.openClipColorMenu(2);
      const slider = document.getElementById('color-r');
      slider.value = 255; slider.dispatchEvent(new Event('input'));
      document.getElementById('color-dialog').close('ok');
    })()`);
    await wait();
    assert.deepEqual(await run('window.clipColors()'), ['#ff3456', '#abcdef', '#ff3456'],
      'editing a clone updates the source without changing unrelated clips');
    assert.equal(await run('window.velocityTest.undoHistory.travel(-1)'), true);
    assert.deepEqual(await run('window.clipColors()'), [null, '#abcdef', null], 'clone edit is one undoable group edit');
    await run(`(async () => {
      const { cloneClip } = await import('/src/song.js');
      const { engine, seq } = window.velocityTest;
      const source = engine.song.clips.find(c => c.id === window.colorIds[1]);
      const clone = cloneClip(engine.song, source); clone.y = 102;
      window.colorIds.push(clone.id);
      seq.reload();
      window.openClipColorMenu(3);
      document.getElementById('color-reset').click();
      document.getElementById('color-dialog').close('ok');
    })()`);
    await wait();
    assert.deepEqual(await run('window.clipColors()'), [null, null, null, null],
      'resetting an automation clone clears its source color too');
    assert.deepEqual(errors, [], 'clip colors have no app or worklet errors');
    console.log('Clip color menu, multi-selection, undo, cancel and inheritance UI tests passed');
    for (const [type, titles] of [
      ['OSC', ['Waveform', 'ADSR envelope']],
      ['ADSR', ['ADSR envelope']],
      ['OPERATOR', ['ADSR envelope']],
      ['ENVELOPE', ['Envelope curve']],
      ['WAVESHAPER', ['Shaping curve']],
      ['LFO', ['LFO output']],
      ['EQ', ['Frequency response']],
      ['DISTORTION', ['Distortion types']],
      ['COMPRESSOR', ['Compression curve']],
      ['PITCH2CTL', ['Pitch to controller']],
      ['SAMPLER', ['Sample editor']],
      ['WAVETABLE', ['Wavetable']],
      ['IMAGESAMPLER', ['Image scanner', 'ADSR envelope']],
    ]) {
      await run(`(async () => {
        const { engine, select } = window.velocityTest;
        const entry = await engine.root.addModule(${JSON.stringify(type)});
        select({ kind: 'module', entry });
      })()`);
      assert.deepEqual(await run(`[...document.querySelectorAll('#panel .panel-editor-title')].map(h => h.textContent)`),
        titles, `${type}: each mini editor has a consistent, non-duplicated heading`);
    }
    assert.deepEqual(errors, [], 'mini editor headings render without app or worklet errors');
    console.log('Module mini-editor heading UI tests passed');
    for (const key of ['Backspace', 'Delete']) {
      await run(`(async () => {
        const { engine, select, undoHistory } = window.velocityTest;
        const a = await engine.root.addModule('OSC');
        const b = await engine.root.addModule('AMP');
        engine.root.connect(a.id, b.id);
        window.velocityTest.render();
        window.deleteIds = [a.id, b.id];
        select({ kind: 'group', entries: [engine.root.modules.get(0), a, b] });
        undoHistory.reset();
        const canvas = document.getElementById('canvas');
        canvas.focus();
        canvas.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
        }));
      })()`);
      assert.equal(await run('window.deleteIds.every(id => !window.velocityTest.engine.root.modules.has(id))'),
        true, `${key} deletes every selected non-Output module`);
      assert.equal(await run('window.velocityTest.engine.root.modules.has(0)'), true, 'Output stays');
      assert.equal(await run('window.velocityTest.undoHistory.travel(-1)'), true, 'group deletion is undoable');
      assert.equal(await run('window.deleteIds.every(id => window.velocityTest.engine.root.modules.has(id))'),
        true, 'one undo restores the entire deleted group');
      assert.equal(await run(`window.velocityTest.engine.root.cables.some(c => c.from === window.deleteIds[0] && c.to === window.deleteIds[1])`),
        true, 'undo restores the cables between deleted modules');
    }
    console.log('Group module deletion keyboard UI tests passed');
  } finally {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
