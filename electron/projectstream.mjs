import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isProjectZip } from '../src/projectzip.js';

export const PROJECT_STREAM_CHUNK = 1024 * 1024;

export async function createProjectStreamWriter(path) {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(tmp, 'wx', 0o600);
  let state = 'open', busy = false, size = 0;
  const enter = () => {
    if (state !== 'open' || busy) throw new Error('Project stream is not available');
    busy = true;
  };
  const cleanup = async () => {
    const errors = [];
    if (state === 'open') {
      try { await file.close(); } catch (error) { errors.push(error); }
    }
    state = 'closed';
    try { await rm(tmp, { force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Could not clean up temporary project');
  };
  return {
    async write(bytes) {
      enter();
      try {
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PROJECT_STREAM_CHUNK ||
            (!size && !isProjectZip(bytes)) || !Number.isSafeInteger(size + bytes.length)) {
          throw new Error('Invalid project stream data');
        }
        let at = 0;
        while (at < bytes.length) {
          const { bytesWritten } = await file.write(bytes, at, bytes.length - at);
          if (!bytesWritten) throw new Error('Could not write project data');
          at += bytesWritten;
        }
        size += bytes.length;
      } catch (error) {
        try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project save and cleanup failed'); }
        throw error;
      } finally { busy = false; }
    },
    async finish() {
      enter();
      try {
        if (!size) throw new Error('Empty project stream');
        await file.sync();
        await file.close();
        state = 'closed';
        await rename(tmp, path);
        state = 'finished';
      } catch (error) {
        try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project save and cleanup failed'); }
        throw error;
      } finally { busy = false; }
    },
    async abort() {
      if (state === 'finished') return;
      if (state === 'closed') { await rm(tmp, { force: true }); return; }
      enter();
      try { await cleanup(); } finally { busy = false; }
    },
  };
}

export async function openProjectStreamReader(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat(), size = stat.size;
    if (!stat.isFile() || !Number.isSafeInteger(size)) throw new Error('Invalid project file');
    let closed = false, busy = false;
    return {
      size,
      async read(at, length) {
        if (closed || busy) throw new Error('Project stream is not available');
        if (!Number.isSafeInteger(at) || !Number.isInteger(length) || at < 0 || length < 1 ||
            length > PROJECT_STREAM_CHUNK || at + length > size) throw new Error('Invalid project read range');
        busy = true;
        try {
          const bytes = new Uint8Array(length);
          let done = 0;
          while (done < length) {
            const result = await file.read(bytes, done, length - done, at + done);
            if (!result.bytesRead) throw new Error('Project file changed while reading');
            done += result.bytesRead;
          }
          return bytes;
        } finally { busy = false; }
      },
      async close() {
        if (closed) return;
        if (busy) throw new Error('Project stream is busy');
        closed = true;
        await file.close();
      },
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}
