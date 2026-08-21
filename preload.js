const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blt', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: s => ipcRenderer.invoke('save-settings', s),
  connectAccount: () => ipcRenderer.invoke('connect-account'),
  disconnectAccount: id => ipcRenderer.invoke('disconnect-account', id),
  setActiveAccount: id => ipcRenderer.invoke('set-active-account', id),
  testConnection: () => ipcRenderer.invoke('test-connection'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  listDrive: () => ipcRenderer.invoke('list-drive'),
  importLocal: (paths, opts) => ipcRenderer.invoke('import-local', paths, opts),
  importDrive: (fileId, opts) => ipcRenderer.invoke('import-drive', fileId, opts),
  explorerTree: () => ipcRenderer.invoke('explorer-tree'),
  diskMkdir: (name, parentId) => ipcRenderer.invoke('disk-mkdir', name, parentId),
  diskRename: (id, name) => ipcRenderer.invoke('disk-rename', id, name),
  diskMove: (id, parentId) => ipcRenderer.invoke('disk-move', id, parentId),
  diskDelete: id => ipcRenderer.invoke('disk-delete', id),
  diskShares: () => ipcRenderer.invoke('disk-shares'),
  diskSharedWithMe: () => ipcRenderer.invoke('disk-shared-with-me'),
  diskShareCreate: body => ipcRenderer.invoke('disk-share-create', body),
  diskShareDelete: id => ipcRenderer.invoke('disk-share-delete', id),
  diskDownload: (id, name) => ipcRenderer.invoke('disk-download', id, name),
  diskZip: (id, name) => ipcRenderer.invoke('disk-zip', id, name),
  diskOpenExternal: (id, name, extra) => ipcRenderer.invoke('disk-open-external', id, name, extra || {}),
  streamPort: () => { try { return ipcRenderer.sendSync('stream-port') || 0; } catch { return 0; } },
  previewUrl: id => {
    const p = ipcRenderer.sendSync('stream-port');
    if (p) return 'http://127.0.0.1:' + p + '/preview/' + encodeURIComponent(id);
    return 'bltdrive://preview/' + encodeURIComponent(id);
  },
  getAppVersion: () => ipcRenderer.invoke('app-get-version'),
  checkUpdate: () => ipcRenderer.invoke('app-check-update'),
  downloadUpdate: () => ipcRenderer.invoke('app-download-update'),
  quitInstall: () => ipcRenderer.invoke('app-quit-install'),
  onEvent: cb => { ipcRenderer.on('evt', (e, d) => cb(d)); },
  log: m => ipcRenderer.send('app-log', m)
});
