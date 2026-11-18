import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectArchive } from '../src/projectarchive.js';
import { importSamples, withSamples } from '../src/samples.js';

const root = fileURLToPath(new URL('../', import.meta.url));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
const { data, version } = await readProjectArchive(await readFile(path.resolve(process.argv[2] ?? 'HornSound.phproject')));
let project = data;
if (version === 2) {
  const { samples, ...model } = data;
  importSamples(samples);
  project = withSamples(model); // the benchmark injects the model into the renderer as JSON
}
const seconds = Number(process.env.BENCH_SECONDS ?? 15);
const skipRealtime = process.env.BENCH_SKIP_REALTIME === '1';
const nodeWorkers = process.env.BENCH_NODE_WORKERS !== '0';
const workerCounts = (process.env.BENCH_WORKERS ?? '0,1,2,0').split(',').map(value => value === 'auto' ? value : Number(value));
const latencyHint = process.env.BENCH_LATENCY_MS ? Number(process.env.BENCH_LATENCY_MS) / 1000 : 'interactive';
const buffered = process.env.BENCH_BUFFERED === '1';
const stallMs = Number(process.env.BENCH_STALL_MS ?? 0);
process.env.MODSYNTH_REALTIME = path.join(root, 'electron/realtime.cjs');
const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Project audio benchmark</title>');
      return;
    }
    const filename = path.resolve(root, '.' + pathname);
    if (!filename.startsWith(root)) throw new Error('Invalid path');
    let body = await readFile(filename);
    if (pathname === '/src/engine.js') {
      body = body.toString().replace('new SharedArrayBuffer(POOL_BYTES)', 'new SharedArrayBuffer(POOL_BYTES + 64)');
    }
    if (pathname === '/src/dsp/instanceworker.js' && skipRealtime) {
      body = body.toString().replace("if (typeof require === 'function'", "if (false && typeof require === 'function'");
    }
    if (pathname === '/src/dsp/instancepool.js') {
      body = body.toString()
        .replace('ctrl: new Int32Array(sab, 0, CTRL),', 'diag: new Float64Array(sab, POOL_BYTES, 8), ctrl: new Int32Array(sab, 0, CTRL),')
        .replace('Atomics.store(this.ctrl, KICK, block);', 'this.diag[0] = Date.now(); Atomics.store(this.ctrl, KICK, block);')
        .replace('this.render(block);', `
          const wakeMs = Math.max(0, Date.now() - this.diag[0]);
          const started = performance.now();
          this.render(block);
          const renderMs = performance.now() - started;
          this.diag[1] += wakeMs;
          this.diag[2] += renderMs;
          this.diag[3]++;
          this.diag[4] = Math.max(this.diag[4], wakeMs);
          this.diag[5] = Math.max(this.diag[5], renderMs);`);
    }
    if (pathname === '/src/dsp/renderworker.js' && stallMs) {
      body = body.toString().replace('let block = 0;', 'let block = 0, stalled = false;')
        .replace('await renderer.controlQueue;', `await renderer.controlQueue;
          if (block >= 3000 && !stalled) {
            stalled = true;
            Atomics.wait(queue.ctrl, 7, 0, ${stallMs});
            port.postMessage({ testStall: ${stallMs} });
          }`);
    }
    if (pathname === '/src/engine.worklet.js') {
      body = body.toString().replace('this.queue.consume(this.block, outputs[0]);', `this.queue.consume(this.block, outputs[0]);
        for (const channel of outputs[0]) for (const value of channel) this.peak = Math.max(this.peak ?? 0, Math.abs(value));`)
        .replace('latency: this.queue.delay', 'peak: this.peak ?? 0, latency: this.queue.delay');
    }
    if (pathname === '/src/dsp/enginerenderer.js') {
      body = body.toString().replace('this.blocks = 0;', 'this.bench = { blocks: 0, lateBlocks: 0, lateWorkers: 0, overruns: 0, ms: 0, maxMs: 0 }; this.blocks = 0;')
        .replace('const cpu = this.load.add(t0, Date.now());', `
          const elapsed = Date.now() - t0;
          const late = this.graph.pool?.links.filter(link => link.late || link.lag).length ?? 0;
          this.bench.blocks++;
          this.bench.lateBlocks += late > 0 ? 1 : 0;
          this.bench.lateWorkers += late;
          this.bench.overruns += elapsed > 128 / sampleRate * 1000 ? 1 : 0;
          this.bench.ms += elapsed;
          this.bench.maxMs = Math.max(this.bench.maxMs, elapsed);
          const cpu = this.load.add(t0, Date.now());`)
        .replace('this.port.postMessage({ cpu });', 'this.port.postMessage({ cpu, bench: { ...this.bench }, workers: this.graph.pool?.links.map(link => Array.from(link.diag)) ?? [] });');
    }
    res.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    res.end(body);
  } catch (error) {
    res.writeHead(404);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, nodeIntegrationInWorker: nodeWorkers, contextIsolation: true, sandbox: false, backgroundThrottling: false } });
