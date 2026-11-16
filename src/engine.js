import { PatchRuntime } from './patch.js';
import { DspHost } from './dsp/host.js';
import { emptySong, normalizeSong } from './song.js';
import { importSamples } from './samples.js';
import { MicHub, MIC_SLOTS } from './mics.js';
import { PROJECT_FORMAT, isProject } from './fileformat.js';
import { playbackModel, playbackSong, preparePlayback } from './playbackmodel.js';
import { POOL_BYTES, POOL_MAX, poolSize } from './dsp/instancepool.js';
import { createRenderQueue } from './dsp/renderqueue.js';

// The C++ DSP kernels (src/dsp/modsynth.wasm, built from cpp/ by `npm run build:wasm`), compiled in
// the worklet. `?dsp=js` in the URL or localStorage['modsynth.dsp'] = 'js' forces the JS kernels.
async function loadWasm() {
  try {
    const forced = new URLSearchParams(location.search).get('dsp') ?? localStorage.getItem('modsynth.dsp');
    if (forced === 'js') return null;
    const res = await fetch(new URL('./dsp/modsynth.wasm', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } catch (err) {
    console.warn('C++ DSP not loaded, using the JavaScript kernels:', err);
    return null;
  }
}

// Workers that render the extra instances of PATCH modules (src/dsp/instancepool.js). Only the
// desktop app uses them by default only when every worker gets real-time priority
// (electron/realtime.cjs); otherwise instances stay on the engine's render thread.
// Browser workers can't, and the OS wakes them late now and then (a crackle), so in a browser
// everything renders on the audio thread unless workers are asked for.
// They need SharedArrayBuffer, so a cross-origin isolated page (server.mjs sends COOP/COEP, on
// static hosts such as GitHub Pages the service worker coi-sw.js adds them).
// How many: poolSize() from the CPU in the desktop app, else 0; `?workers=N` or
// localStorage['modsynth.workers'] = 'N' overrides it (0 turns them off, at most POOL_MAX).
const desktopApp = () => typeof globalThis.modsynthFiles === 'object' && globalThis.modsynthFiles !== null;

export async function startPool(port, wasm, sampleRate, onError, { timeout = 5000, budget = null, onReport = null } = {}) {
  let n = desktopApp() ? poolSize() : 0;
  let explicit = false;
  try {
    const forced = new URLSearchParams(location.search).get('workers') ?? localStorage.getItem('modsynth.workers');
    if (forced !== null && forced !== '') {
      explicit = true;
      n = Math.min(POOL_MAX, Math.max(0, Math.floor(+forced) || 0));
    }
  } catch { /* no location/localStorage */ }
  if (!n || !globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return [];
  const workers = [];
  const sabs = [];
  const ports = [];
  const channels = [];
  const pending = [];
  const cancel = [];
  let active = false;
  try {
    for (let i = 0; i < n; i++) {
      const sab = new SharedArrayBuffer(POOL_BYTES);
      const ch = new MessageChannel();
      channels.push(ch);
      const w = new Worker(new URL('./dsp/instanceworker.js', import.meta.url), { type: 'module', name: `PATCH instances ${i + 1}` });
      workers.push(w);
      sabs.push(sab);
      ports.push(ch.port1);
      pending.push(new Promise((resolve) => {
        const timer = setTimeout(() => finish({ error: 'Worker startup timed out' }), timeout);
        const finish = (status) => { clearTimeout(timer); resolve(status); };
        cancel.push(() => finish({ error: 'Worker startup cancelled' }));
        w.onmessage = (e) => {
          if (e.data?.ready) finish(e.data);
          else if (e.data?.error) {
            if (active) onError(e.data.error);
            else finish(e.data);
          } else if (e.data?.warn) console.warn(e.data.warn);
          else if (active && e.data?.meters) onReport?.(e.data);
        };
        w.onerror = (e) => {
          const error = e.message ?? String(e);
          if (active) onError(error);
          else finish({ error });
        };
        w.postMessage({ sab, port: ch.port2, wasm, sampleRate, requireRealtime: !explicit, budget }, [ch.port2]);
      }));
    }
    const statuses = await Promise.all(pending);
    const failed = statuses.find((status) => status.error || (!explicit && !status.realtime?.ok));
    if (failed) throw new Error(failed.error ?? failed.realtime?.error ?? 'Real-time priority unavailable');
    port.postMessage([['pool', { sabs, ports, budget }]], ports);
    active = true;
    return workers;
  } catch (error) {
    for (const finish of cancel) finish();
    for (const w of workers) {
      w.onmessage = w.onerror = null;
      w.terminate();
    }
    for (const ch of channels) { ch.port1.close(); ch.port2.close(); }
    console.warn(`PATCH workers disabled; rendering instances on the engine thread: ${error.message}`);
    return [];
  }
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.root = null;
    this.dsp = null; // DspHost: all module DSP runs in one AudioWorklet (engine.worklet.js)
    this.onCpu = null;
    this.song = emptySong(); // clips + notes of the TimeLine (song.js)
    this.dspInfo = null; // { dsp: 'wasm' | 'js', error? } reported by the engine worklet
    this.mics = null; // MicHub (src/mics.js); none in offline renders
  }

  // Creates the context (suspended until the first user gesture), the engine worklet that runs
  // the DSP of every module (src/dsp/graph.js) and the main patch.
  async init({ latencyHint = 'interactive', buffered = desktopApp() } = {}) {
    this.ctx = new AudioContext({ latencyHint });
    await this.ctx.audioWorklet.addModule(new URL('./engine.worklet.js', import.meta.url));
    const wasm = await loadWasm();
    this.wasm = wasm; // kept for offline renders (src/render.js)
    const headroomMs = typeof latencyHint === 'number' ? Math.max(20, latencyHint * 1000) : 20;
    const burstMs = Math.max(512 / this.ctx.sampleRate * 1000, (this.ctx.baseLatency ?? 0) * 1000);
    const queue = buffered && globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function'
      ? createRenderQueue(this.ctx.sampleRate, headroomMs + burstMs, MIC_SLOTS) : null;
    const channel = queue ? new MessageChannel() : null;
    this.node = new AudioWorkletNode(this.ctx, 'modsynth-engine', {
      // inputs: microphone slots of the INPUT modules (src/mics.js)
      numberOfInputs: MIC_SLOTS, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { wasm, queue },
    });
    this.dsp = new DspHost(channel?.port1 ?? this.node.port);
    this.dsp.remoteNotes = true; // autonomous CTL2NOTE runs on the audio thread, even when stopped
    this.dsp.onError = (err) => this.reportError(err);
    this.dsp.onInfo = (info) => {
      this.dspInfo = info;
      if (info.error) console.warn('C++ DSP unavailable, using the JavaScript kernels:', info.error);
    };
    // `onCpu({load})` about once per second of audio, load 0..1 (src/dsp/loadmeter.js)
    this.dsp.onCpu = (cpu) => this.onCpu?.(cpu);
    if (queue) {
      this.node.port.onmessage = e => { if (e.data?.buffering) this.buffering = e.data.buffering; };
      try {
        this.renderWorker = new Worker(new URL('./dsp/renderworker.js', import.meta.url), { type: 'module', name: 'Buffered audio engine' });
        await new Promise((resolve, reject) => {
          let starting = true;
          const timer = setTimeout(() => reject(new Error('Buffered renderer startup timed out')), 5000);
          const fail = error => {
            clearTimeout(timer);
            if (starting) reject(new Error(error));
            else this.reportError(error);
          };
          this.renderWorker.onmessage = e => {
            if (e.data?.ready) { clearTimeout(timer); starting = false; resolve(); }
            else if (e.data?.error) fail(e.data.error);
          };
          this.renderWorker.onerror = e => fail(e.message ?? String(e));
          this.renderWorker.postMessage({ queue, wasm, sampleRate: this.ctx.sampleRate, port: channel.port2 }, [channel.port2]);
        });
      } catch (error) {
        this.renderWorker?.terminate();
        this.renderWorker = null;
        channel.port1.close(); channel.port2.close();
        await this.ctx.close();
        console.warn(`Buffered rendering unavailable; using the audio thread: ${error.message}`);
        return this.init({ latencyHint, buffered: false });
      }
      this.ctx.addEventListener('statechange', () => {
        if (this.ctx.state !== 'closed') return;
        Atomics.store(new Int32Array(queue.sab, 0, 8), 3, 1);
        this.renderWorker.terminate();
        channel.port1.close();
        for (const worker of this.workers ?? []) worker.terminate();
      });
    }
    this.mics = new MicHub(this.ctx, this.node);
    this.workers = await startPool(this.dsp.port, wasm, this.ctx.sampleRate, (err) => this.reportError(`PATCH instance worker: ${err}`), {
      budget: queue ? headroomMs * 0.7 : null,
      onReport: (report) => this.dsp.receive(report),
    });
    this.root = await PatchRuntime.create(this, this.dsp.destination);
    this.node.connect(this.ctx.destination);
  }

  reportError(error) {
    console.error('DSP engine:', error);
    this.transport?.stop();
    this.onError?.(error);
  }

  syncPlayback() {
    if (!this.root || this.loadingProject) return Promise.resolve();
    this.playbackDirty = true;
    if (this.playbackSync) return this.playbackSync;
    this.playbackSync = Promise.resolve().then(async () => {
      while (this.playbackDirty) {
        this.playbackDirty = false;
        await preparePlayback(this.root);
        this.dsp.post(['playback', 'model', playbackModel(this.root)]);
      }
    }).catch((error) => {
      this.reportError(`Playback synchronization failed: ${error.message}`);
      throw error;
    }).finally(() => { this.playbackSync = null; });
    // Model edits are fire-and-forget; explicit play callers also receive the rejection.
    this.playbackSync.catch(() => {});
    return this.playbackSync;
  }

  syncSong() {
    this.dsp.post(['playback', 'song', playbackSong(this.song)]);
    return this.syncPlayback();
  }

  // MIDI/audio panic: every module releases its notes and drops pending (delayed) MIDI, then all
  // DSP state (voices, echo lines, reverb tails, filter memory) is cleared on the audio thread.
  panic() {
    this.transport?.stop();
    this.dsp?.post(['playback', 'command', { type: 'panic' }]);
    this.midiCables?.clear();
    for (const e of this.root?.modules.values() ?? []) {
      try { e.inst.allOff?.(); } catch (err) { console.error('panic:', err); }
    }
    this.dsp?.panic();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }

  // Used by the Patch module to build its inner project.
  createPatch(sink) { return PatchRuntime.create(this, sink); }

  saveProject() {
    return { format: PROJECT_FORMAT, version: 1, patch: this.root.toJSON(), song: this.song };
  }

  async loadProject(data) {
    if (!isProject(data) || !Array.isArray(data.patch?.modules)) throw new Error('Not a PHILSYNTH project file');
    this.root.validateInstanceTree(data.patch);
    this.loadingProject = true;
    try {
      importSamples(data.samples); // audio of SAMPLER / WAVETABLE modules (see src/samples.js)
      await this.root.load(data.patch);
      this.song = normalizeSong(data.song);
    } finally { this.loadingProject = false; }
    await this.syncSong();
  }
}
