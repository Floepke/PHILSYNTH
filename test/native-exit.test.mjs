// Run on Linux: xvfb-run -a node_modules/.bin/electron test/native-exit.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { registerExit } from '../electron/exit.mjs';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: fileURLToPath(new URL('../electron/preload.cjs', import.meta.url)),
    },
  });
  const exit = registerExit(app, win, (url) => url.startsWith('data:text/html,'));
  const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
  try {
    await win.loadURL('data:text/html,<h1>Exit test</h1>');
    win.close();
    assert.equal(win.isDestroyed(), false, 'window close is blocked before renderer readiness');
    await win.webContents.executeJavaScript('window.requests = 0; window.modsynthExit.onRequest(() => window.requests++);');
    await wait();
    assert.equal(await win.webContents.executeJavaScript('window.requests'), 1, 'queued close reaches renderer');
    win.close();
    await wait();
    assert.equal(await win.webContents.executeJavaScript('window.requests'), 2, 'window manager close requests confirmation');
    app.quit();
    await wait();
    assert.equal(win.isDestroyed(), false, 'app quit is blocked until approved');
    assert.equal(await win.webContents.executeJavaScript('window.requests'), 3, 'Cmd/Ctrl+Q quit requests confirmation');
    ipcMain.emit('exit:confirm', { sender: win.webContents, senderFrame: { url: 'https://untrusted.invalid/' } });
    assert.equal(exit.isApproved(), false, 'untrusted frames cannot approve exit');
    app.once('before-quit', () => {
      assert.equal(exit.isApproved(), true);
      console.log('native exit tests passed: close and quit require renderer approval');
    });
    await win.webContents.executeJavaScript('window.modsynthExit.confirm();');
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