win.webContents.on('console-message', event => {
  if (event.message.includes('priority') || event.message.includes('PATCH workers disabled') || event.level === 'error') console.error(event.message);
});
try {
  for (const workers of workerCounts) {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/${workers === 'auto' ? '' : `?workers=${workers}`}`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      globalThis.modsynthFiles = {};
      localStorage.removeItem('modsynth.workers');
      const { Engine } = await import('/src/engine.js');
      const engine = new Engine();
      const errors = [];
      engine.onError = error => errors.push(String(error));
      await engine.init({ latencyHint: ${JSON.stringify(latencyHint)}, buffered: ${buffered} });
      let bench = null, cpu = null, playback = null, workerStats = [], testStall = 0;
      const receive = engine.dsp.receive.bind(engine.dsp);
      engine.dsp.receive = report => {
        if (report.bench) { bench = report.bench; cpu = report.cpu; }
        if (report.workers) workerStats = report.workers;
        if (report.playback) playback = report.playback;
        if (report.testStall) testStall = report.testStall;
        receive(report);
      };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        await engine.loadProject(${JSON.stringify(project)});
        await wait(2000);
        await engine.ctx.resume();
        engine.dsp.post(['playback', 'command', { type: 'start', pos: 0, scope: [], clipId: null, chase: true, fromStart: true }]);
        await wait(3000);
        const before = bench && { ...bench };
        const workersBefore = workerStats.map(stats => [...stats]);
        const bufferingBefore = engine.buffering && { ...engine.buffering };
        await wait(${seconds * 1000});
        const measured = before && bench ? Object.fromEntries(Object.keys(bench).filter(key => key !== 'maxMs').map(key => [key, bench[key] - before[key]])) : null;
        const workerTiming = workerStats.map((stats, index) => {
          const previous = workersBefore[index];
          const blocks = stats[3] - previous[3];
          return { blocks, averageWakeMs: blocks ? (stats[1] - previous[1]) / blocks : 0,
            averageRenderMs: blocks ? (stats[2] - previous[2]) / blocks : 0,
            maxWakeMs: stats[4], maxRenderMs: stats[5] };
        });
        return { requestedWorkers: ${JSON.stringify(workers)}, workers: engine.workers.length, skipRealtime: ${skipRealtime}, nodeWorkers: ${nodeWorkers}, latencyHint: ${JSON.stringify(latencyHint)},
          buffered: !!engine.renderWorker, testStall, buffering: engine.buffering ? { latency: engine.buffering.latency, peak: engine.buffering.peak, maxPending: engine.buffering.maxPending,
            underruns: engine.buffering.underruns - (bufferingBefore?.underruns ?? 0),
            lostInputs: engine.buffering.lostInputs - (bufferingBefore?.lostInputs ?? 0) } : null,
          workerTiming, cores: navigator.hardwareConcurrency, sampleRate: engine.ctx.sampleRate,
          baseLatency: engine.ctx.baseLatency, backend: engine.dspInfo, cpu, measured, maxMs: bench?.maxMs,
          playback: { playing: playback?.playing, pos: playback?.pos }, errors };
      } finally {
        await engine.ctx.close();
        for (const worker of engine.workers) worker.terminate();
      }
    })()`);
    if (result.measured) {
      result.latePercent = 100 * result.measured.lateBlocks / result.measured.blocks;
      result.averageLoad = result.measured.ms / (result.measured.blocks * 128 / result.sampleRate * 1000);
    }
    console.log(JSON.stringify(result));
    if (result.errors.length || !result.measured?.blocks || !(result.playback?.pos > 0) || !result.backend?.dsp) throw new Error('Benchmark did not complete cleanly');
    if (process.env.BENCH_EXPECT_WORKERS !== undefined && result.workers !== Number(process.env.BENCH_EXPECT_WORKERS)) throw new Error('Unexpected worker count');
    if (buffered && !result.buffered) throw new Error('Buffered renderer did not start');
    if (buffered && !(result.buffering?.peak > 0.0001)) throw new Error('Buffered output is silent');
    if (stallMs && result.testStall !== stallMs) throw new Error('Controlled worker stall did not run');
    if (process.env.BENCH_EXPECT_UNDERRUNS !== undefined && result.buffering?.underruns !== Number(process.env.BENCH_EXPECT_UNDERRUNS)) throw new Error('Unexpected queue underruns');
  }
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
} finally {
  win.destroy();
  server.close();
}
}).catch(error => {
  console.error(error);
  app.exit(1);
});