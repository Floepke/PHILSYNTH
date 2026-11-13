// A worker rendering PATCH instances (src/dsp/instancepool.js, started by src/engine.js).
// init message: { sab, port, wasm: bytes of src/dsp/modsynth.wasm or null, sampleRate }
self.onmessage = async (e) => {
  self.onmessage = null;
  const { sab, port, wasm, sampleRate } = e.data;
  globalThis.sampleRate = sampleRate; // the kernels read it like in an AudioWorkletGlobalScope
  const [{ Graph }, { instantiateDsp, wasmKernels }, { PoolWorker }] = await Promise.all([
    import('./graph.js'), import('./wasm.js'), import('./instancepool.js'),
  ]);
  let graph = null;
  if (wasm) {
    try { graph = new Graph(wasmKernels(instantiateDsp(wasm), sampleRate)); }
    catch (err) { self.postMessage({ warn: `C++ DSP unavailable in the worker: ${err?.message ?? err}` }); }
  }
  graph ??= new Graph();
  const worker = new PoolWorker({ sab, port, graph, onError: (err) => self.postMessage({ error: String(err?.stack ?? err) }) });
  worker.run();
};
