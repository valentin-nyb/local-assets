const { app, BrowserWindow, session, shell } = require('electron')
const path = require('path')

const DASHBOARD_URL  = 'https://local-assets.com/dashboard'
const SITE_ORIGIN    = 'https://local-assets.com'
const SESSION_COOKIE = 'la_session'

let mainWindow = null

// ── Deep-link handler ─────────────────────────────────────────────────────────
async function handleDeepLink(url) {
  try {
    const parsed = new URL(url)

    // localassets://verified?session=TOKEN  — Google OAuth success
    if (parsed.hostname === 'verified') {
      const sessionToken = parsed.searchParams.get('session')
      if (!sessionToken) return
      await setSessionCookie(sessionToken)
      if (mainWindow) {
        mainWindow.show()
        mainWindow.loadURL(DASHBOARD_URL)
      }
      return
    }

    // localassets://auth-error?reason=...  — Google OAuth failure
    if (parsed.hostname === 'auth-error') {
      const reason = parsed.searchParams.get('reason')
      const msg = reason === 'not-a-client'
        ? 'This Google account is not registered. Contact local / assets for access.'
        : 'Sign-in was cancelled.'
      if (mainWindow) {
        mainWindow.show()
        mainWindow.webContents.executeJavaScript(
          `showError(${JSON.stringify(msg)})`
        )
      }
    }
  } catch (err) {
    console.error('Deep-link error:', err)
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────
function setSessionCookie(sessionToken) {
  const expirationDate = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  return session.defaultSession.cookies.set({
    url:            SITE_ORIGIN,
    name:           SESSION_COOKIE,
    value:          sessionToken,
    httpOnly:       true,
    secure:         true,
    sameSite:       'lax',
    expirationDate,
  })
}

async function getSessionCookie() {
  const cookies = await session.defaultSession.cookies.get({
    url:  SITE_ORIGIN,
    name: SESSION_COOKIE,
  })
  return cookies.length > 0 ? cookies[0].value : null
}

// ── Window ────────────────────────────────────────────────────────────────────
async function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0d0d',
    icon: path.join(__dirname, 'build', 'icons', 'icon.icns'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  })

  // Re-enforce fullscreen if the user escapes via Escape key
  mainWindow.on('leave-full-screen', () => mainWindow.setFullScreen(true))

  // Suppress Electron user-agent fingerprint
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    callback({ requestHeaders: details.requestHeaders })
  })

  // Open all window.open() / target=_blank calls in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  const cookie = await getSessionCookie()
  if (cookie) {
    mainWindow.loadURL(DASHBOARD_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, 'login.html'))
  }
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.setAsDefaultProtocolClient('localassets')

// macOS: deep link that arrives before the app is ready
app.on('open-url', (event, url) => {
  event.preventDefault()
  app._pendingDeepLink = url
})

app.whenReady().then(async () => {
  await createWindow()

  if (app._pendingDeepLink) {
    handleDeepLink(app._pendingDeepLink)
    app._pendingDeepLink = null
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // macOS: deep link while the app is already open
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
