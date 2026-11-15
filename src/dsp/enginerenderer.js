import { Graph } from './graph.js';
import { instantiateDsp, wasmKernels } from './wasm.js';
import { LoadMeter } from './loadmeter.js';
import { Playback } from './playback.js';
import { InstancePool } from './instancepool.js';
import { useAudioNoteIds } from '../modmidi.js';

const REPORT_BLOCKS = 2;
const SCOPE_BLOCKS = Math.max(REPORT_BLOCKS, Math.round(sampleRate / 128 / 60 / REPORT_BLOCKS) * REPORT_BLOCKS);
const ANALYSIS_BLOCKS = Math.max(REPORT_BLOCKS, Math.round(sampleRate / 128 / 20 / REPORT_BLOCKS) * REPORT_BLOCKS);

export class EngineRenderer {
  constructor(port, { wasm } = {}) {
    this.port = port;
    this.time = 0;
    let info = { dsp: 'js' };
    if (wasm) {
      try {
        this.graph = new Graph(wasmKernels(instantiateDsp(wasm), sampleRate));
        info = { dsp: 'wasm' };
      } catch (err) { info = { dsp: 'js', error: String(err?.message ?? err) }; }
    }
    this.graph ??= new Graph();
    useAudioNoteIds();
    this.playback = new Playback(this.graph, () => this.time);
    this.playback.onError = error => this.fail(error);
    this.controlQueue = Promise.resolve();
    this.port.postMessage({ info });
    this.blocks = 0;
    this.scopeBlocks = 0;
    this.analysisBlocks = 0;
    this.load = new LoadMeter(128 / sampleRate * 1000);
    this.port.onmessage = e => {
      this.controlQueue = this.controlQueue.then(async () => {
        for (const op of e.data) {
          if (op[0] === 'panic' || (op[0] === 'playback' && op[1] === 'command' && ['panic', 'seek', 'start'].includes(op[2].type))) this.onReset?.();
          if (op[0] === 'playback') {
            const [, type, data] = op;
            if (type === 'model') await this.playback.model(data);
            else if (type === 'song') this.playback.setSong(data);
            else this.playback.command(data);
          } else if (op[0] === 'pool') this.graph.setPool(new InstancePool(op[1], { budget: op[1].budget ?? null }));
          else this.graph.op(op);
        }
      }).catch(err => this.fail(err));
    };
    this.port.start?.();
  }

  fail(error) {
    this.playback.failed = true;
    this.onReset?.();
    try { this.playback.command({ type: 'panic' }); }
    catch (cleanup) {
      this.graph.panic();
      this.playback.transport.playing = false;
      this.port.postMessage({ error: `Playback cleanup: ${cleanup?.stack ?? cleanup}` });
    }
    this.port.postMessage({ error: `DSP/playback: ${error?.stack ?? error}` });
  }

  process(inputs, outputs, time) {
    this.time = time;
    const out = outputs[0];
    this.graph.ext = inputs;
    try {
      const t0 = Date.now();
      this.playback.process();
      this.graph.render(out[0], out[1] ?? out[0]);
      this.playback.renderCountIn(out[0], out[1] ?? out[0], sampleRate);
      const cpu = this.load.add(t0, Date.now());
      if (cpu) this.port.postMessage({ cpu });
      this.failed = false;
    } catch (err) {
      for (const ch of out) ch.fill(0);
      if (!this.failed) this.fail(err);
      this.failed = true;
    }
    if (++this.blocks >= REPORT_BLOCKS) {
      this.scopeBlocks += this.blocks;
      this.analysisBlocks += this.blocks;
      this.blocks = 0;
      const withScope = this.scopeBlocks >= SCOPE_BLOCKS;
      if (withScope) this.scopeBlocks = 0;
      const report = this.graph.report(time, withScope) ?? { time, mods: [] };
      try { this.playback.receive(report.mods); }
      catch (error) { this.fail(error); }
      report.playback = this.playback.report();
      const transfers = report.scope ? [report.scope.v.buffer] : [];
      if (this.analysisBlocks >= ANALYSIS_BLOCKS) {
        this.analysisBlocks = 0;
        const analysis = this.graph.analysis?.report();
        if (analysis) {
          report.analysis = analysis;
          transfers.push(analysis.samples.buffer);
        }
      }
      this.port.postMessage(report, transfers);
    }
    return true;
  }
}