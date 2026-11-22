import { openRecordingStorage } from './storage.js';
import { inspectRecordingBlob } from './recordingfile.js';
import { fillAudioPage } from './pagecache.js';
import { normalizeAudioContent } from '../song.js';

self.onmessage = ({ data }) => {
  const { memory, port } = data;
  self.onmessage = null;
  let storage = null;
  const files = new Map();
  let queue = Promise.resolve();
  port.onmessage = ({ data: request }) => {
    queue = queue.then(async () => {
      const { audio: raw, page, slot, sequence } = request;
      try {
        const audio = normalizeAudioContent(raw);
        let entry = files.get(audio.id);
        if (!entry) {
          storage ??= await openRecordingStorage();
          const file = await storage.file(audio.id);
          const info = await inspectRecordingBlob(file);
          entry = { file, ...info };
          files.set(audio.id, entry);
        }
        if (entry.frames !== audio.frames || entry.channels !== audio.channels || entry.sampleRate !== audio.sampleRate) {
          throw new Error('Audio clip does not match its recording');
        }
        await fillAudioPage(memory, entry, page, slot);
        port.postMessage({ slot, sequence });
      } catch (error) {
        port.postMessage({ slot, sequence, error: error?.message ?? String(error) });
      }
    });
  };
  port.start();
  self.postMessage({ ready: true });
};
