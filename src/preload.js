const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pathFor: (file) => webUtils.getPathForFile(file),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  transcribe: (args) => ipcRenderer.invoke('transcribe', args),
  exportAs: (args) => ipcRenderer.invoke('export', args),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
});
