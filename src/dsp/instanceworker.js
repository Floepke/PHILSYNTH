// A worker rendering PATCH instances (src/dsp/instancepool.js, started by src/engine.js).
// init message: { sab, port, wasm: bytes of src/dsp/modsynth.wasm or null, sampleRate }
self.onmessage = async (e) => {
  self.onmessage = null;
  const { sab, port, wasm, sampleRate, requireRealtime, budget } = e.data;
  globalThis.sampleRate = sampleRate; // the kernels read it like in an AudioWorkletGlobalScope
  // Desktop app (Node in workers, electron/main.mjs): real-time priority like the audio thread,
  // so the OS doesn't wake this worker late (electron/realtime.cjs)
  let realtime = { ok: false, error: 'Real-time priority unavailable in this worker' };
  if (typeof require === 'function' && typeof process === 'object' && process.env?.MODSYNTH_REALTIME) {
    try {
      realtime = require(process.env.MODSYNTH_REALTIME).requestRealtime(sampleRate);
    } catch (err) { realtime = { ok: false, error: String(err?.message ?? err) }; }
  }
  if (!realtime.ok) {
    if (requireRealtime) { self.postMessage({ ready: true, realtime }); return; }
    self.postMessage({ warn: `PATCH instance worker runs without real-time priority: ${realtime.error}` });
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
  const worker = new PoolWorker({ sab, port, graph, budget, onError: (err) => self.postMessage({ error: String(err?.stack ?? err) }) });
  self.postMessage({ ready: true, realtime });
  worker.run();
};
