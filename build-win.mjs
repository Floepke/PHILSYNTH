// Builds Windows executables:  npm run build:win  ->  release/PHILSYNTH-<version>-win-<arch>-setup.exe
//                                                     release/PHILSYNTH-<version>-win-<arch>-portable.exe
// Options: --arch=x64|arm64 (default: x64).
// Runs on Windows, or on Linux/macOS with Wine installed (needed to embed the icon and version info).
// The executables are not code-signed, so Windows SmartScreen asks for confirmation on first launch.
// Autosaves of the app go to %APPDATA%\PHILSYNTH\projects (see electron/main.mjs).
import { Arch, build, Platform } from 'electron-builder';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcon } from './build-icon.mjs';
import { ensureKoffi } from './build-koffi.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'release');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const arch = arg('arch') || 'x64';
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (!['x64', 'arm64'].includes(arch)) {
  console.error(`Unsupported Windows architecture: ${arch} (expected x64 or arm64).`);
  process.exit(1);
}
if (process.platform !== 'win32') {
  try {
    execFileSync('wine', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('build:win needs Wine on Linux/macOS (e.g. sudo apt install wine), or run it on Windows.');
    process.exit(1);
  }
}
if (!existsSync(join(ROOT, 'src', 'dsp', 'modsynth.wasm'))) console.warn('warning: src/dsp/modsynth.wasm is missing (npm run build:wasm); the app falls back to the JS DSP.');
await buildIcon();
const koffi = ensureKoffi('win32', arch); // real-time worker threads (electron/realtime.cjs)

const name = `PHILSYNTH-${pkg.version}-win-${arch}`;
await build({
  projectDir: ROOT,
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch[arch]),
  config: {
    appId: 'com.floepke.modsynth',
    productName: 'PHILSYNTH',
    copyright: `© ${new Date().getFullYear()} Philip Bergwerf`,
    directories: { output: OUT },
    files: ['package.json', 'index.html', 'style.css', 'server.mjs', 'src/**/*', 'electron/**/*', 'node_modules/wasm-media-encoders/**/*', 'node_modules/koffi/**/*', `node_modules/${koffi}/**/*`],
    asar: true,
    asarUnpack: ['**/*.node'], // native binaries (koffi) can't load from inside the archive
    npmRebuild: false,
    win: {
      executableName: 'PHILSYNTH',
      icon: join(ROOT, 'build', 'icons', '256x256.png'),
    },
    nsis: {
      artifactName: `${name}-setup.\${ext}`,
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      shortcutName: 'PHILSYNTH',
    },
    portable: { artifactName: `${name}-portable.\${ext}` },
  },
});
console.log(`\nBuilt ${join(OUT, `${name}-setup.exe`)}\nBuilt ${join(OUT, `${name}-portable.exe`)}`);
