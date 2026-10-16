// a™ — the local / assets app for Mac.
// A window on https://local-assets.com, so every deploy reaches the app at once. Google doesn't allow
// sign-in inside apps, so sign-in happens in the browser: the app opens it with the hash of a one-time
// secret, the browser hands back a code through localassets://signed-in, and the app swaps the code and
// its secret for the session (api/google-auth POST). Only the app that started the sign-in can finish it.
const { app, BrowserWindow, shell, ipcMain, Menu, net, nativeTheme, session } = require('electron')
const crypto = require('crypto')
const path = require('path')
const thisMac = require('./this-mac')

const SITE = 'https://local-assets.com'
const HOME = SITE + '/dashboard'
const SCHEME = 'localassets'

let win = null
let verifier = null          // the one-time secret of the sign-in in progress
let pendingLink = null       // a localassets:// link that arrived before the window was ready

const onSite = url => { try { return new URL(url).origin === SITE } catch { return false } }

// Every window of the app: only local-assets.com inside it; other sites open in the browser.
// Pages the site opens in a new tab (the video player, files) open as a pop-up window over the app,
// so the client never leaves it; Back or closing the pop-up returns to where they were.
function guard(wc) {
  const keepOnSite = (e, url, isMain = true) => {
    if (!isMain || onSite(url) || url.startsWith('file:')) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
  }
  wc.on('will-navigate', (e, url) => keepOnSite(e, url))
  // Redirects too (e.g. /api/google-auth → Google): Google sign-in never runs inside the app
  wc.on('will-redirect', (e, url, _inPage, isMain) => keepOnSite(e, url, isMain))
  wc.setWindowOpenHandler(({ url }) => {
    if (onSite(url)) {
      const parent = BrowserWindow.fromWebContents(wc)
      const [w, h] = parent ? parent.getSize() : [1280, 820]
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent, width: Math.round(w * 0.86), height: Math.round(h * 0.86), minWidth: 640, minHeight: 420,
        backgroundColor: '#070905', title: 'a™', show: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      } }
    }
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('did-create-window', child => guard(child.webContents))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'a™',
    backgroundColor: '#070905',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // Opens filling the screen (not macOS full screen, so the Dock and menu bar stay)
  win.once('ready-to-show', () => { win.maximize(); win.show() })

  // The window only shows local-assets.com; any other link opens in the browser
  guard(win.webContents)

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { retry: url || HOME } })
  })

  win.on('closed', () => { win = null })
  win.loadURL(HOME)
}

// Sign-in: open Google in the browser with the hash of a fresh one-time secret
ipcMain.handle('la:sign-in', e => {
  if (!fromSite(e)) return
  verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  shell.openExternal(`${SITE}/api/google-auth?mode=web&app=${challenge}`)
})

// This Mac (cameras and the mixer plugged into the computer): only pages of local-assets.com may use it
const fromSite = e => { try { return new URL(e.senderFrame.url).origin === SITE } catch { return false } }
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max)
ipcMain.handle('la:mac-state', (e, venue) => fromSite(e) ? thisMac.state(str(venue, 80)) : null)
ipcMain.handle('la:mac-link', (e, l) => {
  if (!fromSite(e) || !l) throw new Error('Not allowed')
  const key = str(l.key, 120)
  if (!/^[A-Za-z0-9-]{10,120}$/.test(key)) throw new Error('This slot has no stream key yet')
  const kind = l.kind === 'audio' ? 'audio' : 'camera'
  if (kind === 'camera' ? !l.video : !l.audio) throw new Error('Choose a device')
  const frame = l.frame && /^[a-z0-9-]{1,80}\.[A-Za-z0-9_-]{1,80}$/.test(String(l.frame.cam || '')) && /^[A-Za-z0-9_-]{20,100}$/.test(String(l.frame.pass || '')) ? { cam: String(l.frame.cam), pass: String(l.frame.pass) } : null
  thisMac.link({ venue: str(l.venue, 80), slotId: str(l.slotId, 80), slotName: str(l.slotName, 60), kind, video: str(l.video, 120), audio: str(l.audio, 120), key, frame })
  return thisMac.state(str(l.venue, 80))
})
ipcMain.handle('la:mac-preview', (e, venue, slotId) => fromSite(e) ? thisMac.preview(str(venue, 80), str(slotId, 80)) : null)
ipcMain.handle('la:mac-kick', e => { if (fromSite(e)) thisMac.kick() })
ipcMain.handle('la:mac-unlink', (e, venue, slotId) => {
  if (!fromSite(e)) throw new Error('Not allowed')
  thisMac.unlink(str(venue, 80), str(slotId, 80))
  return thisMac.state(str(venue, 80))
})

