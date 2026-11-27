const { contextBridge, ipcRenderer } = require('electron');

// Tab bar of the desktop window (shell.html): dashboard + embedded Gemini/ChatGPT tabs.
contextBridge.exposeInMainWorld('webhubShell', {
  state: () => ipcRenderer.invoke('shell:state'),
  select: (id) => ipcRenderer.invoke('shell:select', id),
  open: (site, account) => ipcRenderer.invoke('shell:open', { site, account }),
  close: (id) => ipcRenderer.invoke('shell:close', id),
  onState: (cb) => ipcRenderer.on('shell:state', (_e, s) => cb(s)),
});
