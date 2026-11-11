// Linux: xvfb-run -a node_modules/.bin/electron test/recording-ui.test.mjs --no-sandbox
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
    const index = (await readFile(resolve(root, 'index.html'), 'utf8'))
      .replace('<script type="module" src="src/main.js"></script>', `<script type="module">
        const input = Object.assign(new EventTarget(), { id: 'recording', name: 'Test controller', state: 'connected', open: async () => {} });
        window.testMidi = (status, pitch, velocity = 0) => {
          const event = new Event('midimessage');
          event.data = Uint8Array.from([status, pitch, velocity]);
          input.dispatchEvent(event);
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => Object.assign(new EventTarget(), { inputs: new Map([['recording', input]]) }) });
        await import('/src/main.js');
      </script>`);
    server = http.createServer(async (req, res) => {
      try {
        const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
        if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
        let body = path === root ? index : await readFile(path);
        if (path === resolve(root, 'src/main.js')) body += '\nwindow.recordingTest = { engine, transport, seq, undoHistory };\n';
        const type = /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css'
          : path.endsWith('.wasm') ? 'application/wasm' : 'text/html';
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: true, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/?dsp=js`);
    const run = (code) => win.webContents.executeJavaScript(code);
    const waitFor = async (condition, label) => {
      const end = Date.now() + 10000;
      while (!(await run(condition))) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitFor('!!window.recordingTest', 'application initialized');
    await run(`(async () => {
      const { engine, seq, undoHistory, transport } = window.recordingTest;
      const { addClip, emptySong, setSig } = await import('/src/song.js');
      engine.song = emptySong();
      const osc = await engine.root.addModule('OSC');
      engine.root.connect(osc.id, 0);
      engine.root.setParam(0, 'bpm', 240);
      const clip = addClip(engine.song, { start: 4, length: 4, target: osc.id });
      setSig(engine.song, 4, 3, 8);
      engine.song.selected = clip.id;
      seq.reload();
      seq.applyView({ roll: { sy: 0, ppq: 48 } });
      undoHistory.reset();
      window.recordingClip = () => engine.song.clips.find(c => c.id === engine.song.selected);
      window.recordingKey = key => {
        const cv = document.querySelector('#roll canvas');
        cv.focus();
        cv.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      };
      await engine.ctx.resume();
      window.playbackReports = [];
      const receive = transport.receive.bind(transport);
      transport.receive = state => { window.playbackReports.push(state); receive(state); };
    })()`);
    assert.deepEqual(await run(`(() => {
      const button = document.getElementById('seq-metronome');
      const record = document.getElementById('seq-record').getBoundingClientRect();
      const box = button.getBoundingClientRect();
      button.click();
      return {
        enabled: window.recordingTest.transport.metronome,
        pressed: button.getAttribute('aria-pressed'),
        active: button.classList.contains('playing'),
        adjacent: Math.abs(box.top - record.top) < 1 && box.left >= record.right,
        playing: window.recordingTest.transport.playing,
      };
    })()`), { enabled: true, pressed: 'true', active: true, adjacent: true, playing: false });
    await run(`document.getElementById('seq-record').click()`);
    assert.equal(await run("document.getElementById('seq-record').getAttribute('aria-pressed')"), 'true');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await run("getComputedStyle(document.getElementById('seq-record')).animationName"), 'record-pulse');
    assert.equal(await run("getComputedStyle(document.getElementById('seq-record')).animationDuration"), '0.5s');
    assert.equal(await run("document.getElementById('seq-record').getAnimations()[0].playbackRate"), 2, '240 BPM doubles the flash rate without changing its duration');
    assert.equal(await run('window.recordingTest.transport.playing'), false, 'arming does not start playback');
    await run(`(() => {
      const cv = document.querySelector('#roll canvas'), box = cv.getBoundingClientRect();
      cv.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + box.width / 2, clientY: box.top + 1.1 * 48, bubbles: true }));
      window.recordingKey(' ');
      window.testMidi(0x90, 50, 100);
    })()`);
    await waitFor('window.playbackReports.some(state => state.elapsed < 0)', 'audio count-in began');
    assert.equal(await run('window.recordingTest.transport.pos'), 5, 'count-in parks at the snapped pointer position');
    assert.equal(await run('window.recordingClip().notes.length'), 0, 'count-in MIDI is ignored');
    await waitFor('window.recordingTest.transport.elapsed > 0.1', 'count-in completed');
    await run("window.testMidi(0x80, 50); window.testMidi(0x90, 60, 64)");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await run("window.testMidi(0x80, 60); window.testMidi(0x90, 64, 127)");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await run(`document.getElementById('seq-stop').click()`);
    const notes = await run('window.recordingClip().notes');
    assert.deepEqual(notes.map(({ pitch, vel }) => [pitch, vel]), [[60, 64 / 127], [64, 1]]);
    assert.ok(notes.every((n) => n.start >= 1 && n.start < 4 && n.length > 0 && n.length < 1));
    assert.equal(await run('window.recordingTest.seq.recordArmed()'), false, 'Stop releases recording');
    assert.equal(await run('window.recordingTest.transport.metronome'), true, 'Stop retains metronome toggle');
    await run("document.getElementById('seq-metronome').click()");
    assert.equal(await run('window.recordingTest.transport.metronome'), false);
    assert.equal(await run("document.getElementById('seq-metronome').getAttribute('aria-pressed')"), 'false');
    assert.equal(await run("document.getElementById('seq-record').getAttribute('aria-pressed')"), 'false');
    assert.equal(await run('window.recordingTest.engine.saveProject().song.clips[0].notes.length'), 2, 'recorded notes are in the saved project');
    const countIn = await run('window.playbackReports.filter(state => state.elapsed < 0)');
    assert.ok(countIn.length > 5);
    assert.ok(countIn.every((state) => state.pos === 5), 'the worklet holds the start position throughout count-in');
    assert.ok(Math.abs(countIn[0].elapsed + 1.5) < 0.05, '3/8 count-in lasts three eighth-note beats');
    await run('window.recordingTest.undoHistory.travel(-1)');
    assert.equal(await run('window.recordingClip().notes.length'), 0, 'one Undo removes the entire take');
    await run('window.recordingTest.undoHistory.travel(1)');
    assert.equal(await run('window.recordingClip().notes.length'), 2, 'Redo restores the take');

    await run(`(() => {
      window.recordingClip().length = 1;
      document.getElementById('seq-record').click();
      window.recordingKey('/');
    })()`);
    await waitFor('window.recordingTest.transport.elapsed > 0.05', 'loop count-in completed');
    await run('window.testMidi(0x90, 67, 100)');
    await new Promise((resolve) => setTimeout(resolve, 70));
    await run('window.testMidi(0x80, 67)');
    await waitFor('window.recordingTest.transport.elapsed > 1.05', 'first loop wrapped');
    await run('window.testMidi(0x90, 72, 90)');
    await new Promise((resolve) => setTimeout(resolve, 70));
    await run('window.testMidi(0x80, 72)');
    assert.equal(await run('window.recordingTest.transport.playing'), true);
    assert.equal(await run('window.recordingTest.seq.recordArmed()'), true);
    assert.ok((await run('window.recordingClip().notes.map(note => note.pitch)')).includes(67));
    assert.ok((await run('window.recordingClip().notes.map(note => note.pitch)')).includes(72));
    await run(`window.recordingKey("'")`);
    assert.equal(await run('window.recordingTest.transport.playing'), false, "' stops the loop");
    assert.equal(await run('window.recordingTest.seq.recordArmed()'), false);

    await run(`document.getElementById('seq-record').click(); window.recordingKey('/')`);
    await waitFor('window.recordingTest.transport.elapsed < -0.5', 'second count-in began');
    await run(`document.getElementById('seq-record').click()`);
    assert.equal(await run('window.recordingTest.seq.recordArmed()'), false, 'clicking Record cancels count-in');
    assert.equal(await run('window.recordingTest.transport.playing'), false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(await run('window.recordingTest.transport.playing'), false, 'cancelled count-in never starts later');
    await run(`window.recordingKey("'"); document.getElementById('seq-record').click(); window.recordingKey("'")`);
    assert.equal(await run('window.recordingTest.seq.recordArmed()'), false, 'Stop also disarms before playback starts');
    await run(`(() => {
      window.recordingTest.transport.seek(4.5);
      document.getElementById('seq-record').click();
      document.getElementById('seq-play').click();
    })()`);
    await waitFor('window.recordingTest.transport.elapsed > 0.01', 'single-pass count-in completed');
    await run('window.testMidi(0x90, 76, 80)');
    await waitFor('window.recordingTest.transport.elapsed > 0.8', 'recording continued past the original clip end');
    assert.equal(await run('window.recordingTest.transport.playing'), true);
    await run(`document.getElementById('seq-stop').click()`);
    assert.equal(await run('window.recordingTest.seq.recordArmed()'), false);
    const finalNote = await run('window.recordingClip().notes.at(-1)');
    assert.equal(finalNote.pitch, 76);
    assert.ok(finalNote.length > 0);
    assert.ok(finalNote.start + finalNote.length > 1, 'held note continues past the original clip end');
    assert.ok(await run('window.recordingClip().length > 1'), 'recording extends the clip to contain the held note');
    await run('window.recordingTest.engine.ctx.close()');
    console.log('MIDI recording UI tests passed (real AudioWorklet, mock MIDI controller)');
  } finally {
    win?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
