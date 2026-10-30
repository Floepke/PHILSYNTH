// The one AudioWorklet of the app: runs the whole module graph (src/dsp/graph.js).
// Messages from the main thread (src/dsp/host.js) arrive between render quanta; every
// REPORT_BLOCKS quanta the changed modulation values (and the audio time, for MULTIMIDI
// drift) go back to the main thread.
// processorOptions.wasm: the bytes of src/dsp/modsynth.wasm (C++ kernels, src/dsp/wasm.js). Without
// them, or if they fail to load, the JS kernels run. The choice is posted back as { info }.
import { Graph } from './dsp/graph.js';
import { instantiateDsp, wasmKernels } from './dsp/wasm.js';

const REPORT_BLOCKS = 2; // ~5 ms at 48 kHz

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
    this.port.postMessage({ info });
    this.blocks = 0;
    this.port.onmessage = (e) => {
      try {
        this.graph.handle(e.data);
      } catch (err) {
        this.port.postMessage({ error: String(err?.stack ?? err) });
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    try {
      this.graph.render(out[0], out[1] ?? out[0]);
      this.failed = false;
    } catch (err) {
      // keep the worklet alive (a dead process() would silence everything for good)
      for (const ch of out) ch.fill(0);
      if (!this.failed) this.port.postMessage({ error: String(err?.stack ?? err) });
      this.failed = true;
    }
    if (++this.blocks >= REPORT_BLOCKS) {
      this.blocks = 0;
      const r = this.graph.report(currentTime);
      if (r) this.port.postMessage(r);
    }
    return true;
  }
}

registerProcessor('modsynth-engine', EngineProcessor);
