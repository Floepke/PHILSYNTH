// The one AudioWorklet of the app: runs the whole module graph (src/dsp/graph.js).
// Messages from the main thread (src/dsp/host.js) arrive between render quanta; every
// REPORT_BLOCKS quanta the changed modulation values (and the audio time, for MULTIMIDI
// drift) go back to the main thread. The cable scope waveforms only go along about SCOPE_HZ
// times per second (display rate), to keep the audio thread's message traffic low.
// processorOptions.wasm: the bytes of src/dsp/modsynth.wasm (C++ kernels, src/dsp/wasm.js). Without
// them, or if they fail to load, the JS kernels run. The choice is posted back as { info }.
import { Graph } from './dsp/graph.js';
import { instantiateDsp, wasmKernels } from './dsp/wasm.js';
import { LoadMeter } from './dsp/loadmeter.js';
import { Playback } from './dsp/playback.js';
import { useAudioNoteIds } from './modmidi.js';

const REPORT_BLOCKS = 2; // ~5 ms at 48 kHz
const SCOPE_HZ = 60;
const SCOPE_BLOCKS = Math.max(REPORT_BLOCKS, Math.round(sampleRate / 128 / SCOPE_HZ / REPORT_BLOCKS) * REPORT_BLOCKS);

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const bytes = options?.processorOptions?.wasm;
    let info = { dsp: 'js' };
    if (bytes) {
      try {
        this.graph = new Graph(wasmKernels(instantiateDsp(bytes), sampleRate));
        info = { dsp: 'wasm' };
      } catch (err) {
        info = { dsp: 'js', error: String(err?.message ?? err) };
      }
    }
    this.graph ??= new Graph();
    useAudioNoteIds();
    this.playback = new Playback(this.graph, () => currentTime);
    this.playback.onError = (error) => this.fail(error);
    this.controlQueue = Promise.resolve();
    this.port.postMessage({ info });
    this.blocks = 0;
    this.scopeBlocks = 0;
    this.load = new LoadMeter((128 / sampleRate) * 1000);
    this.port.onmessage = (e) => {
      this.controlQueue = this.controlQueue.then(async () => {
        for (const op of e.data) {
          if (op[0] === 'playback') {
            const [, type, data] = op;
            if (type === 'model') await this.playback.model(data);
            else if (type === 'song') this.playback.setSong(data);
            else this.playback.command(data);
          } else this.graph.op(op);
        }
      }).catch((err) => {
        this.fail(err);
      });
    };
  }

  fail(error) {
    this.playback.failed = true;
    try { this.playback.command({ type: 'panic' }); }
    catch (cleanup) {
      this.graph.panic();
      this.playback.transport.playing = false;
      this.port.postMessage({ error: `Playback cleanup: ${cleanup?.stack ?? cleanup}` });
    }
    this.port.postMessage({ error: `DSP/playback: ${error?.stack ?? error}` });
  }

  process(inputs, outputs) {
    const out = outputs[0];
    this.graph.ext = inputs; // microphones (src/mics.js), read by the INPUT kernels
    try {
      const t0 = Date.now();
      this.playback.process();
      this.graph.render(out[0], out[1] ?? out[0]);
      this.playback.renderCountIn(out[0], out[1] ?? out[0], sampleRate);
      const cpu = this.load.add(t0, Date.now());
      if (cpu) this.port.postMessage({ cpu });
      this.failed = false;
    } catch (err) {
      // keep the worklet alive (a dead process() would silence everything for good)
      for (const ch of out) ch.fill(0);
      if (!this.failed) this.fail(err);
      this.failed = true;
    }
    if (++this.blocks >= REPORT_BLOCKS) {
      this.scopeBlocks += this.blocks;
      this.blocks = 0;
      const withScope = this.scopeBlocks >= SCOPE_BLOCKS;
      if (withScope) this.scopeBlocks = 0;
      const r = this.graph.report(currentTime, withScope);
      try { this.playback.receive(r?.mods); }
      catch (error) { this.fail(error); }
      const report = r ?? { time: currentTime, mods: [] };
      report.playback = this.playback.report();
      this.port.postMessage(report, report.scope ? [report.scope.v.buffer] : []);
    }
    return true;
  }
}

registerProcessor('modsynth-engine', EngineProcessor);
