const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFile: (callback) => ipcRenderer.on('open-file', (_event, file) => callback(file)),
  onRequestExport: (callback) => ipcRenderer.on('request-export', callback),
  savePdf: (bytes) => ipcRenderer.invoke('save-pdf', bytes)
});
