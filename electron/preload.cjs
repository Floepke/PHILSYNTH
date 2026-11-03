// Native project files for the page (sandboxed preload: CommonJS, only contextBridge + ipcRenderer).
// See the 'project:*' handlers in electron/main.mjs and src/projectfile.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modsynthExit', {
  onRequest: (callback) => {
    ipcRenderer.on('exit:request', () => callback());
    ipcRenderer.send('exit:ready');
  },
  confirm: () => ipcRenderer.send('exit:confirm'),
});

// Files go through the app's own file dialog (src/filepicker.js): it browses with list/target/
// mkdir and passes the chosen path to the open / save calls (electron/projectfiles.mjs).
contextBridge.exposeInMainWorld('modsynthFiles', {
  // dialog: 'project-open' | 'project-save' | 'clip' | 'module' | 'audio' -> { dir, places }
  start: (dialog) => ipcRenderer.invoke('fs:start', dialog),
  list: (dir, exts) => ipcRenderer.invoke('fs:list', dir, exts),
  target: (dir, name, ext) => ipcRenderer.invoke('fs:target', dir, name, ext),
  mkdir: (dir, name) => ipcRenderer.invoke('fs:mkdir', dir, name),
  // projects
  open: (path) => ipcRenderer.invoke('project:open', path),
  save: (ref, text) => ipcRenderer.invoke('project:save', ref, text),
  saveAs: (path, text) => ipcRenderer.invoke('project:saveAs', path, text),
  // clips / modules (see src/filedialog.js); kind: 'clip' | 'module'
  saveFile: (kind, path, text) => ipcRenderer.invoke('file:save', kind, path, text),
  openFile: (kind, path) => ipcRenderer.invoke('file:open', kind, path),
  // Export Audio: WAV bytes (ArrayBuffer)
  saveAudio: (path, data) => ipcRenderer.invoke('audio:save', path, data),
});
