import { ipcMain } from 'electron';

export function registerExit(app, win, local) {
  let approved = false;
  let ready = false;
  let requested = false;
  const trusted = (event) => event.sender === win.webContents && local(event.senderFrame?.url);
  const request = () => {
    requested = true;
    if (ready) win.webContents.send('exit:request');
  };
  const onReady = (event) => {
    if (!trusted(event)) return;
    ready = true;
    if (requested) request();
  };
  const onConfirm = (event) => {
    if (!trusted(event)) return;
    approved = true;
    app.quit();
  };
  const beforeQuit = (event) => {
    if (approved) return;
    event.preventDefault();
    request();
  };
  win.on('close', (event) => {
    if (approved) return;
    event.preventDefault();
    request();
  });
  win.webContents.on('did-start-loading', () => { ready = false; });
  app.on('before-quit', beforeQuit);
  ipcMain.on('exit:ready', onReady);
  ipcMain.on('exit:confirm', onConfirm);
  win.once('closed', () => {
    app.removeListener('before-quit', beforeQuit);
    ipcMain.removeListener('exit:ready', onReady);
    ipcMain.removeListener('exit:confirm', onConfirm);
  });
  return { isApproved: () => approved };
}
