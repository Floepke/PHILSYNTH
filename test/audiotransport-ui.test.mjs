// Linux: xvfb-run -a node_modules/.bin/electron test/audiotransport-ui.test.mjs --no-sandbox
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Audio-thread playback regression</title>');
      return;
    }
    if (!/^\/src\/[a-z0-9/.-]+\.(js|wasm)$/.test(req.url)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(new URL('..' + req.url, import.meta.url));
      res.setHeader('Content-Type', req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(body);
    } catch (error) {
      console.error(error);
      res.writeHead(500);
      res.end(String(error));
    }
  });
  const win = new BrowserWindow({ show: true, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(event.message);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const backend of ['js', 'wasm']) {
      await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
      const result = await win.webContents.executeJavaScript(`(async () => {
        localStorage.setItem('modsynth.dsp', '${backend}');
        const { Engine } = await import('/src/engine.js');
        const { AudioTransport } = await import('/src/audiotransport.js');
        const { addClip, addAutoClip } = await import('/src/song.js');
        const { playbackModel } = await import('/src/playbackmodel.js');
        const engine = new Engine();
        await engine.init();
        const errors = [], scopes = [];
        engine.dsp.onError = error => errors.push(error);
        const receive = engine.dsp.receive.bind(engine.dsp);
        engine.dsp.receive = report => {
          if (report.scope && report.playback?.playing) {
            let peak = 0;
            for (const v of report.scope.v) peak = Math.max(peak, Math.abs(v));
            scopes.push({ pos: report.playback.pos, peak });
          }
          receive(report);
        };
        const folder = await engine.root.addModule('PATCH');
        const inner = folder.inst.patch;
        const strum = await inner.addModule('STRUM');
        const osc = await inner.addModule('OSC');
        inner.connect(strum.id, osc.id);
        inner.connect(osc.id, 0);
        engine.root.connect(folder.id, 0);
        engine.root.setParam(folder.id, 'instances', 2);
        engine.root.setState(folder.id, {
          maps: [{ key: 'map1', module: osc.id, param: 'gain', label: 'Gain' }],
        });
        const clip = addClip(engine.song, { length: 4, target: folder.id });
        clip.notes.push({ start: .1, pitch: 60, vel: .8, length: .1 });
        const auto = addAutoClip(engine.song, { length: 4, target: folder.id, controller: 11, y: 34 });
        auto.points.push({ t: 0, v: .4, r: 0 }, { t: 4, v: .4, r: 0 });
        // A large project, but no other voices during the measured note.
        for (let lane = 0; lane < 32; lane++) {
          const future = addClip(engine.song, { start: 100 + lane * 4, length: 4, target: folder.id, y: 68 + lane * 34 });
          for (let i = 0; i < 1000; i++) future.notes.push({ start: i / 250, pitch: 48 + i % 36, vel: .8, length: .01 });
        }
        const tr = new AudioTransport({
          getScope: () => [], getSong: () => engine.song, getBpm: () => 120, getTarget: () => null,
        }, { dsp: engine.dsp, sync: () => engine.syncSong(), audioTime: () => engine.ctx.currentTime, onError: e => errors.push(String(e)) });
        engine.transport = tr;
        engine.dsp.onPlayback = state => {
          tr.receive(state);
          for (let i = 0; i < state.mods.length; i += 3) {
            engine.dsp.nodes.get(state.mods[i])?.onPlayback?.(state.mods[i + 1], state.mods[i + 2]);
          }
        };
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        try {
          engine.dsp.scope([osc.inst.node.h]);
          await engine.ctx.resume();
          tr.play();
          const timeout = performance.now() + 15000;
          while (tr.pos < .03 && !errors.length && performance.now() < timeout) await wait(1);
          const before = tr.pos;
          const start = performance.now();
          while (performance.now() - start < 200) {}
          await wait(50);
          const after = tr.pos;
          const timing = {
            errors: [...errors], before, after,
            sounding: scopes.filter(s => s.pos >= .13 && s.pos <= .2),
            released: scopes.filter(s => s.pos >= .28 && s.pos <= .38),
          };
          const invalid = structuredClone(playbackModel(engine.root));
          const binding = invalid.bindings.find(b => b.modules.some(m => m.type === 'OSC'));
          binding.modules.find(m => m.type === 'OSC').nodes[0].h = 999999;
          engine.dsp.post(['playback', 'model', invalid]);
          const failedAt = performance.now() + 5000;
          while ((!errors.length || tr.playing) && performance.now() < failedAt) await wait(5);
          const failedSafely = !tr.playing && errors.length === 1 && errors[0].includes('Playback DSP binding mismatch');
          await engine.syncSong();
          errors.length = 0;
          tr.seek(0);
          tr.play();
          const recoveredAt = performance.now() + 5000;
          while (tr.pos < .1 && !errors.length && performance.now() < recoveredAt) await wait(5);
          const recovered = tr.playing && tr.pos >= .1 && errors.length === 0;
          tr.stop();
          await wait(50);
          return {
            backend: engine.dspInfo?.dsp, ...timing, playing: tr.playing, failedSafely, recovered,
          };
        } finally { await engine.ctx.close(); }
      })()`);
      assert.deepEqual(result.errors, [], `${backend}: worklet has no errors`);
      assert.equal(result.backend, backend, 'test uses the requested DSP backend');
      assert.ok(result.before >= 0.03 && result.before < 0.1, 'UI stalls before the note starts');
      assert.ok(result.after > result.before + 0.4, 'audio playhead advances during the 200 ms UI stall');
      assert.ok(result.sounding.some(s => s.peak > 0.001), 'note onset sounds while the UI is blocked');
      assert.ok(result.released.length >= 2 && result.released.every(s => s.peak < 1e-8),
        'note release completes on the audio thread, before the blocked UI returns');
      assert.equal(result.playing, false);
      assert.equal(result.failedSafely, true, 'worklet synchronization errors are reported and stop playback');
      assert.equal(result.recovered, true, 'a valid model restores playback after a synchronization error');
      console.log(`${backend}: 32,001-note project, onset/release verified during a 200 ms UI stall`);
    }
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally { server.close(); }
});
