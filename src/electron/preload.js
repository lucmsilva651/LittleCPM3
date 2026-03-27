const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pm3', {
  read:   ()             => ipcRenderer.invoke('pm3:read'),
  write:  (content, idx, total) => ipcRenderer.invoke('pm3:write', content, idx, total),
  wipe:   ()             => ipcRenderer.invoke('pm3:wipe'),
  split:  (content)      => ipcRenderer.invoke('pm3:split', content),

  // Continuous scan control
  startScan: ()          => ipcRenderer.invoke('pm3:startScan'),
  stopScan:  ()          => ipcRenderer.invoke('pm3:stopScan'),

  onLog:  (cb)           => {
    const handler = (_, msg) => cb(msg);
    ipcRenderer.on('pm3:log', handler);
    return () => ipcRenderer.removeListener('pm3:log', handler);
  },

  // Continuous scan events from the main process
  onScanStatus: (cb) => {
    const handler = (_, status) => cb(status);
    ipcRenderer.on('scan:status', handler);
    return () => ipcRenderer.removeListener('scan:status', handler);
  },
  onScanResult: (cb) => {
    const handler = (_, result) => cb(result);
    ipcRenderer.on('scan:result', handler);
    return () => ipcRenderer.removeListener('scan:result', handler);
  }
});

contextBridge.exposeInMainWorld('slint', {
  // Ask the main process to compile and run a Slint component
  run:   (code) => ipcRenderer.invoke('slint:run', code),
  // Close the currently running Slint component window
  close: ()     => ipcRenderer.invoke('slint:close'),

  // Listen for Slint status updates (running / error / closed)
  onStatus: (cb) => {
    const handler = (_, status) => cb(status);
    ipcRenderer.on('slint:status', handler);
    return () => ipcRenderer.removeListener('slint:status', handler);
  }
});

