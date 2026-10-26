const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  games: () => ipcRenderer.invoke('games'),
  cover: item => ipcRenderer.invoke('cover', item),
  launch: item => ipcRenderer.invoke('launch', item),
  add: () => ipcRenderer.invoke('add'),
  remove: id => ipcRenderer.invoke('remove', id),
  setCover: id => ipcRenderer.invoke('setCover', id),
  getKey: () => ipcRenderer.invoke('getKey'),
  setKey: k => ipcRenderer.invoke('setKey', k),
  hide: () => ipcRenderer.invoke('hide'),
  onEnter: cb => ipcRenderer.on('enter', cb)
});
