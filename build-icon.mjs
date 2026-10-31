// Render the original SVG with Electron's Chromium; no extra image tools are needed.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

export async function buildIcon() {
  const electron = createRequire(import.meta.url)('electron');
  const { stdout, stderr } = await promisify(execFile)(electron, [fileURLToPath(import.meta.url), '--render'], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    timeout: 60000,
  });
  if (stderr) process.stderr.write(stderr);
  process.stdout.write(stdout);
}

async function renderIcons(BrowserWindow) {
  await mkdir(join(ROOT, 'build', 'icons'), { recursive: true });
  const svg = await readFile(join(ROOT, 'src', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  try {
    await win.loadURL('data:text/html,<html><body></body></html>');
    const chunks = [];
    for (const size of SIZES) {
      const data = await win.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = ${size};
        canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const png = Buffer.from(data, 'base64');
      await writeFile(join(ROOT, 'build', 'icons', `${size}x${size}.png`), png);
      if (size === 512) await writeFile(join(ROOT, 'src', 'icon.png'), png);
      const kind = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' }[size];
      if (kind) {
        const header = Buffer.alloc(8);
        header.write(kind);
        header.writeUInt32BE(png.length + 8, 4);
        chunks.push(header, png);
      }
    }
    const header = Buffer.alloc(8);
    header.write('icns');
    header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    await writeFile(join(ROOT, 'build', 'icon.icns'), Buffer.concat([header, ...chunks]));
    console.log('Built Linux PNG icons (16–1024 px), src/icon.png, and macOS icon.icns');
  } finally {
    win.destroy();
  }
}

if (process.versions.electron && process.argv.includes('--render')) {
  const { app, BrowserWindow } = await import('electron');
  app.whenReady().then(async () => {
    await renderIcons(BrowserWindow);
    app.quit();
  }).catch(error => {
    console.error(error);
    app.exit(1);
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildIcon();
}
