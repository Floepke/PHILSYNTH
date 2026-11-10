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
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => Object.assign(new EventTarget(), { inputs: new Map() }) });
        await import('/src/main.js');
      </script>`);
    server = http.createServer(async (req, res) => {
      try {
        const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
        let body = path === root ? index : await readFile(path);
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.analysisTest = { engine, seq, analysePanel, select, render, viewState, applyView, shown };\n';
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
    const waitFor = async (condition, label = condition) => {
      const end = Date.now() + 10000;
      while (!(await run(condition))) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}\n${JSON.stringify(await run(`({
          ops: window.analysisOps, reports: window.analysisReports, last: window.lastAnalysis && { h: window.lastAnalysis.h, peak: window.lastAnalysis.peak },
          state: document.querySelector('.analyse-state')?.textContent,
          width: document.getElementById('analyse-panel')?.clientWidth,
          target: document.querySelector('.analyse-target')?.textContent,
          status: document.getElementById('status')?.textContent
        })`))}\n${errors.join('\n')}`);
        await delay(20);
      }
    };
    for (const backend of ['js', 'wasm']) {
      await win.loadURL(`http://127.0.0.1:${server.address().port}/?dsp=${backend}`);
      await waitFor('!!window.analysisTest');
      await run(`(async () => {
        const { engine, seq, render, select } = window.analysisTest;
        window.analysisOps = [];
        window.analysisReports = 0;
        const post = engine.dsp.post.bind(engine.dsp);
        engine.dsp.post = op => { if (op[0] === 'analyse') window.analysisOps.push(op[1]); post(op); };
        const receive = engine.dsp.receive.bind(engine.dsp);
        engine.dsp.receive = report => {
          if (report.analysis) { window.analysisReports++; window.lastAnalysis = report.analysis; }
          receive(report);
        };
        const osc = await engine.root.addModule('OSC', { x: 100, y: 120 });
        const amp = await engine.root.addModule('AMP', { x: 330, y: 120 });
        const lfo = await engine.root.addModule('LFO');
        engine.root.setParam(osc.id, 'wave', 0);
        engine.root.setParam(osc.id, 'gain', 1);
        engine.root.setParam(amp.id, 'amp', 4);
        engine.root.connect(osc.id, amp.id);
        engine.root.connect(amp.id, 0);
        window.analysisEntries = { osc, amp, lfo };
        render();
        await engine.ctx.resume();
        osc.inst.noteOn(9001, 69, 1);
        window.analyseKey = key => document.getElementById('analyse-split').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      })()`);
      await waitFor('window.lastAnalysis?.peak[0] > 1');
      await waitFor("document.querySelector('.analyse-clip').classList.contains('clipping')");
      assert.equal(await run('window.analysisTest.engine.dspInfo.dsp'), backend);
      assert.ok(await run("document.querySelector('.analyse-target').textContent.includes('#0')"), 'no module selection monitors Output');
      assert.ok(await run('window.fftCount > 0'));
      assert.ok(await run("parseFloat(document.querySelector('.analyse-peak').textContent) > 0"), 'above-zero samples remain measurable');
      assert.ok(await run("document.querySelector('.analyse-channel .analyse-fill').getBoundingClientRect().width > 0"));
      assert.ok(await run(`(() => {
        const c = document.querySelector('#analyse-panel canvas'), g = c.getContext('2d');
        const pixels = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 2] > 150 && pixels[i] < 130) return true;
        return false;
      })()`), 'a spectrum trace is actually drawn');

      await run("window.analysisTest.select({ kind: 'module', entry: window.analysisEntries.osc })");
      await waitFor('window.lastAnalysis.h === window.analysisEntries.osc.inst.node.h');
      assert.ok(await run('window.lastAnalysis.peak[0] < 1'), 'selection measures the oscillator before the amplifier');
      await delay(80);
      assert.equal(await run("document.querySelector('.analyse-clip').classList.contains('clipping')"), false, 'selection resets stale clipping');
      await run("window.analysisTest.select({ kind: 'module', entry: window.analysisEntries.lfo })");
      await waitFor('window.analysisOps.at(-1) === null');
      assert.match(await run("document.querySelector('.analyse-state').textContent"), /No audio/);
      await run('window.analysisTest.engine.root.setParam(window.analysisEntries.lfo.id, "mode", 1)');
      await waitFor('window.analysisOps.at(-1) === window.analysisEntries.lfo.inst.node.h', 'switching to audio mode refreshes eligibility');
      await run('window.analysisTest.engine.root.setParam(window.analysisEntries.lfo.id, "mode", 0)');
      await waitFor('window.analysisOps.at(-1) === null');
      await run('window.analysisTest.select(null)');
      await waitFor("document.querySelector('.analyse-clip').classList.contains('clipping')");
      await run('window.analysisTest.engine.root.setParam(window.analysisEntries.amp.id, "amp", 0.5)');
      await delay(100);
      await run("document.querySelector('.analyse-reset').click()");
      await delay(80);
      assert.equal(await run("document.querySelector('.analyse-clip').classList.contains('clipping')"), false);

      // The Analyse divider is independent: diagonal pointer motion must only change its width.
      const before = await run('window.analysisTest.seq.viewState()');
      const box = await run(`(() => {
        const b = document.getElementById('analyse-split').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      mouse('mouseDown', box.x, box.y);
      mouse('mouseMove', box.x - 70, box.y + 90);
      mouse('mouseUp', box.x - 70, box.y + 90);
      await delay(100);
      assert.ok(await run('window.analysisTest.analysePanel.viewState().width > 330'));
      const after = await run('window.analysisTest.seq.viewState()');
      assert.deepEqual([after.top, after.bottom, after.panelWidth], [before.top, before.bottom, before.panelWidth]);
      assert.equal(await run('window.analysisTest.viewState().analyse.width'), await run('window.analysisTest.analysePanel.viewState().width'), 'width is included in project view');
      await run('window.analysisTest.analysePanel.applyView({ width: 310 })');
      await delay(50);
      assert.equal(await run('document.getElementById("analyse-panel").clientWidth'), 310);
      await run(`(() => {
        window.savedAnalysisView = window.analysisTest.viewState();
        window.analysisTest.applyView({ ...window.savedAnalysisView, analyse: undefined });
      })()`);
      assert.equal(await run('window.analysisTest.analysePanel.viewState().width'), 280, 'old project views use the default width');
      await run('window.analysisTest.applyView(window.savedAnalysisView)');
      assert.equal(await run('window.analysisTest.analysePanel.viewState().width'), 310, 'project view restores the saved width');
      const patcher = await run(`(() => {
        const a = document.getElementById('analyse-panel').getBoundingClientRect();
        const p = document.getElementById('patcher').getBoundingClientRect();
        return { top: a.top === p.top, bottom: a.bottom === p.bottom };
      })()`);
      assert.deepEqual(patcher, { top: true, bottom: true }, 'panel spans only the middle patcher area');
      const hideBox = await run(`(() => {
        const b = document.getElementById('analyse-split').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      mouse('mouseDown', hideBox.x, hideBox.y);
      mouse('mouseMove', 1395, hideBox.y + 20);
      mouse('mouseUp', 1395, hideBox.y + 20);
      await waitFor('window.analysisOps.at(-1) === null');
      await delay(100);
      const paused = await run('({ fft: window.fftCount, reports: window.analysisReports })');
      await delay(150);
      assert.deepEqual(await run('({ fft: window.fftCount, reports: window.analysisReports })'), paused,
        'collapsed panel runs no FFT and receives no DSP analysis frames');
      assert.equal(await run('document.getElementById("analyse-panel").clientWidth'), 0);
      await run("window.analyseKey('End')");
      await waitFor(`window.analysisReports > ${paused.reports + 1}`);
      assert.ok(await run(`window.fftCount > ${paused.fft}`), 'reopening restores analysis');
      await run(`(() => {
        const { seq } = window.analysisTest;
        window.analyseLayout = seq.viewState();
        seq.applyView({ ...window.analyseLayout, top: 0.5, bottom: 0.5 });
      })()`);
      await waitFor('window.analysisOps.at(-1) === null', 'hidden patcher disables analysis');
      await run('window.analysisTest.seq.applyView(window.analyseLayout)');
      await waitFor('window.analysisOps.at(-1) !== null');
      win.setSize(400, 1100);
      await delay(100);
      assert.ok(await run(`(() => {
        const p = document.getElementById('patcher'), a = document.getElementById('analyse-panel');
        return a.clientWidth >= 0 && p.scrollWidth <= p.clientWidth;
      })()`), 'narrow windows clamp both panels without overflowing the patcher');
      win.setSize(1400, 1100);
      await delay(100);
      await run('window.analysisTest.engine.ctx.close()');
      console.log(`${backend}: Analyse panel selection, clipping, spectrum, independent divider and CPU gating passed`);
    }
    assert.deepEqual(errors, [], 'no application or worklet errors');
  } finally {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
