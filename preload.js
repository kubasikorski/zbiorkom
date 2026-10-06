// Bezpieczny most między interfejsem a procesem głównym.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zb', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onGoto: (cb) => ipcRenderer.on('goto', (_e, tab) => cb(tab)),
  refresh: () => ipcRenderer.invoke('refresh'),
  loadMore: () => ipcRenderer.invoke('load-more'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
});
