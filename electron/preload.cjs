// Native project files for the page (CommonJS; uses only contextBridge + ipcRenderer).
// See the 'project:*' handlers in electron/main.mjs and src/projectfile.js.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('modsynthPreferences', {
  load: () => ipcRenderer.invoke('preferences:load'),
  save: (text) => ipcRenderer.invoke('preferences:save', text),
});

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
  // dialog: 'project-open' | 'project-save' | 'clip' | 'module' | 'scala' | 'audio' | 'sample' |
  // 'wavetable' | 'image' -> { dir, places, bookmarks }
  start: (dialog) => ipcRenderer.invoke('fs:start', dialog),
  addBookmark: (path) => ipcRenderer.invoke('fs:bookmarkAdd', path),
  removeBookmark: (path) => ipcRenderer.invoke('fs:bookmarkRemove', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  list: (dir, exts) => ipcRenderer.invoke('fs:list', dir, exts),
  target: (dir, name, ext) => ipcRenderer.invoke('fs:target', dir, name, ext),
  mkdir: (dir, name) => ipcRenderer.invoke('fs:mkdir', dir, name),
  transfer: (path, isDir, dir, move, name = null) => ipcRenderer.invoke('fs:transfer', path, isDir, dir, move, name),
  deleteEntry: (path, isDir) => ipcRenderer.invoke('fs:delete', path, isDir),
  // projects
  open: (path) => ipcRenderer.invoke('project:open', path),
  save: (ref, bytes) => ipcRenderer.invoke('project:save', ref, bytes),
  saveAs: (path, bytes) => ipcRenderer.invoke('project:saveAs', path, bytes),
  openProjectStream: (path) => ipcRenderer.invoke('project:streamOpen', path),
  readProjectStream: (id, at, length) => ipcRenderer.invoke('project:streamRead', id, at, length),
  closeProjectStream: (id) => ipcRenderer.invoke('project:streamClose', id),
  startProjectStream: (path, saveAs) => ipcRenderer.invoke('project:streamStart', path, saveAs),
  writeProjectStream: (id, bytes) => ipcRenderer.invoke('project:streamWrite', id, bytes),
  finishProjectStream: (id) => ipcRenderer.invoke('project:streamFinish', id),
  abortProjectStream: (id) => ipcRenderer.invoke('project:streamAbort', id),
  // clips / modules / Scala tunings (see src/filedialog.js); kind: 'clip' | 'module' | 'scala'
  saveFile: (kind, path, text) => ipcRenderer.invoke('file:save', kind, path, text),
  openFile: (kind, path) => ipcRenderer.invoke('file:open', kind, path),
  openModuleStream: (path) => ipcRenderer.invoke('module:streamOpen', path),
  startModuleStream: (path) => ipcRenderer.invoke('module:streamStart', path),
  // audio / pictures modules load; kind: 'sample' | 'wavetable' | 'image' -> { name, data }
  openBinary: (kind, path) => ipcRenderer.invoke('file:openBinary', kind, path),
  openAudioClipStream: (path) => ipcRenderer.invoke('audio-clip:streamOpen', path),
  readAudioClipStream: (id, at, length) => ipcRenderer.invoke('audio-clip:streamRead', id, at, length),
  closeAudioClipStream: (id) => ipcRenderer.invoke('audio-clip:streamClose', id),
  saveMidi: (path, data) => ipcRenderer.invoke('midi:save', path, data),
  // Export Audio: WAV bytes (ArrayBuffer)
  saveAudio: (path, data, id) => ipcRenderer.invoke('audio:save', path, data, id),
  cancelAudio: (id) => ipcRenderer.invoke('audio:cancel', id),
});
