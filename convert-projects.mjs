import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareCurrentProjectArchive, readProjectArchive } from './src/projectarchive.js';
import { copyZipEntry, readZipStream } from './src/projectzipstream.js';
import { PROJECT_EXT } from './src/fileformat.js';
import { MAX_PROJECT_BYTES } from './src/projectzip.js';
import { decodeLegacySample } from './src/samples.js';

const usage = `Usage: node convert-projects.mjs [--dry-run] [source-folder destination-folder]
Defaults to "pCloud Drive/PHILSYNTH" and "pCloud Drive/PHILSYNTH2" in your home directory.
Both folders must exist. Subfolders are preserved; originals and existing outputs are never overwritten.`;

const entryAt = (path) => lstat(path).catch((err) => {
  if (err.code !== 'ENOENT') throw err;
  return null;
});

function contains(parent, child) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function writeNewProject(dir, dest, bytes) {
  const tempDir = await mkdtemp(join(dir, '.phproject-convert-'));
  const temp = join(tempDir, basename(dest));
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    try {
      await link(temp, dest);
    } catch (err) {
      // Cloud drives may not implement hard links. The fallback still refuses to overwrite.
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'].includes(err.code)) throw err;
      await copyFile(temp, dest, constants.COPYFILE_EXCL);
    }
  } finally {
    try { await unlink(temp); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    await rmdir(tempDir);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help) return console.log(usage);
  if (positionals.length !== 0 && positionals.length !== 2) throw new Error(usage);
  const cloud = join(homedir(), 'pCloud Drive');
  const [source, destination] = await Promise.all(
    (positionals.length ? positionals : [join(cloud, 'PHILSYNTH'), join(cloud, 'PHILSYNTH2')]).map((path) => realpath(path)),
  );
  const [input, output] = await Promise.all([stat(source), stat(destination)]);
  if (!input.isDirectory() || !output.isDirectory()) throw new Error('Both paths must be folders');
  if ((input.dev === output.dev && input.ino === output.ino) || contains(source, destination) || contains(destination, source)) {
    throw new Error('Source and destination must be separate, non-nested folders');
  }
  const dryRun = values['dry-run'];
  let converted = 0, skipped = 0, failed = 0;
  const reportFailure = (path, err) => {
    failed++;
    console.error(`FAILED ${JSON.stringify(relative(source, path) || '.')}: ${err.message}`);
  };
  const skip = (name, reason) => {
    skipped++;
    console.log(`SKIP  ${name}: ${reason}`);
  };

  async function convert(path, destDir, filename) {
    const name = JSON.stringify(relative(source, path));
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let project;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_PROJECT_BYTES) throw new Error('Not a regular project file or file too large');
      const bytes = await file.readFile();
      if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4 && bytes[4] === 45 && bytes[5] === 0) {
        const entries = await readZipStream(new Blob([bytes]));
        const manifest = entries.get('project.json');
        if (!manifest || manifest.blob.size > 16 * 1024 * 1024) throw new Error('Invalid project manifest');
        const chunks = [];
        await copyZipEntry(manifest, (part) => chunks.push(part.slice()));
        const data = JSON.parse(await new Blob(chunks).text());
        if (data.format !== 'philsynth' || data.version !== 3) throw new Error('Unsupported project archive');
        return skip(name, 'already v3');
      }
      project = await readProjectArchive(bytes);
    } finally { await file.close(); }
    if (project.version === 2) return skip(name, 'already v2');
    const dest = join(destDir, filename);
    if (await entryAt(dest)) return skip(name, 'output already exists');

    const { data } = project;
    const legacy = data.samples ?? {};
    const encode = prepareCurrentProjectArchive(data, null, (id) => {
      if (!Object.hasOwn(legacy, id)) return null;
      try { return decodeLegacySample(legacy[id]); }
      catch (err) { throw new Error(`Invalid project media ${id}: ${err.message}`, { cause: err }); }
    });
    const bytes = new Uint8Array(await (await encode()).arrayBuffer());
    if (!dryRun) {
      await mkdir(destDir, { recursive: true });
      try { await writeNewProject(destDir, dest, bytes); }
      catch (err) {
        if (err.code === 'EEXIST') return skip(name, 'output already exists');
        throw err;
      }
    }
    converted++;
    console.log(`${dryRun ? 'WOULD CONVERT' : 'OK'} ${name}`);
  }

  async function walk(dir, destDir) {
    try {
      const existing = await entryAt(destDir);
      if (existing && !existing.isDirectory()) throw new Error(`Output folder is blocked: ${destDir}`);
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, join(destDir, entry.name));
        else if (entry.isFile() && extname(entry.name).toLowerCase() === PROJECT_EXT) {
          try { await convert(path, destDir, entry.name); }
          catch (err) { reportFailure(path, err); }
        }
      }
    } catch (err) { reportFailure(dir, err); }
  }

  console.log(`${source}\n-> ${destination}`);
  await walk(source, destination);
  console.log(`${converted} ${dryRun ? 'would convert' : 'converted'}, ${skipped} skipped, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

try { await main(); }
catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
