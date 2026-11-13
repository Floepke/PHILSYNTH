// node:worker_threads twin of src/dsp/instanceworker.js (test/instancepool.test.mjs)
import { parentPort } from 'node:worker_threads';

parentPort.once('message', async ({ sab, port, wasm, sampleRate, budget }) => {
  globalThis.sampleRate = sampleRate;
  const { Graph } = await import('../src/dsp/graph.js');
  const { instantiateDsp, wasmKernels } = await import('../src/dsp/wasm.js');
  const { PoolWorker } = await import('../src/dsp/instancepool.js');
  const graph = wasm ? new Graph(wasmKernels(instantiateDsp(wasm), sampleRate)) : new Graph();
  const w = new PoolWorker({ sab, port, graph, budget, onError: (err) => parentPort.postMessage({ error: String(err?.stack ?? err) }) });
  w.run();
});
