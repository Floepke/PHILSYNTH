import { writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// A crash never leaves half a project or preferences file.
export async function atomicWrite(path, text, { signal } = {}) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    signal?.throwIfAborted();
    await writeFile(tmp, text, { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch((cleanupError) => console.error('Could not remove temporary export/project file:', cleanupError));
    throw err;
  }
}
