import { readFile, stat } from 'node:fs/promises';
import { basename, parse } from 'node:path';
import { atomicWrite } from './atomicwrite.mjs';
import { checkPath } from './fsbrowse.mjs';

export function createBookmarkStore(file) {
  let queue = Promise.resolve();
  const run = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  async function load() {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const paths = JSON.parse(text);
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string' || checkPath(path) !== path) ||
        new Set(paths).size !== paths.length) throw new Error('Invalid folder bookmarks');
    return paths;
  }
  const entries = (paths) => paths.map((path) => ({ path, name: basename(path) || parse(path).root }));
  return {
    list: () => run(async () => entries(await load())),
    add: (path) => run(async () => {
      const p = checkPath(path);
      if (!(await stat(p)).isDirectory()) throw new Error('Choose a folder, not a file');
      const paths = await load();
      if (!paths.includes(p)) {
        paths.push(p);
        await atomicWrite(file, JSON.stringify(paths));
      }
      return entries(paths);
    }),
    remove: (path) => run(async () => {
      const p = checkPath(path);
      const paths = await load();
      const next = paths.filter((item) => item !== p);
      if (next.length !== paths.length) await atomicWrite(file, JSON.stringify(next));
      return entries(next);
    }),
  };
}
