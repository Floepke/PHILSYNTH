import { PatchRuntime } from './patch.js';
import { DspHost } from './dsp/host.js';
import { emptySong, normalizeSong } from './song.js';
import { importSamples } from './samples.js';
import { MicHub, MIC_SLOTS } from './mics.js';
import { PROJECT_FORMAT, isProject } from './fileformat.js';
import { playbackModel, playbackSong, preparePlayback } from './playbackmodel.js';
import { POOL_BYTES, poolSize } from './dsp/instancepool.js';

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

// Workers that render the extra instances of PATCH modules (src/dsp/instancepool.js). They need
// SharedArrayBuffer, so a cross-origin isolated page (server.mjs sends COOP/COEP, on static hosts
// such as GitHub Pages the service worker coi-sw.js adds them); elsewhere everything renders on
// the audio thread.
// `?workers=0` or localStorage['modsynth.workers'] = '0' turns them off.
function startPool(port, wasm, sampleRate, onError) {
  let n = poolSize();
  try {
    const forced = new URLSearchParams(location.search).get('workers') ?? localStorage.getItem('modsynth.workers');
    if (forced !== null && forced !== '') n = Math.min(n, Math.max(0, Math.floor(+forced) || 0));
  } catch { /* no location/localStorage */ }
  if (!n || !globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return [];
  const workers = [];
  const sabs = [];
  const ports = [];
  for (let i = 0; i < n; i++) {
    const sab = new SharedArrayBuffer(POOL_BYTES);
    const ch = new MessageChannel();
    const w = new Worker(new URL('./dsp/instanceworker.js', import.meta.url), { type: 'module', name: `PATCH instances ${i + 1}` });
    w.onmessage = (e) => {
      if (e.data?.error) onError(e.data.error);
      else if (e.data?.warn) console.warn(e.data.warn);
    };
    w.onerror = (e) => onError(e.message ?? String(e));
    w.postMessage({ sab, port: ch.port2, wasm, sampleRate }, [ch.port2]);
    workers.push(w);
    sabs.push(sab);
    ports.push(ch.port1);
  }
  // before any node is created: the worklet's graph needs the pool for them
  port.postMessage([['pool', { sabs, ports }]], ports);
  return workers;
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
  async init() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./engine.worklet.js', import.meta.url));
    const wasm = await loadWasm();
    this.wasm = wasm; // kept for offline renders (src/render.js)
    this.node = new AudioWorkletNode(this.ctx, 'modsynth-engine', {
      // inputs: microphone slots of the INPUT modules (src/mics.js)
      numberOfInputs: MIC_SLOTS, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { wasm },
    });
    this.node.connect(this.ctx.destination);
    this.workers = startPool(this.node.port, wasm, this.ctx.sampleRate, (err) => this.reportError(`PATCH instance worker: ${err}`));
    this.mics = new MicHub(this.ctx, this.node);
    this.dsp = new DspHost(this.node.port);
    this.dsp.remoteNotes = true; // autonomous CTL2NOTE runs on the audio thread, even when stopped
    this.dsp.onError = (err) => this.reportError(err);
    this.dsp.onInfo = (info) => {
      this.dspInfo = info;
      if (info.error) console.warn('C++ DSP unavailable, using the JavaScript kernels:', info.error);
    };
    // `onCpu({load})` about once per second of audio, load 0..1 (src/dsp/loadmeter.js)
    this.dsp.onCpu = (cpu) => this.onCpu?.(cpu);
    this.root = await PatchRuntime.create(this, this.dsp.destination);
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
