const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendAudioChunk: (requestId, data) => ipcRenderer.send('music-audio-chunk', requestId, data),
  sendAudioEnd: (requestId) => ipcRenderer.send('music-audio-end', requestId),
  sendAudioError: (requestId, error) => ipcRenderer.send('music-audio-error', requestId, error),
  sendAudioLog: (msg) => ipcRenderer.send('music-audio-log', msg),
});
