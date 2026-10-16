// This Mac: cameras and the mixer plugged into the computer, streamed straight to their Camera Control
// slots by the app's own ffmpeg, so no OBS is needed.
// - Devices are found with AVFoundation (polled, so plugging in or out shows within seconds).
// - Each link (a Camera Control slot ← a device on this Mac) streams to that slot's Mux live stream.
//   Outside a set the calendar keeps the stream closed, so Mux refuses the connection: the link waits
//   and tries again until the set opens it, then records, exactly as an OBSBOT left on all night.
// - Stream keys are kept only encrypted by the macOS Keychain (safeStorage) and never written to logs.
const { app, safeStorage, powerSaveBlocker, systemPreferences } = require('electron')
const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const FFMPEG = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, 'vendor', process.arch, 'ffmpeg')
const INGEST = 'rtmps://global-live.mux.com:443/app/'
const POLL_MS = 4000
const RETRY_WAITING_MS = 20000      // the slot is closed (no set on): try again in 20 s
const RETRY_DROPPED_MS = 3000       // it was sending and stopped: reconnect quickly
const VIDEO_MODES = [['1920x1080', '30'], ['1280x720', '30'], [null, '30'], [null, null]]

const configFile = () => path.join(app.getPath('userData'), 'this-mac.json')
let devices = { video: [], audio: [] }
let links = {}          // id → { venue, slotId, slotName, kind, video, audio, key (sealed) }
const runs = {}         // id → { proc, state, detail, timer, mode, x264, sentAt }
let notify = () => {}
let blocker = null

// ── Storage ──────────────────────────────────────────────────────────────────
function load() {
  try { links = JSON.parse(fs.readFileSync(configFile(), 'utf8')).links || {} } catch { links = {} }
}
function save() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify({ links }, null, 2), { mode: 0o600 })
}
const seal = key => safeStorage.encryptString(key).toString('base64')
const open = sealed => { try { return safeStorage.decryptString(Buffer.from(sealed, 'base64')) } catch { return '' } }

// ── Devices ──────────────────────────────────────────────────────────────────
function listDevices() {
  return new Promise(resolve => {
    execFile(FFMPEG, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 8000 }, (_err, _out, err) => {
      const out = { video: [], audio: [] }
      let section = null
      for (const line of String(err).split('\n')) {
        if (/AVFoundation video devices/.test(line)) section = 'video'
        else if (/AVFoundation audio devices/.test(line)) section = 'audio'
        else {
          const m = section && line.match(/\]\s\[(\d+)\]\s(.+)$/)
          if (m && !/^Capture screen/.test(m[2])) out[section].push({ index: m[1], name: m[2].trim() })
        }
      }
      resolve(out)
    })
  })
}
const indexOf = (kind, name) => (devices[kind].find(d => d.name === name) || {}).index

// ── Permissions (asked once by macOS) ────────────────────────────────────────
async function allowed(link) {
  const need = []
  if (link.video) need.push('camera')
  if (link.audio) need.push('microphone')
  for (const m of need) {
    const s = systemPreferences.getMediaAccessStatus(m)
    if (s === 'granted') continue
    if (s === 'not-determined' && await systemPreferences.askForMediaAccess(m)) continue
    return m
  }
  return null
}

// ── Streaming ────────────────────────────────────────────────────────────────
function argsFor(link, key, run) {
  const out = ['-f', 'flv', INGEST + key]
  const audioOut = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2']
  if (link.kind === 'audio') {
    // Decks: the mixer's sound with a still black picture (the platform keeps the sound as the set's HQ audio)
    return ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-re', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10',
      '-f', 'avfoundation', '-i', ':' + indexOf('audio', link.audio),
      '-map', '0:v', '-map', '1:a',
      ...(run.x264 ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage'] : ['-c:v', 'h264_videotoolbox', '-realtime', '1']),
      '-b:v', '300k', '-g', '20', '-pix_fmt', 'yuv420p', ...audioOut, ...out]
  }
  const [size, fps] = VIDEO_MODES[run.mode] || VIDEO_MODES[VIDEO_MODES.length - 1]
  const a = link.audio ? indexOf('audio', link.audio) : 'none'
  return ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
    '-f', 'avfoundation', ...(fps ? ['-framerate', fps] : []), ...(size ? ['-video_size', size] : []),
    '-i', indexOf('video', link.video) + ':' + (a == null ? 'none' : a),
    ...(run.x264 ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'] : ['-c:v', 'h264_videotoolbox', '-realtime', '1']),
    '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-g', '60', '-pix_fmt', 'yuv420p',
    ...(link.audio ? audioOut : []), ...out]
}

function setState(id, state, detail = '') {
  const run = runs[id]
  if (!run || (run.state === state && run.detail === detail)) return
  run.state = state; run.detail = detail
  awake(); notify()
}

