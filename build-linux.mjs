// Builds a Linux AppImage: npm run build:linux -> ~/Desktop/MODSYNTH.AppImage
import { build, Platform } from 'electron-builder';
import { chmod, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'release');
const DESKTOP = join(homedir(), 'Desktop');
const IMAGE = join(DESKTOP, 'MODSYNTH.AppImage');

if (process.platform !== 'linux') {
  console.error('build:linux runs on Linux.');
  process.exit(1);
}
if (!['x64', 'arm64'].includes(process.arch)) {
  console.error(`Unsupported Linux architecture: ${process.arch} (expected x64 or arm64).`);
  process.exit(1);
}

await stat(join(ROOT, 'src', 'dsp', 'modsynth.wasm'));
await build({
  projectDir: ROOT,
  targets: Platform.LINUX.createTarget('AppImage'),
  config: {
    appId: 'com.floepke.modsynth',
    productName: 'MODSYNTH',
    directories: { output: OUT },
    files: ['package.json', 'index.html', 'style.css', 'server.mjs', 'src/**/*', 'electron/**/*'],
    asar: true,
    npmRebuild: false,
    linux: {
      target: 'AppImage',
      executableName: 'MODSYNTH',
      artifactName: 'MODSYNTH.AppImage',
      category: 'AudioVideo',
      synopsis: 'Modular synthesizer',
    },
    appImage: { artifactName: 'MODSYNTH.AppImage' },
  },
});
await mkdir(DESKTOP, { recursive: true });
const temporaryImage = `${IMAGE}.${process.pid}.tmp`;
try {
  await copyFile(join(OUT, 'MODSYNTH.AppImage'), temporaryImage);
  await chmod(temporaryImage, 0o755);
  // Replace atomically so rebuilding also works while the previous AppImage is running.
  await rename(temporaryImage, IMAGE);
} finally {
  await rm(temporaryImage, { force: true });
}
console.log(`\nBuilt ${IMAGE} (${process.arch}, ${(await stat(IMAGE)).size} bytes)`);
