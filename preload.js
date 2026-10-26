const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  games: () => ipcRenderer.invoke('games'),
  cover: item => ipcRenderer.invoke('cover', item),
  launch: item => ipcRenderer.invoke('launch', item),
  add: () => ipcRenderer.invoke('add'),
  remove: id => ipcRenderer.invoke('remove', id),
  setCover: id => ipcRenderer.invoke('setCover', id),
  getCfg: () => ipcRenderer.invoke('getCfg'),
  setCfg: p => ipcRenderer.invoke('setCfg', p),
  hide: () => ipcRenderer.invoke('hide'),
  onEnter: cb => ipcRenderer.on('enter', cb),
  onLeave: cb => ipcRenderer.on('leave', cb),
  onStats: cb => ipcRenderer.on('stats', (e, s) => cb(s))
});
