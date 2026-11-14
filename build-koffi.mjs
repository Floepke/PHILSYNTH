// koffi (electron/realtime.cjs: real-time priority for the PATCH instance workers) loads a native
// binary from its per-platform package @koromix/koffi-<platform>-<arch>. npm only installs the
// one for this machine, so the build scripts fetch the target's package when it is missing
// (cross builds: Windows from macOS/Linux, an Intel Mac app on Apple silicon).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const koffiPackage = (platform, arch) => `@koromix/koffi-${platform}-${arch}`;

export function ensureKoffi(platform, arch) {
  const name = koffiPackage(platform, arch);
  const dir = join(ROOT, 'node_modules', name);
  const { version } = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'koffi', 'package.json'), 'utf8'));
  if (existsSync(join(dir, 'package.json')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === version) return name;
  console.log(`Fetching ${name}@${version} (koffi binary for ${platform}-${arch})`);
  const tmp = mkdtempSync(join(tmpdir(), 'philsynth-koffi-'));
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const file = execFileSync(npm, ['pack', `${name}@${version}`, '--pack-destination', tmp, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xzf', join(tmp, file), '-C', dir, '--strip-components=1']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return name;
}
