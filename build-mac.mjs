// Builds the macOS app:  npm run build:mac   ->  release/PHILSYNTH-darwin-<arch>/PHILSYNTH.app
// Options: --arch=arm64|x64|universal (default: this Mac's), --zip (also writes PHILSYNTH-<version>-<arch>.zip)
// The app is not signed with a Developer ID: on another Mac, open it the first time with
// right-click > Open (or: xattr -dr com.apple.quarantine PHILSYNTH.app).
// Only what the app needs at runtime is copied (index.html, style.css, src/, server.mjs, electron/);
// autosaves of the app go to ~/Library/Application Support/PHILSYNTH/projects (see electron/main.mjs).
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcon } from './build-icon.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'release');
const ICON = join(ROOT, 'build', 'icon.icns');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const arch = arg('arch') || process.arch;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (process.platform !== 'darwin') {
  console.error('build:mac runs on macOS (it signs the app with codesign).');
  process.exit(1);
}
if (!existsSync(join(ROOT, 'src', 'dsp', 'modsynth.wasm'))) console.warn('warning: src/dsp/modsynth.wasm is missing (npm run build:wasm); the app falls back to the JS DSP.');
await buildIcon();

// everything outside these is left out of the bundle
const KEEP = /^\/(package\.json|index\.html|style\.css|server\.mjs|src(\/.*)?|electron(\/.*)?)$/;

const [appDir] = await packager({
  dir: ROOT,
  out: OUT,
  name: 'PHILSYNTH',
  executableName: 'PHILSYNTH',
  appBundleId: 'com.floepke.modsynth',
  appCategoryType: 'public.app-category.music',
  appVersion: pkg.version,
  appCopyright: `© ${new Date().getFullYear()} Philip Bergwerf`,
  platform: 'darwin',
  arch,
  icon: existsSync(ICON) ? ICON : undefined,
  overwrite: true,
  prune: true,
  asar: true,
  ignore: (path) => path !== '' && !KEEP.test(path) && !/^\/(src|electron)$/.test(path),
  extendInfo: {
    NSHighResolutionCapable: true,
    NSMicrophoneUsageDescription: 'PHILSYNTH uses the microphone for its INPUT module.',
  },
});
const appPath = join(appDir, 'PHILSYNTH.app');

// Ad-hoc signature: required on Apple silicon, and keeps the bundle consistent after packaging.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
console.log(`\nBuilt ${appPath}`);

if (process.argv.includes('--zip')) {
  mkdirSync(OUT, { recursive: true });
  const zip = join(OUT, `PHILSYNTH-${pkg.version}-${arch}.zip`);
  rmSync(zip, { force: true });
  // ditto keeps the bundle's symlinks and signature intact (plain zip breaks them)
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip], { stdio: 'inherit' });
  console.log(`Zipped ${zip}`);
}
