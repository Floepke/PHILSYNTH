// Linux: xvfb-run -a node_modules/.bin/electron test/analysis-ui.test.mjs --no-sandbox
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
  const errors = [];
  try {
    const index = (await readFile(resolve(root, 'index.html'), 'utf8'))
      .replace('<script type="module" src="src/main.js"></script>', `<script type="module">
        import { Spectrum } from '/src/spectrum.js';
        window.fftCount = 0;
        const measure = Spectrum.prototype.measure;
        Spectrum.prototype.measure = function (...args) { window.fftCount++; return measure.apply(this, args); };
        window.frequencyLabels = [];
        window.frequencyLabelY = [];
        const fillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
          if (this.canvas.parentElement?.id === 'analyse-panel' && !window.frequencyLabels.includes(text)) window.frequencyLabels.push(text);
          if (this.canvas.parentElement?.id === 'analyse-panel') window.frequencyLabelY.push(args[1]);
          return fillText.call(this, text, ...args);
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => Object.assign(new EventTarget(), { inputs: new Map() }) });
        await import('/src/main.js');
      </script>`);
    server = http.createServer(async (req, res) => {
      try {
        const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
        let body = path === root ? index : await readFile(path);
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.analysisTest = { engine, seq, analysePanel, select, render, viewState, applyView, preferencesManager };\n';
        res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(path) ? 'text/javascript'
          : path.endsWith('.css') ? 'text/css' : path.endsWith('.wasm') ? 'application/wasm' : 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: true, width: 1400, height: 1100, webPreferences: { backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const run = code => win.webContents.executeJavaScript(code);
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitFor = async condition => {
      const end = Date.now() + 10000;
      while (!(await run(condition))) {
        if (Date.now() > end) throw new Error(`Timed out: ${condition}\n${errors.join('\n')}`);
        await delay(20);
      }
    };
    for (const backend of ['js', 'wasm']) {
      await win.loadURL(`http://127.0.0.1:${server.address().port}/?dsp=${backend}`);
      await waitFor('!!window.analysisTest');
      await run(`(async () => {
        const { engine, render } = window.analysisTest;
        window.analysisTest.analysePanel.applyView(null);
        window.fftCount = 0;
        window.analysisReports = 0;
        const receive = engine.dsp.receive.bind(engine.dsp);
        engine.dsp.receive = report => {
          if (report.analysis) { window.analysisReports++; window.lastAnalysis = report.analysis; }
          receive(report);
        };
        const osc = await engine.root.addModule('OSC', { x: 100, y: 120 });
        engine.root.setParam(osc.id, 'wave', 0);
        engine.root.setParam(osc.id, 'gain', 1);
        engine.root.connect(osc.id, 0);
        window.osc = osc;
        render();
        await engine.ctx.resume();
        osc.inst.noteOn(9001, 69, 1);
      })()`);
      await delay(150);
      assert.equal(await run('window.analysisTest.analysePanel.viewState().enabled'), false, 'new projects default to off');
      assert.equal(await run("document.getElementById('spectrum-toggle').getAttribute('aria-pressed')"), 'false');
      assert.equal(await run('window.analysisReports'), 0, 'default off sends no analysis frames');
      assert.equal(await run('window.fftCount'), 0, 'default off performs no FFT');
      await run("document.getElementById('spectrum-toggle').click()");
      await waitFor('window.fftCount > 0');
      assert.deepEqual(await run('window.frequencyLabels'), ['32', '64', '128', '256', '512', '1k', '2k', '4k', '8k', '16k'],
        'spectrogram labels the requested frequency grid through 16 kHz');
      assert.ok(await run(`window.frequencyLabelY.every(y =>
        y === Math.round(document.querySelector('#analyse-panel canvas').getBoundingClientRect().height) - 4)`),
        'frequency labels sit along the bottom of the patcher');
      assert.equal(await run('window.analysisTest.engine.dspInfo.dsp'), backend);
      assert.equal(await run("!!document.getElementById('zoom') || !!document.getElementById('analyse-split')"), false);
      const checkSize = async () => {
        assert.ok(await run(`(() => {
          const p = document.getElementById('analyse-panel'), c = p.querySelector('canvas');
          const a = p.getBoundingClientRect(), b = document.getElementById('canvas').getBoundingClientRect();
          return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
            && c.width === Math.round(a.width * devicePixelRatio) && c.height === Math.round(a.height * devicePixelRatio)
            && p.scrollHeight === p.clientHeight && p.scrollWidth === p.clientWidth;
        })()`), 'spectrogram covers the entire patcher viewport without scrolling');
      };
      await checkSize();
      assert.ok(await run(`(() => {
        const p = document.getElementById('analyse-panel'), noise = document.querySelector('#canvas .noise-bg');
        const module = window.osc.el, b = module.getBoundingClientRect();
        p.style.pointerEvents = noise.style.pointerEvents = 'auto';
        try {
          const stack = document.elementsFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return stack.indexOf(module) >= 0 && stack.indexOf(module) < stack.indexOf(p) && stack.indexOf(p) < stack.indexOf(noise);
        } finally { p.style.pointerEvents = noise.style.pointerEvents = ''; }
      })()`), 'spectrogram remains above noise and below modules and cables');
      await run('window.analysisTest.engine.ctx.suspend()');
      await run(`(() => {
        window.injectAnalysis = window.analysisTest.engine.dsp.onAnalysis;
        window.analysisTest.engine.dsp.onAnalysis = () => {};
      })()`);
      await delay(80);
      const row = (age = 0) => run(`(() => {
        const c = document.querySelector('#analyse-panel canvas');
        return Array.from(c.getContext('2d').getImageData(0, ${age} * Math.max(1, Math.round(devicePixelRatio)), c.width, 1).data);
      })()`);
      const addRow = async amplitude => {
        await run(`(() => {
          const samples = Float32Array.from(window.lastAnalysis.samples, (_, i) =>
            ${amplitude} * Math.sin(2 * Math.PI * 1000 * (i % 4096) / window.lastAnalysis.sampleRate));
          window.injectAnalysis({ ...window.lastAnalysis, samples });
        })()`);
        await delay(50);
      };
      await run("document.documentElement.style.setProperty('--wood-tint', '#804020')");
      await addRow(0);
      const silent = await row();
      await addRow(1);
      const loud = await row();
      const peak = loud.reduce((best, value, i) => i % 4 === 3 && value > loud[best] ? i : best, 3);
      assert.ok(loud[peak - 3] > loud[peak - 2] && loud[peak - 2] > loud[peak - 1], 'pixels use wood tint');
      await addRow(0.001);
      assert.ok((await row())[peak] < loud[peak], 'quieter frequencies have lower brightness');
      assert.ok(Math.abs((await row(1))[peak] - loud[peak]) <= 2, 'history moves downward');
      await run("document.documentElement.style.setProperty('--wood-tint', '#204080')");
      await addRow(1);
      const blue = await row();
      assert.ok(blue[peak - 1] > blue[peak - 2] && blue[peak - 2] > blue[peak - 3], 'new rows follow live wood tint changes');
      const fftBeforeSilence = await run('window.fftCount');
      await addRow(0);
      assert.equal((await row())[peak], silent[peak], 'silence remains transparent behind the frequency grid');
      assert.equal(await run('window.fftCount'), fftBeforeSilence, 'all-zero windows skip FFT');
      assert.ok(Math.abs((await row(1))[peak] - blue[peak]) <= 2, 'silence still scrolls existing sound downward');
      await run(`(async () => {
        const c = document.querySelector('#analyse-panel canvas');
        const samples = new Float32Array(window.lastAnalysis.samples.length);
        for (let i = 0; i <= c.clientHeight; i++) {
          window.injectAnalysis({ ...window.lastAnalysis, samples });
          await new Promise(requestAnimationFrame);
        }
      })()`);
      assert.equal(await run('window.fftCount'), fftBeforeSilence, 'scrolling all silent history performs no FFTs');
      assert.ok(await run(`(() => {
        const c = document.querySelector('#analyse-panel canvas'), g = c.getContext('2d');
        const x = ${Math.floor((peak - 3) / 4)};
        const data = g.getImageData(x, 20, 1, c.height - 20).data;
        return data.every((value, i) => i % 4 !== 3 || value <= 64);
      })()`), 'old sound scrolls completely out of the viewport during silence');
      await addRow(1);
      assert.equal(await run('window.fftCount'), fftBeforeSilence + 1, 'nonzero sound immediately resumes FFT');
      await run("window.analysisTest.preferencesManager.preview('patcher.spectrumFlowDirection', 'up')");
      const bottomRow = (age = 0) => run(`(() => {
        const c = document.querySelector('#analyse-panel canvas');
        return Array.from(c.getContext('2d').getImageData(0, c.height - 1 - ${age} * Math.max(1, Math.round(devicePixelRatio)), c.width, 1).data);
      })()`);
      await addRow(1);
      const upwardLoud = await bottomRow();
      await addRow(0);
      assert.ok(Math.abs((await bottomRow(1))[peak] - upwardLoud[peak]) <= 2, 'upward preference scrolls sound toward the top');
      assert.ok((await bottomRow())[peak] < upwardLoud[peak], 'upward preference inserts new silence at the bottom');
      await run('window.analysisTest.preferencesManager.restore()');
      await run('void (window.analysisTest.engine.dsp.onAnalysis = window.injectAnalysis)');
      await run('window.analysisTest.engine.ctx.resume()');
      for (const size of [512, 8192, 32768]) {
        await run(`window.analysisTest.preferencesManager.preview('patcher.spectrumSize', '${size}')`);
        await waitFor(`window.lastAnalysis.samples.length === ${size * 2}`);
        const previousFft = await run('window.fftCount');
        await waitFor(`window.fftCount > ${previousFft}`);
      }
      await run('window.analysisTest.preferencesManager.restore()');
      await waitFor('window.lastAnalysis.samples.length === 8192');
      await run("document.documentElement.style.removeProperty('--wood-tint')");
      await run('void (window.analysisTest.engine.dsp.onAnalysis = window.injectAnalysis)');
      await run('window.analysisTest.engine.ctx.resume()');
      await run("window.analysisTest.select({ kind: 'module', entry: window.osc })");
      await waitFor('window.lastAnalysis.h === window.osc.inst.node.h');
      await run(`(async () => {
        const midi = await window.analysisTest.engine.root.addModule('MULTIMIDI');
        window.analysisTest.render();
        window.analysisTest.select({ kind: 'module', entry: midi });
        window.fallbackReports = window.analysisReports;
      })()`);
      await waitFor('window.analysisReports > window.fallbackReports && window.lastAnalysis.h === window.analysisTest.engine.root.modules.get(0).inst.input.h');
      const fallbackFft = await run('window.fftCount');
      await waitFor(`window.fftCount > ${fallbackFft + 1}`);
      const camera = await run('({ cams: window.analysisTest.viewState().cams, size: window.analysisTest.viewState().cameraSize })');
      const button = await run(`(() => {
        const b = document.getElementById('spectrum-toggle').getBoundingClientRect();
        const p = document.getElementById('canvas').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, width: b.width, height: b.height, right: p.right - b.right, top: b.top - p.top };
      })()`);
      assert.equal(button.right, 12);
      assert.equal(button.top, 12);
      assert.equal(button.width, button.height, 'spectrum toggle is exactly square');
      const click = async () => {
        for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(button.x), y: Math.round(button.y), button: 'left', clickCount: 1 });
        await delay(100);
      };
      await click();
      assert.equal(await run("document.getElementById('spectrum-toggle').getAttribute('aria-pressed')"), 'false');
      assert.deepEqual(await run('window.analysisTest.viewState().analyse'), { enabled: false });
      const paused = await run('({ fft: window.fftCount, reports: window.analysisReports })');
      await delay(150);
      assert.deepEqual(await run('({ fft: window.fftCount, reports: window.analysisReports })'), paused, 'off stops analysis and FFT');
      await click();
      await waitFor(`window.analysisReports > ${paused.reports + 1}`);
      assert.deepEqual(await run('({ cams: window.analysisTest.viewState().cams, size: window.analysisTest.viewState().cameraSize })'), camera, 'toggle does not move camera');
      await run('window.analysisTest.analysePanel.applyView({ enabled: false })');
      assert.equal(await run("document.getElementById('spectrum-toggle').getAttribute('aria-pressed')"), 'false');
      await run('window.analysisTest.analysePanel.applyView({ enabled: true })');
      assert.equal(await run('window.analysisTest.analysePanel.viewState().enabled'), true, 'saved enabled state still restores');
      await run('window.analysisTest.analysePanel.applyView({})');
      assert.equal(await run('window.analysisTest.analysePanel.viewState().enabled'), false, 'missing saved state defaults to off');
      await run('window.analysisTest.analysePanel.applyView({ width: 0 })');
      assert.equal(await run('window.analysisTest.analysePanel.viewState().enabled'), false, 'legacy hidden views remain off');
      await run('window.analysisTest.analysePanel.applyView({ width: 310 })');
      assert.equal(await run('window.analysisTest.analysePanel.viewState().enabled'), true, 'legacy visible views fill the patcher');
      await run(`(() => {
        window.layout = window.analysisTest.seq.viewState();
        window.analysisTest.seq.applyView({ ...window.layout, panelWidth: window.layout.panelWidth + 80 });
      })()`);
      await delay(100);
      await checkSize();
      await run('window.analysisTest.seq.applyView({ ...window.layout, top: 0.5, bottom: 0.5 })');
      await delay(100);
      const hidden = await run('window.analysisReports');
      await delay(150);
      assert.equal(await run('window.analysisReports'), hidden, 'hidden patcher pauses analysis');
      await run('window.analysisTest.seq.applyView(window.layout)');
      await waitFor(`window.analysisReports > ${hidden}`);
      await run('window.analysisTest.engine.ctx.close()');
      console.log(`${backend}: spectrum toggle, full viewport, layering, tinted history and CPU gating passed`);
    }
    assert.deepEqual(errors, []);
  } finally {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
