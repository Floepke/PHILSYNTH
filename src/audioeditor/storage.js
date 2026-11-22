import { copyEditedRecording, createRecordingFile, readRecordingPeaks, recoverRecordingFile, validateRecordingFile, validateRecordingFormat, writeAll } from './recordingfile.js';
import { copyZipEntry } from '../projectzipstream.js';
import { isRecordingId } from './id.js';

const DIR = 'audio-recordings';

const filename = (id) => {
  if (!isRecordingId(id)) throw new Error('Invalid recording ID');
  return `${id}.wav`;
};

// Sync access handles are available in dedicated workers, not the audio thread.
export async function openRecordingStorage(storage = globalThis.navigator?.storage) {
  if (!storage?.getDirectory) throw new Error('Audio recording storage is not available');
  const root = await storage.getDirectory();
  const dir = await root.getDirectoryHandle(DIR, { create: true });

  async function freshFile() {
    const id = globalThis.crypto.randomUUID();
    const name = filename(id);
    try {
      await dir.getFileHandle(name);
      throw new Error('Recording ID already exists');
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    return { id, name, handle: await dir.getFileHandle(name, { create: true }) };
  }

  return {
    async create(format) {
      validateRecordingFormat(format);
      const { id, name, handle } = await freshFile();
      let access = null;
      try {
        access = await handle.createSyncAccessHandle();
        const writer = createRecordingFile(access, format);
        return { id, writer };
      } catch (error) {
        const failures = [error];
        if (access) {
          try { access.close(); } catch (closeError) { failures.push(closeError); }
        }
        try { await dir.removeEntry(name); } catch (cleanupError) { failures.push(cleanupError); }
        if (failures.length > 1) throw new AggregateError(failures, `Could not start recording ${id} or clean up`);
        throw new Error(`Could not start recording ${id}: ${error.message}`, { cause: error });
      }
    },
    async file(id) {
      return (await dir.getFileHandle(filename(id))).getFile();
    },
    async discard(id) {
      await dir.removeEntry(filename(id));
    },
    async importEntry(entry) {
      if (!(entry?.blob instanceof Blob) || entry.blob.size < 44 || entry.blob.size > 0xffffffff + 8) {
        throw new Error('Invalid recording WAV size');
      }
      const target = await freshFile();
      let access = null;
      try {
        access = await target.handle.createSyncAccessHandle();
        let at = 0;
        await copyZipEntry(entry, (bytes) => { writeAll(access, bytes, at); at += bytes.length; });
        const info = validateRecordingFile(access);
        access.flush();
        access.close();
        access = null;
        return { id: target.id, ...info };
      } catch (error) {
        const failures = [error];
        if (access) {
          try { access.close(); } catch (closeError) { failures.push(closeError); }
        }
        try { await dir.removeEntry(target.name); } catch (cleanupError) { failures.push(cleanupError); }
        if (failures.length > 1) throw new AggregateError(failures, 'Audio import and cleanup failed');
        throw error;
      }
    },
    async recover(id) {
      const handle = await dir.getFileHandle(filename(id));
      const access = await handle.createSyncAccessHandle();
      try {
        return recoverRecordingFile(access);
      } finally {
        access.close();
      }
    },
    async peaks(id, start, end, bins) {
      const handle = await dir.getFileHandle(filename(id));
      const access = await handle.createSyncAccessHandle();
      try {
        return readRecordingPeaks(access, start, end, bins);
      } finally {
        access.close();
      }
    },
    async edit(id, channel, points) {
      const source = await (await dir.getFileHandle(filename(id))).createSyncAccessHandle();
      let target = null, access = null;
      try {
        target = await freshFile();
        access = await target.handle.createSyncAccessHandle();
        const info = copyEditedRecording(source, access, channel, points);
        access.close();
        access = null;
        return { id: target.id, ...info };
      } catch (error) {
        const failures = [error];
        if (access) {
          try { access.close(); } catch (closeError) { failures.push(closeError); }
        }
        if (target) {
          try { await dir.removeEntry(target.name); } catch (cleanupError) { failures.push(cleanupError); }
        }
        if (failures.length > 1) throw new AggregateError(failures, 'Audio edit and cleanup failed');
        throw error;
      } finally {
        source.close();
      }
    },
    async list() {
      const ids = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && name.endsWith('.wav') && isRecordingId(name.slice(0, -4))) ids.push(name.slice(0, -4));
      }
      return ids.sort();
    },
  };
}
