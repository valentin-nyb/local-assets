// The sound page (audio-tap.html) hands its pieces of sound to the app
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('laTap', {
  ready: (rate, label) => ipcRenderer.send('la-tap', 'ready', rate, label),
  fail: message => ipcRenderer.send('la-tap', 'fail', String(message)),
  pcm: buffer => ipcRenderer.send('la-tap', 'pcm', buffer),
})
