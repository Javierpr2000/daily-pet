const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTasks: () => ipcRenderer.invoke('tasks:get'),
  op: (name, arg) => ipcRenderer.invoke('tasks:op', name, arg),
  getReminder: () => ipcRenderer.invoke('reminder:get'),
  setReminder: t => ipcRenderer.invoke('reminder:set', t),
  togglePanel: () => ipcRenderer.send('panel:toggle'),
  openEditor: id => ipcRenderer.send('editor:open', id),
  hover: h => ipcRenderer.send('pet:hover', h),
  moveBy: (dx, dy) => ipcRenderer.send('pet:moveBy', dx, dy),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  menu: () => ipcRenderer.send('pet:menu'),
  onDir: cb => ipcRenderer.on('pet:dir', (_, d) => cb(d)),
  onProgress: cb => ipcRenderer.on('pet:progress', (_, done, total) => cb(done, total)),
  onChanged: cb => ipcRenderer.on('tasks:changed', cb),
});
