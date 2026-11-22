export class AudioAssets {
  constructor({ onError }) {
    if (typeof onError !== 'function') throw new Error('Audio storage needs an error handler');
    this.onError = onError;
    this.worker = new Worker(new URL('./assetworker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.next = 0;
    this.closed = false;
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.request);
      if (!request) return;
      this.pending.delete(data.request);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    const fail = (message) => {
      const error = new Error(message);
      this.close(error);
      this.onError(error);
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || 'Audio storage worker failed');
    };
    this.worker.onmessageerror = () => fail('Audio storage worker sent an unreadable message');
  }

  request(type, data = {}) {
    if (this.closed) return Promise.reject(new Error('Audio storage is closed'));
    const request = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(request, { resolve, reject });
      try { this.worker.postMessage({ ...data, request, type }); }
      catch (error) { this.pending.delete(request); reject(error); }
    });
  }

  peaks(asset, start, end, bins) { return this.request('peaks', { asset, start, end, bins }); }
  edit(asset, channel, points) { return this.request('edit', { asset, channel, points }); }
  file(asset) { return this.request('file', { asset }); }
  discard(asset) { return this.request('discard', { asset }); }
  importEntry(entry) { return this.request('importEntry', { entry }); }
  importMedia(file) { return this.request('importMedia', { file }); }
  recover(asset) { return this.request('recover', { asset }); }
  list() { return this.request('list'); }

  close(error = new Error('Audio storage closed')) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
