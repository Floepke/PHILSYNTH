import { openRecordingStorage } from './storage.js';
import { importMedia } from './mediaimport.js';

let storage = null;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      storage ??= await openRecordingStorage();
      let result;
      if (data.type === 'peaks') result = await storage.peaks(data.asset, data.start, data.end, data.bins);
      else if (data.type === 'edit') result = await storage.edit(data.asset, data.channel, data.points);
      else if (data.type === 'file') result = await storage.file(data.asset);
      else if (data.type === 'discard') result = await storage.discard(data.asset);
      else if (data.type === 'importEntry') result = await storage.importEntry(data.entry);
      else if (data.type === 'importMedia') result = await importMedia(storage, data.file);
      else if (data.type === 'recover') result = await storage.recover(data.asset);
      else if (data.type === 'list') result = await storage.list();
      else throw new Error('Unknown audio storage operation');
      const transfers = data.type === 'peaks' ? result.map((channel) => channel.buffer) : [];
      self.postMessage({ request: data.request, result }, transfers);
    } catch (error) {
      self.postMessage({ request: data.request, error: error?.message ?? String(error) });
    }
  });
};
