const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getTasks: () => ipcRenderer.invoke('tasks:get'),
  op: (name, arg) => ipcRenderer.invoke('tasks:op', name, arg),
  togglePanel: () => ipcRenderer.send('panel:toggle'),
  hover: h => ipcRenderer.send('pet:hover', h),
  moveBy: (dx, dy) => ipcRenderer.send('pet:moveBy', dx, dy),
  menu: () => ipcRenderer.send('pet:menu'),
  onDir: cb => ipcRenderer.on('pet:dir', (_, d) => cb(d)),
  onChanged: cb => ipcRenderer.on('tasks:changed', cb),
});
