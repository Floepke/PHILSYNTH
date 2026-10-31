import { PatchRuntime } from './patch.js';
import { DspHost } from './dsp/host.js';
import { emptySong, normalizeSong } from './song.js';
import { importSamples } from './samples.js';

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

export class Engine {
  constructor() {
    this.ctx = null;
    this.root = null;
    this.dsp = null; // DspHost: all module DSP runs in one AudioWorklet (engine.worklet.js)
    this.onCpu = null;
    this.song = emptySong(); // clips + notes of the TimeLine (song.js)
    this.dspInfo = null; // { dsp: 'wasm' | 'js', error? } reported by the engine worklet
  }

  // Creates the context (suspended until the first user gesture), the engine worklet that runs
  // the DSP of every module (src/dsp/graph.js) and the main patch.
  async init() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./engine.worklet.js', import.meta.url));
    const wasm = await loadWasm();
    this.wasm = wasm; // kept for offline renders (src/render.js)
    this.node = new AudioWorkletNode(this.ctx, 'modsynth-engine', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { wasm },
    });
    this.node.connect(this.ctx.destination);
    this.dsp = new DspHost(this.node.port);
    this.dsp.onError = (err) => console.error('DSP engine:', err);
    this.dsp.onInfo = (info) => {
      this.dspInfo = info;
      if (info.error) console.warn('C++ DSP unavailable, using the JavaScript kernels:', info.error);
    };
    this.root = await PatchRuntime.create(this, this.dsp.destination);
    await this.startCpuProbe();
  }

  // Calls `onCpu({load, q})` about once per second while audio runs (load is 0..1 or null).
  async startCpuProbe() {
    try {
      await this.ctx.audioWorklet.addModule(new URL('./cpu.worklet.js', import.meta.url));
      const probe = new AudioWorkletNode(this.ctx, 'cpu-probe', { numberOfInputs: 0, outputChannelCount: [1] });
      probe.connect(this.ctx.destination); // outputs silence; connected so it is always rendered
      probe.port.onmessage = (e) => this.onCpu?.(e.data);
    } catch (err) {
      console.warn('CPU meter unavailable:', err);
    }
  }

  // MIDI/audio panic: every module releases its notes and drops pending (delayed) MIDI, then all
  // DSP state (voices, echo lines, reverb tails, filter memory) is cleared on the audio thread.
  panic() {
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
    return { format: 'modsynth', version: 1, patch: this.root.toJSON(), song: this.song };
  }

  async loadProject(data) {
    if (data?.format !== 'modsynth' || !Array.isArray(data.patch?.modules)) throw new Error('Not a modsynth project file');
    importSamples(data.samples); // audio of SAMPLER / WAVETABLE modules (see src/samples.js)
    await this.root.load(data.patch);
    this.song = normalizeSong(data.song);
  }
}
