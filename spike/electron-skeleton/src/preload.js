const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('spike', {
  runPtyTest: () => ipcRenderer.invoke('run-pty-test'),
  onChildLog: (cb) => ipcRenderer.on('child-log', (_, text) => cb(text)),
  onChildEvent: (cb) => ipcRenderer.on('child-event', (_, msg) => cb(msg)),
})
