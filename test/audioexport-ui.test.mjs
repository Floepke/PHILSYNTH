// Linux: xvfb-run -a node_modules/.bin/electron test/audioexport-ui.test.mjs --no-sandbox
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
          this.ctx = { currentTime: 0, state: 'running', sampleRate: 48000 };
          this.dsp = dspTestHost().dsp;
          this.root = await PatchRuntime.create(this, this.dsp.destination);
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => Object.assign(new EventTarget(), { inputs: new Map() }) });
        window.picks = 0;
        window.writes = [];
        window.testFormat = '.wav';
        window.showSaveFilePicker = async () => {
          window.picks++;
          return { name: 'test' + window.testFormat, createWritable: async () => ({
            write: async blob => window.writes.push(await blob.arrayBuffer()), close: async () => {}, abort: async () => {}
          }) };
        };
        await import('/src/main.js');
      </script>`);
    server = http.createServer(async (req, res) => {
      try {
        const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
        let body = path === root ? index : await readFile(path);
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.exportTest = { engine, seq, exportAudio };\n';
        res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(path) ? 'text/javascript'
          : path.endsWith('.css') ? 'text/css' : path.endsWith('.wasm') ? 'application/wasm' : 'text/html' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const run = code => win.webContents.executeJavaScript(code);
    const waitFor = async condition => {
      const end = Date.now() + 15000;
      while (!(await run(condition))) {
        if (Date.now() > end) throw new Error(`Timed out: ${condition}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await waitFor('!!window.exportTest');
    await run(`(async () => {
      const { engine, seq } = window.exportTest;
      const { emptySong, addClip } = await import('/src/song.js');
      engine.song = emptySong();
      const osc = await engine.root.addModule('OSC');
      engine.root.connect(osc.id, 0);
      addClip(engine.song, { length: 1, target: osc.id }).notes.push({ pitch: 60, start: 0, length: 0.5, vel: 0.8 });
      seq.reload();
      window.exportProjectBefore = JSON.stringify(engine.saveProject());
      window.wavPeak = bytes => {
        const v = new DataView(bytes);
        let peak = 0;
        for (let i = 44; i < bytes.byteLength; i += 3) {
          let s = v.getUint8(i) | v.getUint8(i + 1) << 8 | v.getUint8(i + 2) << 16;
          if (s & 0x800000) s -= 0x1000000;
          peak = Math.max(peak, Math.abs(s / 0x800000));
        }
        return peak;
      };
    })()`);
    const begin = async () => {
      await run('window.exportPromise = window.exportTest.exportAudio(); void 0');
      await waitFor("document.getElementById('export-level-dialog').open");
    };
    await begin();
    assert.equal(await run('window.picks'), 1, 'save picker precedes level dialog');
    assert.equal(await run('window.writes.length'), 0, 'no file is written before choosing a level');
    assert.ok(await run("document.getElementById('export-level-dialog').textContent.includes('preserving quiet/loud relationships')"));
    await run("document.getElementById('export-level-dialog').querySelector('[value=cancel]').click(); window.exportPromise");
    assert.equal(await run('window.writes.length'), 0);
    await begin();
    await run("document.getElementById('export-level-dialog').close(''); window.exportPromise");
    assert.equal(await run('window.writes.length'), 0, 'Escape/close cancels without writing');
    for (const mode of ['original', 'normalize']) {
      await begin();
      await run(`document.getElementById('export-level-dialog').querySelector('[value=${mode}]').click(); window.exportPromise`);
    }
    const peaks = await run('window.writes.map(window.wavPeak)');
    assert.ok(Math.abs(20 * Math.log10(peaks[1]) + 1) < 0.00001, 'encoded WAV reaches exactly -1 dBFS');
    assert.ok(Math.abs(peaks[0] - peaks[1]) > 0.01, 'Original Dynamics preserves the original level');
    assert.equal(await run('JSON.stringify(window.exportTest.engine.saveProject()) === window.exportProjectBefore'), true, 'export does not change the project');
    for (const ext of ['.mp3', '.ogg']) {
      await run(`window.testFormat = '${ext}'`);
      await begin();
      await run("document.getElementById('export-level-dialog').querySelector('[value=normalize]').click(); window.exportPromise");
      assert.equal(await run("document.getElementById('export-dialog').open"), false, `${ext} export done: the dialog closes by itself`);
      assert.ok(await run("document.getElementById('status').textContent.startsWith('Exported ')"), `${ext} normalization exports successfully`);
    }
    assert.equal(await run('window.writes.length'), 4);
    assert.equal(await run("document.getElementById('status').textContent.includes('Clipped:')"), false);
    console.log('Audio export level dialog and worker UI tests passed (WAV, MP3, Ogg)');
  } finally {
    win?.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