function later(id, ms) {
  const run = runs[id]
  clearTimeout(run.timer)
  run.timer = setTimeout(() => start(id), ms)
}

async function start(id) {
  const link = links[id], run = runs[id]
  if (!link || !run || run.proc) return
  const missing = (link.video && indexOf('video', link.video) == null) ? link.video
    : (link.audio && indexOf('audio', link.audio) == null) ? link.audio : null
  if (missing) return setState(id, 'missing', missing)
  const blocked = await allowed(link)
  if (blocked) { setState(id, 'blocked', blocked); return later(id, RETRY_WAITING_MS) }
  const key = open(link.key)
  if (!key) return setState(id, 'error', 'Link this slot again')

  setState(id, 'starting')
  const proc = spawn(FFMPEG, argsFor(link, key, run), { stdio: ['ignore', 'pipe', 'pipe'] })
  run.proc = proc
  let errText = ''
  proc.stdout.on('data', d => {
    if (/total_size=[1-9]/.test(d)) { run.sentAt = Date.now(); setState(id, 'sending') }
  })
  proc.stderr.on('data', d => { errText = (errText + d).slice(-4000).split(key).join('KEY') })
  proc.on('exit', () => {
    run.proc = null
    if (!links[id]) return
    const wasSending = run.state === 'sending'
    if (/videotoolbox/i.test(errText) && !run.x264) { run.x264 = true; return later(id, 500) }
    if (/(video size|framerate|pixel format).*not supported|Selected (video size|framerate)/i.test(errText) && run.mode < VIDEO_MODES.length - 1) { run.mode++; return later(id, 500) }
    if (wasSending) { setState(id, 'starting', 'Reconnecting'); return later(id, RETRY_DROPPED_MS) }
    if (/Input\/output error|Connection refused|Broken pipe|Server returned|Operation timed out|End of file|Connection reset/i.test(errText) || !errText) {
      setState(id, 'waiting'); return later(id, RETRY_WAITING_MS)
    }
    console.error('[this-mac]', link.slotName, errText.split('\n').filter(Boolean).slice(-2).join(' | '))
    setState(id, 'error', 'Could not open the device')
    later(id, RETRY_WAITING_MS)
  })
}

function stop(id) {
  const run = runs[id]
  if (!run) return
  clearTimeout(run.timer)
  if (run.proc) { run.proc.removeAllListeners('exit'); run.proc.kill('SIGINT') }
  delete runs[id]
}

// Keep the Mac from sleeping the app while something is linked, and open the app at login
function awake() {
  const any = Object.keys(links).length > 0
  if (any && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension')
  if (!any && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null }
  if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== any) app.setLoginItemSettings({ openAtLogin: any })
}

function sync() {
  for (const id of Object.keys(runs)) if (!links[id]) stop(id)
  for (const id of Object.keys(links)) {
    if (runs[id]) continue
    runs[id] = { proc: null, state: 'starting', detail: '', timer: null, mode: 0, x264: false }
    start(id)
  }
  awake()
}

// ── Public API (used by main.js) ─────────────────────────────────────────────
async function poll() {
  const next = await listDevices()
  const changed = JSON.stringify(next) !== JSON.stringify(devices)
  devices = next
  if (changed) {
    for (const id of Object.keys(runs)) {
      const l = links[id], r = runs[id]
      const gone = (l.video && indexOf('video', l.video) == null) || (l.audio && indexOf('audio', l.audio) == null)
      if (gone && r.proc) { r.proc.kill('SIGINT') } else if (!gone && r.state === 'missing') { r.state = 'starting'; start(id) }
    }
    notify()
  }
}

function init(onChange) {
  notify = onChange
  load()
  poll().then(sync)
  setInterval(() => poll().catch(() => {}), POLL_MS)
}

function state(venue) {
  const out = {}
  for (const [id, l] of Object.entries(links)) {
    if (venue && l.venue !== venue) continue
    const r = runs[id] || {}
    out[l.slotId] = { video: l.video || '', audio: l.audio || '', kind: l.kind, state: r.state || 'starting', detail: r.detail || '' }
  }
  return { devices: { video: devices.video.map(d => d.name), audio: devices.audio.map(d => d.name) }, links: out }
}

function link({ venue, slotId, slotName, kind, video, audio, key }) {
  const id = venue + '/' + slotId
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac can\'t keep the stream key safely')
  stop(id)
  links[id] = { venue, slotId, slotName, kind, video: kind === 'audio' ? '' : video, audio, key: seal(key) }
  save(); sync(); notify()
}

function unlink(venue, slotId) {
  const id = venue + '/' + slotId
  stop(id)
  delete links[id]
  save(); awake(); notify()
}

function stopAll() { for (const id of Object.keys(runs)) stop(id) }

module.exports = { init, state, link, unlink, stopAll }
