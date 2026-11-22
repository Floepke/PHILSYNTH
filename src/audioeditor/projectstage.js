const CHUNK = 1024 * 1024;

// Electron's main process owns the native handle. Copy to OPFS so ZIP entries can be sliced
// without transferring the entire archive through IPC or retaining it in renderer memory.
export async function stageProjectStream(files, info, storage = globalThis.navigator?.storage, kind = 'project') {
  let dir = null, name = null, created = false, writable = null, blob = null;
  const failures = [];
  try {
    if (!storage?.getDirectory) throw new Error(`Temporary ${kind} storage is unavailable`);
    dir = await (await storage.getDirectory()).getDirectoryHandle(`${kind}-imports`, { create: true });
    name = `${crypto.randomUUID()}.tmp`;
    try {
      await dir.getFileHandle(name);
      throw new Error(`Temporary ${kind} ID already exists`);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    const handle = await dir.getFileHandle(name, { create: true });
    created = true;
    writable = await handle.createWritable();
    for (let at = 0; at < info.size; at += CHUNK) {
      const length = Math.min(CHUNK, info.size - at);
      const bytes = await files.readProjectStream(info.id, at, length);
      if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(`Could not read the complete ${kind}`);
      await writable.write(bytes);
    }
    await writable.close();
    writable = null;
    blob = await handle.getFile();
  } catch (error) { failures.push(error); }
  try { await files.closeProjectStream(info.id); } catch (error) { failures.push(error); }
  if (failures.length) {
    if (writable) {
      try { await writable.abort(); } catch (error) { failures.push(error); }
    }
    if (created) {
      try { await dir.removeEntry(name); } catch (error) { failures.push(error); }
    }
    if (failures.length > 1) throw new AggregateError(failures, `${kind} import and cleanup failed`);
    throw failures[0];
  }
  return { blob, cleanup: () => dir.removeEntry(name) };
}
