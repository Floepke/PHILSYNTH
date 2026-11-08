import { execFile } from 'node:child_process';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const escapeValue = (value) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');

export function desktopEntry(image, icon) {
  if (!isAbsolute(image) || !isAbsolute(icon)) throw new Error('Desktop launcher paths must be absolute');
  // Exec has a second escaping layer after desktop-entry string decoding; %% is a literal %.
  const executable = escapeValue(image.replace(/%/g, '%%').replace(/["`$\\]/g, '\\$&'));
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=PHILSYNTH',
    'Comment=Modular synthesizer',
    `Exec="${executable}"`,
    `Icon=${escapeValue(icon)}`,
    'Terminal=false',
    'Categories=AudioVideo;Audio;',
    'Keywords=synthesizer;synth;MIDI;music;',
    'StartupWMClass=PHILSYNTH',
    '',
  ].join('\n');
}

async function replaceFile(path, write) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await write(temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function installDesktopEntry(image, sourceIcon, {
  home = homedir(), env = process.env, refresh = true,
} = {}) {
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  const applications = join(data, 'applications');
  const launcher = join(applications, 'PHILSYNTH.desktop');
  const icon = join(data, 'icons', 'hicolor', '512x512', 'apps', 'PHILSYNTH.png');
  const text = desktopEntry(image, icon);
  await replaceFile(icon, (temporary) => copyFile(sourceIcon, temporary));
  await replaceFile(launcher, (temporary) => writeFile(temporary, text, { mode: 0o644 }));
  if (refresh) {
    try {
      await run('update-desktop-database', [applications], { timeout: 10000 });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.warn('update-desktop-database is unavailable; the desktop environment will discover the launcher automatically.');
    }
  }
  return launcher;
}
