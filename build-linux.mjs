// Builds a Linux AppImage and registers it in the current user's application menu.
import { build, Platform } from 'electron-builder';
import { chmod, copyFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcon } from './build-icon.mjs';
import { ensureKoffi } from './build-koffi.mjs';
import { installDesktopEntry } from './build-linux-desktop.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'release');
const IMAGE = join(ROOT, 'PHILSYNTH.AppImage');

if (process.platform !== 'linux') {
  console.error('build:linux runs on Linux.');
  process.exit(1);
}
if (!['x64', 'arm64'].includes(process.arch)) {
  console.error(`Unsupported Linux architecture: ${process.arch} (expected x64 or arm64).`);
  process.exit(1);
}

await stat(join(ROOT, 'src', 'dsp', 'modsynth.wasm'));
await buildIcon();
const koffi = ensureKoffi('linux', process.arch); // real-time worker threads (electron/realtime.cjs)
await build({
  projectDir: ROOT,
  targets: Platform.LINUX.createTarget('AppImage'),
  config: {
    appId: 'com.floepke.modsynth',
    productName: 'PHILSYNTH',
    directories: { output: OUT },
    files: ['package.json', 'index.html', 'style.css', 'server.mjs', 'src/**/*', 'electron/**/*', 'node_modules/wasm-media-encoders/**/*', 'node_modules/koffi/**/*', `node_modules/${koffi}/**/*`],
    asar: true,
    asarUnpack: ['**/*.node'], // native binaries (koffi) can't load from inside the archive
    npmRebuild: false,
    linux: {
      target: 'AppImage',
      executableName: 'PHILSYNTH',
      artifactName: 'PHILSYNTH.AppImage',
      category: 'AudioVideo',
      synopsis: 'Modular synthesizer',
      icon: join(ROOT, 'build', 'icons'),
      syncDesktopName: true,
    },
    appImage: { artifactName: 'PHILSYNTH.AppImage' },
  },
});
const temporaryImage = `${IMAGE}.${process.pid}.tmp`;
try {
  await copyFile(join(OUT, 'PHILSYNTH.AppImage'), temporaryImage);
  await chmod(temporaryImage, 0o755);
  // Replace atomically so rebuilding also works while the previous AppImage is running.
  await rename(temporaryImage, IMAGE);
} finally {
  await rm(temporaryImage, { force: true });
}
console.log(`\nBuilt ${IMAGE} (${process.arch}, ${(await stat(IMAGE)).size} bytes)`);
const launcher = await installDesktopEntry(IMAGE, join(ROOT, 'build', 'icons', '512x512.png'));
console.log(`Installed menu launcher: ${launcher}\nSearch for PHILSYNTH in your application menu to launch it.`);
