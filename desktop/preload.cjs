const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webhubDesktop', {
  retryConnect: () => ipcRenderer.invoke('desktop:retry-connect'),
  startAndReconnect: () => ipcRenderer.invoke('desktop:start-and-reconnect'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  showBrowser: () => ipcRenderer.invoke('desktop:show-browser'),
});
