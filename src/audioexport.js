export function renderAudio(project, { sampleRate, wasm, signal, onProgress, onEncoding }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./exportworker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error(event.message || 'Audio export worker failed'));
    };
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'progress') onProgress?.(data.fraction);
      else if (data.type === 'encoding') onEncoding?.();
      else if (data.type === 'complete') finish(null, data);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    try { worker.postMessage({ project, sampleRate, wasm }); }
    catch (err) { finish(err); }
  });
}

export async function writeAudio(handle, blob, signal) {
  signal.throwIfAborted();
  const writable = await handle.createWritable();
  const abort = () => {
    writable.abort(signal.reason).catch((err) => console.error('Could not abort audio file write:', err));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) {
      await writable.abort(signal.reason);
      signal.throwIfAborted();
    }
    await writable.write(blob);
    signal.throwIfAborted();
    await writable.close();
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
