const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blt', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: s => ipcRenderer.invoke('save-settings', s),
  connectAccount: () => ipcRenderer.invoke('connect-account'),
  disconnectAccount: id => ipcRenderer.invoke('disconnect-account', id),
  setActiveAccount: id => ipcRenderer.invoke('set-active-account', id),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  pickVideos: () => ipcRenderer.invoke('pick-videos'),
  listDrive: () => ipcRenderer.invoke('list-drive'),
  importLocal: (paths, opts) => ipcRenderer.invoke('import-local', paths, opts),
  importDrive: (fileId, opts) => ipcRenderer.invoke('import-drive', fileId, opts),
  getAppVersion: () => ipcRenderer.invoke('app-get-version'),
  checkUpdate: () => ipcRenderer.invoke('app-check-update'),
  downloadUpdate: () => ipcRenderer.invoke('app-download-update'),
  quitInstall: () => ipcRenderer.invoke('app-quit-install'),
  onEvent: cb => { ipcRenderer.on('evt', (e, d) => cb(d)); },
  log: m => ipcRenderer.send('app-log', m)
});
