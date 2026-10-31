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

contextBridge.exposeInMainWorld('modsynthFiles', {
  open: () => ipcRenderer.invoke('project:open'),
  save: (ref, text) => ipcRenderer.invoke('project:save', ref, text),
  saveAs: (name, text) => ipcRenderer.invoke('project:saveAs', name, text),
});
