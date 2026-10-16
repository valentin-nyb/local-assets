// What the website can ask of the app: start Google sign-in in the browser, and use the cameras and
// the mixer plugged into this Mac (Camera Control → This Mac)
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('laApp', {
  signIn: () => ipcRenderer.invoke('la:sign-in'),
  mac: {
    state: venue => ipcRenderer.invoke('la:mac-state', venue),
    link: l => ipcRenderer.invoke('la:mac-link', l),
    unlink: (venue, slotId) => ipcRenderer.invoke('la:mac-unlink', venue, slotId),
    onChange: cb => { ipcRenderer.on('la:mac-changed', () => cb()) },
  },
})