async function handleLink(url) {
  let u
  try { u = new URL(url) } catch { return }
  if (u.protocol !== SCHEME + ':' || u.hostname !== 'signed-in') return
  if (!win) createWindow()
  win.show(); win.focus()
  const code = u.searchParams.get('code') || ''
  if (!verifier) return showError('Press Continue with Google in this app to sign in.')
  const secret = verifier
  verifier = null
  try {
    const res = await net.fetch(SITE + '/api/google-auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, verifier: secret }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.session) return showError(data.error || 'Sign-in failed. Try again.')
    const s = data.session
    // Save the session as the website does, then open the dashboard
    if (!onSite(win.webContents.getURL())) await win.loadURL(SITE + '/login.html')
    await win.webContents.executeJavaScript(`(function (s) {
      localStorage.setItem('la_admin', JSON.stringify(s));
      if (s.venue && s.venue !== 'Admin') localStorage.setItem('la_venue_name', String(s.venue).toUpperCase()); else localStorage.removeItem('la_venue_name');
      localStorage.removeItem('la_revenue_cache_v2');
      location.replace('/dashboard');
    })(${JSON.stringify(s)})`)
  } catch {
    showError('Could not reach local / assets. Check your connection and try again.')
  }
}

function showError(msg) {
  if (!win) return
  const run = () => win.webContents.executeJavaScript(`(function (m) {
    var el = document.getElementById('status');
    if (el) { el.textContent = m; el.className = 'err'; } else alert(m);
  })(${JSON.stringify(msg)})`).catch(() => {})
  if (onSite(win.webContents.getURL())) run()
  else win.loadURL(SITE + '/login.html').then(run)
}

// Menu: the standard Mac menus, plus Reload and the website
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Dashboard', accelerator: 'Cmd+1', click: () => win && win.loadURL(HOME) },
      { label: 'Camera Control', accelerator: 'Cmd+2', click: () => win && win.loadURL(SITE + '/camera') },
      { label: 'Brand Kit', accelerator: 'Cmd+3', click: () => win && win.loadURL(SITE + '/brand') },
      { type: 'separator' },
      { label: 'Back', accelerator: 'Cmd+[', click: () => win && win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
      { label: 'Forward', accelerator: 'Cmd+]', click: () => win && win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
      { role: 'reload' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Open local-assets.com', click: () => shell.openExternal(SITE) },
      { label: 'Email support', click: () => shell.openExternal('mailto:info@local-assets.com') },
    ] },
  ]))
}

// One copy of the app at a time; a second launch (or a localassets:// link) goes to the first
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAsDefaultProtocolClient(SCHEME)
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (app.isReady()) handleLink(url); else pendingLink = url
  })
  app.on('second-instance', (_e, argv) => {
    const link = argv.find(a => a.startsWith(SCHEME + '://'))
    if (link) handleLink(link)
    else if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'      // a dark title bar, like the site
    // Camera and microphone (the live preview in Camera Control) only for local-assets.com; nothing else
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      cb(permission === 'media' && onSite(details.requestingUrl || wc.getURL()))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && origin === SITE)
    buildMenu()
    thisMac.init(() => { if (win && !win.isDestroyed()) win.webContents.send('la:mac-changed') })
    createWindow()
    if (pendingLink) { handleLink(pendingLink); pendingLink = null }
  })
  app.on('activate', () => { if (!win) createWindow(); else win.show() })
  app.on('before-quit', () => thisMac.stopAll())
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
