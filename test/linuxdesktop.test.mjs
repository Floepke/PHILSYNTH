import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { desktopEntry, installDesktopEntry } from '../build-linux-desktop.mjs';

const root = await mkdtemp(join(tmpdir(), 'philsynth-desktop-'));
try {
  const source = join(root, 'icon.png');
  await writeFile(source, 'icon-v1');
  const image = join(root, 'Project with spaces', 'PHILSYNTH.AppImage');
  const launcher = await installDesktopEntry(image, source, { home: root, env: {}, refresh: false });
  assert.equal(launcher, join(root, '.local', 'share', 'applications', 'PHILSYNTH.desktop'));
  const icon = join(root, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'PHILSYNTH.png');
  assert.equal(await readFile(icon, 'utf8'), 'icon-v1');
  const text = await readFile(launcher, 'utf8');
  assert.ok(text.includes(`Exec="${image}"\n`));
  assert.ok(text.includes('Name=PHILSYNTH\n'));
  assert.ok(text.includes('StartupWMClass=PHILSYNTH\n'));
  assert.ok(text.includes(`Icon=${icon}\n`));
  assert.equal((await stat(launcher)).mode & 0o777, 0o644);
  await writeFile(source, 'icon-v2');
  assert.equal(await installDesktopEntry(image, source, { home: root, env: {}, refresh: false }), launcher);
  assert.equal(await readFile(icon, 'utf8'), 'icon-v2', 'rebuild refreshes the icon');

  const custom = join(root, 'custom data');
  assert.equal(await installDesktopEntry(image, source, {
    home: root, env: { XDG_DATA_HOME: custom }, refresh: false,
  }), join(custom, 'applications', 'PHILSYNTH.desktop'));
  assert.equal(await installDesktopEntry(image, source, {
    home: root, env: { XDG_DATA_HOME: 'relative' }, refresh: false,
  }), launcher, 'relative XDG_DATA_HOME is ignored per the XDG specification');
  assert.throws(() => desktopEntry('relative', icon), /absolute/);
  const special = desktopEntry('/a "quoted" $cash `tick` \\path%/app', '/icon\nnew.png');
  assert.equal(special.split('\n').find((line) => line.startsWith('Exec=')),
    'Exec="/a \\\\"quoted\\\\" \\\\$cash \\\\`tick\\\\` \\\\\\\\path%%/app"');
  assert.ok(special.includes('Icon=/icon\\nnew.png\n'), 'values cannot inject desktop entry fields');
  await assert.rejects(installDesktopEntry(image, join(root, 'missing'), {
    home: root, env: {}, refresh: false,
  }), /ENOENT/, 'installation errors are not hidden');
  assert.equal(await readFile(launcher, 'utf8'), text, 'failed icon copy preserves the launcher');
  if (process.platform === 'linux') {
    try {
      await promisify(execFile)('desktop-file-validate', [launcher]);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.warn('desktop-file-validate is unavailable; skipping external validation.');
    }
    const executable = join(root, 'PHILSYNTH with spaces.AppImage');
    const marker = join(root, 'launched');
    await writeFile(executable, '#!/bin/sh\nprintf launched > "$PHILSYNTH_LAUNCH_TEST_RESULT"\n', { mode: 0o755 });
    const launchTest = join(root, 'launch-test.desktop');
    await writeFile(launchTest, desktopEntry(executable, icon));
    try {
      await promisify(execFile)('gio', ['launch', launchTest], {
        env: { ...process.env, PHILSYNTH_LAUNCH_TEST_RESULT: marker }, timeout: 10000,
      });
      assert.equal(await readFile(marker, 'utf8'), 'launched', 'Linux launches the exact escaped executable path');
    } catch (err) {
      if (err.code !== 'ENOENT' || err.syscall !== 'spawn gio') throw err;
      console.warn('gio is unavailable; skipping external launch validation.');
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('Linux desktop launcher tests passed');
