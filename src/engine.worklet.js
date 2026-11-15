import { EngineRenderer } from './dsp/enginerenderer.js';
import { RenderQueue } from './dsp/renderqueue.js';

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options?.processorOptions;
    if (settings?.queue) {
      this.queue = new RenderQueue(settings.queue);
      this.block = 0;
    } else this.renderer = new EngineRenderer(this.port, settings);
  }

  process(inputs, outputs) {
    if (this.renderer) return this.renderer.process(inputs, outputs, currentTime);
    if (!this.block) Atomics.store(this.queue.ctrl, 4, Math.round(currentTime * sampleRate));
    this.queue.capture(++this.block, inputs);
    this.queue.consume(this.block, outputs[0]);
    this.maxPending = Math.max(this.maxPending ?? 0, this.block - Atomics.load(this.queue.ctrl, 5));
    if (!(this.block % Math.round(sampleRate / 128))) {
      this.port.postMessage({ buffering: {
        latency: this.queue.delay * 128 / sampleRate,
        underruns: Atomics.load(this.queue.ctrl, 1),
        lostInputs: Atomics.load(this.queue.ctrl, 2),
        maxPending: this.maxPending,
      } });
    }
    return true;
  }
}

registerProcessor('modsynth-engine', EngineProcessor);
