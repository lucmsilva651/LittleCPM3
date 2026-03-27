const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pm3', {
  read:   ()             => ipcRenderer.invoke('pm3:read'),
  write:  (content, idx, total) => ipcRenderer.invoke('pm3:write', content, idx, total),
  wipe:   ()             => ipcRenderer.invoke('pm3:wipe'),
  split:  (content)      => ipcRenderer.invoke('pm3:split', content),
  onLog:  (cb)           => {
    const handler = (_, msg) => cb(msg);
    ipcRenderer.on('pm3:log', handler);
    return () => ipcRenderer.removeListener('pm3:log', handler);
  }
});
