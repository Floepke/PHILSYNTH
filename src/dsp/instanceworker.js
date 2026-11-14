// A worker rendering PATCH instances (src/dsp/instancepool.js, started by src/engine.js).
// init message: { sab, port, wasm: bytes of src/dsp/modsynth.wasm or null, sampleRate }
self.onmessage = async (e) => {
  self.onmessage = null;
  const { sab, port, wasm, sampleRate } = e.data;
  globalThis.sampleRate = sampleRate; // the kernels read it like in an AudioWorkletGlobalScope
  // Desktop app (Node in workers, electron/main.mjs): real-time priority like the audio thread,
  // so the OS doesn't wake this worker late (electron/realtime.cjs)
  if (typeof require === 'function' && typeof process === 'object' && process.env?.MODSYNTH_REALTIME) {
    try {
      const rt = require(process.env.MODSYNTH_REALTIME).requestRealtime(sampleRate);
      if (!rt.ok) self.postMessage({ warn: `PATCH instance worker runs without real-time priority: ${rt.error}` });
    } catch (err) { self.postMessage({ warn: `PATCH instance worker runs without real-time priority: ${err?.message ?? err}` }); }
  }
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
