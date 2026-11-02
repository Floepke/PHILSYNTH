// KDE's file dialogs (shown for Electron through xdg-desktop-portal-kde) keep folder listings
// cached. On folders whose file system sends no change notifications (FUSE mounts such as
// pCloud) new files only show up after F5. KIO reloads a cached folder when the session bus
// carries org.kde.KDirNotify.FilesAdded for it, the signal KDE apps send after creating files,
// so we send it before a dialog opens and after we save. Linux only, best effort.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function kdirNotifyArgs(dir) {
  return ['--session', '--type=signal', '/', 'org.kde.KDirNotify.FilesAdded', `string:${pathToFileURL(dir).href}`];
}

// resolves when the signal is on the bus (or failed: no dbus-send, no session bus, not Linux)
export function notifyFolderChanged(dir, { platform = process.platform, run = execFile } = {}) {
  if (platform !== 'linux' || !dir) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      run('dbus-send', kdirNotifyArgs(dir), { timeout: 1000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}
