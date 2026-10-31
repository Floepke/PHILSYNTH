// MODSYNTH dev server (no dependencies):  node server.mjs   ->  http://localhost:8080
// Also used in-process by the Electron app (electron/main.mjs) through start().
//  - serves the app with caching disabled (worklet edits are picked up on reload)
//  - GET/PUT /api/autosave  stores the project in projects/autosave.json (previous copy kept as autosave.prev.json)
//  - /api/live              server-sent events: reloads the page when code changes, hot-swaps CSS
// MODSYNTH_PROJECTS moves the projects folder (the packaged MODSYNTH.app keeps it in its
// Application Support folder, the bundle itself is read-only); MODSYNTH_NO_WATCH=1 turns live reload off.
import http from 'node:http';
import { watch } from 'node:fs';
import { readFile, writeFile, rename, mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECTS = process.env.MODSYNTH_PROJECTS || join(ROOT, 'projects');
const AUTOSAVE = join(PROJECTS, 'autosave.json');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 50 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

const liveClients = new Set();

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let writeQueue = Promise.resolve();

async function handleAutosave(req, res) {
  if (req.method === 'GET') {
    try {
      send(res, 200, await readFile(AUTOSAVE, 'utf8'), MIME['.json']);
    } catch {
      send(res, 404, 'No autosave yet');
    }
    return;
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    let data;
    try {
      data = JSON.parse(await readBody(req));
      if (data?.format !== 'modsynth') throw new Error('Not a modsynth project');
    } catch (err) {
      send(res, 400, err.message);
      return;
    }
    // serialize writes; write to a temp file and rename so a crash never leaves a half-written file
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await mkdir(PROJECTS, { recursive: true });
      await copyFile(AUTOSAVE, join(PROJECTS, 'autosave.prev.json')).catch(() => {}); // keep one backup
      const tmp = `${AUTOSAVE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, AUTOSAVE);
    });
    try {
      await writeQueue;
      send(res, 200, '{"ok":true}', MIME['.json']);
    } catch (err) {
      send(res, 500, err.message);
    }
    return;
  }
  send(res, 405, 'Method not allowed');
}

function handleLive(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  liveClients.add(res);
  req.on('close', () => liveClients.delete(res));
}

async function handleStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }
  let file = normalize(join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { send(res, 403, 'Forbidden'); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/autosave') return handleAutosave(req, res);
  if (pathname === '/api/live') return handleLive(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  return handleStatic(req, res);
});

// ---- live reload ----
const IGNORE = /^(projects|test|cpp|node_modules|electron|\.git)(\/|$)|\.tmp$|~$|\.swp$/;
let pending = null;
let cssOnly = true;
const watchCode = () => watch(ROOT, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  const rel = filename.split(sep).join('/');
  if (IGNORE.test(rel)) return;
  if (!rel.endsWith('.css')) cssOnly = false;
  clearTimeout(pending);
  pending = setTimeout(() => {
    const event = cssOnly ? 'css' : 'reload';
    cssOnly = true;
    for (const c of liveClients) c.write(`event: ${event}\ndata: ${rel}\n\n`);
    console.log(`[live] ${event}: ${rel}`);
  }, 120);
});

// Start serving; resolves with the port actually used (port 0 = any free port).
let watcher = null;
export function start(port = PORT, host = HOST) {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      if (!process.env.MODSYNTH_NO_WATCH) watcher ??= watchCode();
      ok(server.address().port);
    });
  });
}

export const stop = () => new Promise((ok) => {
  watcher?.close();
  watcher = null;
  for (const c of liveClients) c.end();
  server.close(() => ok());
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((port) => {
    console.log(`MODSYNTH running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${port}`);
    console.log(`Autosave file: ${relative(process.cwd(), AUTOSAVE) || AUTOSAVE}`);
  });
}
