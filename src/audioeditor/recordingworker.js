import { RecordingBuffer, RECORDING_ACTIVE, RECORDING_OVERRUN, RECORDING_TEMPO_CHANGED } from './recordingbuffer.js';
import { openRecordingStorage } from './storage.js';

self.onmessage = async ({ data }) => {
  let writer = null;
  let id = null;
  try {
    self.onmessage = null;
    const buffer = new RecordingBuffer(data.buffer);
    const store = await openRecordingStorage();
    ({ id, writer } = await store.create({ sampleRate: data.sampleRate, channels: buffer.channels }));
    self.postMessage({ type: 'ready', id });
    const output = Array.from({ length: buffer.channels }, () => new Float32Array(4096));
    let frames = 0;
    let checkpoint = performance.now() + 1000;
    for (;;) {
      const signal = buffer.signal;
      const count = buffer.read(output);
      if (count) {
        writer.append(output.map((channel) => channel.subarray(0, count)));
        frames += count;
      }
      if (performance.now() >= checkpoint) {
        writer.checkpoint();
        self.postMessage({ type: 'progress', id, frames });
        checkpoint = performance.now() + 1000;
      }
      if (count) continue;
      if (buffer.state !== RECORDING_ACTIVE) break;
      buffer.wait(signal, 1000);
    }
    const result = writer.finish();
    writer = null;
    if (buffer.state === RECORDING_OVERRUN) {
      self.postMessage({ type: 'error', id, message: 'Recording stopped because the disk writer could not keep up', ...result });
    } else if (buffer.state === RECORDING_TEMPO_CHANGED) {
      self.postMessage({ type: 'error', id, message: 'Recording stopped because the tempo changed', ...result });
    } else self.postMessage({ type: 'complete', id, ...result });
  } catch (error) {
    let message = error?.message ?? String(error);
    if (writer) {
      try { writer.close(); } catch (closeError) { message += `; could not close recording: ${closeError.message}`; }
    }
    self.postMessage({ type: 'error', id, message });
  }
};
