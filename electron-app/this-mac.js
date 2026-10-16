// This Mac: cameras and the mixer plugged into the computer, streamed straight to their Camera Control
// slots by the app's own ffmpeg, so no OBS is needed.
// - Devices are found with AVFoundation (polled, so plugging in or out shows within seconds).
// - Each link (a Camera Control slot ← a device on this Mac) streams to that slot's Mux live stream.
//   Outside a set the calendar keeps the stream closed, so Mux refuses the connection: the link waits
//   and tries again until the set opens it, then records, exactly as an OBSBOT left on all night.
// - Stream keys are kept only encrypted by the macOS Keychain (safeStorage) and never written to logs.
const { app, safeStorage, powerSaveBlocker, systemPreferences, net } = require('electron')
const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const FFMPEG = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, 'vendor', process.arch, 'ffmpeg')
const net_ = require('net'), tls = require('tls')
// RTMPS without ffmpeg's own TLS (the bundled build uses macOS SecureTransport, which stalls on long
// uploads): ffmpeg sends plain RTMP to a relay on this Mac (127.0.0.1 only), and the app carries it to
// Mux inside TLS with Node's OpenSSL. The stream key only ever leaves this Mac encrypted.
const MUX_HOST = 'global-live.mux.com'
let relayPort = 0
const relayReady = new Promise(resolve => {
  const server = net_.createServer(local => {
    local.setNoDelay(true)
    const remote = tls.connect({ host: MUX_HOST, port: 443, servername: MUX_HOST })
    remote.setNoDelay(true)
    local.pipe(remote); remote.pipe(local)
    const end = () => { local.destroy(); remote.destroy() }
    local.on('error', end); remote.on('error', end); local.on('close', end); remote.on('close', end)
  })
  server.listen(0, '127.0.0.1', () => { relayPort = server.address().port; resolve() })
})
const ingest = () => `rtmp://127.0.0.1:${relayPort}/app/`
const POLL_MS = 4000
const RETRY_WAITING_MS = 20000      // the slot is closed (no set on): try again in 20 s
const RETRY_DROPPED_MS = 3000       // it was sending and stopped: reconnect quickly
const VIDEO_MODES = [['1920x1080', '30'], ['1280x720', '30'], [null, '30'], [null, null]]

const configFile = () => path.join(app.getPath('userData'), 'this-mac.json')
// A short log for support (keys are never in it): ~/Library/Application Support/a™/this-mac.log
function log(line) {
  try {
    const f = path.join(app.getPath('userData'), 'this-mac.log')
    try { if (fs.statSync(f).size > 512e3) fs.renameSync(f, f + '.1') } catch {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}
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
  const out = ['-rtmp_tcurl', `rtmps://${MUX_HOST}:443/app`, '-f', 'flv', ingest() + key]
  const audioOut = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2']
  if (link.kind === 'audio') {
    // Decks: the mixer's sound with a still black picture (the platform keeps the sound as the set's HQ audio)
    return ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
      '-re', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10',
      '-f', 'avfoundation', '-i', ':' + indexOf('audio', link.audio),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-b:v', '300k', '-maxrate', '300k', '-bufsize', '600k', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', ...audioOut, ...out]
  }
  const [size, fps] = run.picked || VIDEO_MODES[run.mode] || VIDEO_MODES[VIDEO_MODES.length - 1]
  const a = link.audio ? indexOf('audio', link.audio) : null
  return ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', '-y',
    '-f', 'avfoundation', ...(fps ? ['-framerate', fps] : []), ...(size ? ['-video_size', size] : []),
    '-i', indexOf('video', link.video) + ':' + (a == null ? 'none' : a),
    // Mux drops a live stream that has no sound, so "No sound" sends a silent track
    ...(a == null ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
    '-map', '0:v', '-map', a == null ? '1:a' : '0:a',
    // x264 as OBS sends it (Mux hung up on the Mac's hardware encoder after ~15 s): steady bitrate,
    // a keyframe every 2 s, no B-frames
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
    '-b:v', '4500k', '-maxrate', '4500k', '-bufsize', '9000k', '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    ...audioOut, ...out,
    // What the camera sees, for Camera Control (two small frames a second)
    ...previewOut()]
}

// ── Preview: the camera's picture in Camera Control, from the app's own capture ──
// A camera can often be used by one app at a time (an iPhone always), so the page can't open it itself.
// While streaming, the stream also writes a small frame twice a second; between sets a light preview does.
const previewOut = () => ['-map', '0:v', '-an', '-vf', 'fps=12,scale=640:-2', '-q:v', '7', '-f', 'mjpeg', 'pipe:3']
// The newest frame of each camera, read from ffmpeg's preview pipe (JPEGs one after another)
const frames = {}
function readFrames(id, stream) {
  let buf = Buffer.alloc(0)
  stream.on('data', d => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]))
      if (start < 0) { buf = Buffer.alloc(0); return }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
      if (end < 0) { if (start > 0) buf = buf.subarray(start); if (buf.length > 4e6) buf = Buffer.alloc(0); return }
      frames[id] = { jpg: buf.subarray(start, end + 2), at: Date.now() }
      buf = buf.subarray(end + 2)
    }
  })
}

function startPreview(id) {
  const link = links[id], run = runs[id]
  if (!link || !run || run.proc || run.preview || link.kind === 'audio') return
  if (indexOf('video', link.video) == null || systemPreferences.getMediaAccessStatus('camera') !== 'granted') return
  const [size, fps] = run.picked || VIDEO_MODES[run.mode] || VIDEO_MODES[VIDEO_MODES.length - 1]
  const proc = spawn(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-y',
    '-f', 'avfoundation', ...(fps ? ['-framerate', fps] : []), ...(size ? ['-video_size', size] : []),
    '-i', indexOf('video', link.video) + ':none', ...previewOut()], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  readFrames(id, proc.stdio[3])
  run.preview = proc
  proc.on('exit', () => { if (run.preview === proc) run.preview = null })
}
function stopPreview(run) {
  if (!run || !run.preview) return Promise.resolve()
  const p = run.preview; run.preview = null
  return new Promise(r => { p.once('exit', r); p.kill('SIGINT'); setTimeout(r, 1500) })
}
function preview(venue, slotId) {
  const f = frames[venue + '/' + slotId]
  return f && Date.now() - f.at < 3000 ? f.jpg : null
}

function setState(id, state, detail = '') {
  const run = runs[id]
  if (!run || (run.state === state && run.detail === detail)) return
  run.state = state; run.detail = detail
  awake(); notify()
}

function later(id, ms) {
  const run = runs[id]
  if (!run) return
  clearTimeout(run.timer)
  run.timer = setTimeout(() => start(id), ms)
  if (ms >= 3000) setTimeout(() => startPreview(id), 400)
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
  await relayReady
  await stopPreview(run)
  if (run.proc || !links[id]) return
  run.startedAt = Date.now(); run.sentAt = 0
  const proc = spawn(FFMPEG, argsFor(link, key, run), { stdio: ['ignore', 'pipe', 'pipe', link.kind === 'audio' ? 'ignore' : 'pipe'] })
  if (link.kind !== 'audio') readFrames(id, proc.stdio[3])
  run.proc = proc
  let errText = ''
  let lastSize = 0, frames = 0
  proc.stdout.on('data', d => {
    const t = String(d), m = t.match(/total_size=(\d+)/g), f = t.match(/frame=(\d+)/g)
    if (f) frames = Number(f[f.length - 1].split('=')[1])
    const size = m ? Number(m[m.length - 1].split('=')[1]) : lastSize
    if (size > lastSize) { lastSize = size; run.sentAt = Date.now(); setState(id, 'sending') }
  })
  // No picture or sound coming through (camera blocked by macOS, in use elsewhere, or the connection gone
  // quiet): stop instead of hanging, and say what to check
  run.stallCheck = setInterval(() => {
    const quiet = Date.now() - (run.sentAt || run.startedAt)
    if (quiet < (run.sentAt ? 8000 : 15000) || !run.proc) return
    clearInterval(run.stallCheck)
    run.stalled = link.kind === 'audio' || frames === 0 ? 'nodata' : 'quiet'
    proc.kill('SIGKILL')
  }, 2000)
  proc.stderr.on('data', d => {
    errText = (errText + d).slice(-4000).split(key).join('KEY')
    // Mux hung up: ffmpeg can sit on a dead connection, so end it now and reconnect straight away
    if (/Error muxing a packet|av_interleaved_write_frame\(\): (End of file|Broken pipe|Connection reset)/.test(errText) && run.proc === proc) proc.kill('SIGKILL')
  })
  proc.on('exit', code => {
    run.proc = null
    clearInterval(run.stallCheck)
    const stalled = run.stalled; run.stalled = null
    if (!links[id]) return
    const wasSending = run.state === 'sending'
    const lived = Date.now() - run.startedAt
    log(link.slotName + ' exit ' + code + ' after ' + Math.round(lived / 1000) + 's' + (wasSending ? ' (was sending)' : '') + ': ' + errText.split('\n').filter(Boolean).slice(-3).join(' | '))
    if (stalled === 'nodata') {
      const what = link.kind === 'audio' ? 'Microphone' : 'Camera'
      setState(id, 'error', 'No ' + (link.kind === 'audio' ? 'sound' : 'picture') + ' from ' + (link.kind === 'audio' ? link.audio : link.video) + '. In System Settings → Privacy & Security → ' + what + ', turn a™ off and on again, then reopen a™.')
      return later(id, 60e3)
    }
    // The camera said which modes it has: use the best one (largest picture, then up to 30 fps)
    if (!run.picked && /Supported modes|not supported by the device/i.test(errText)) {
      const modes = [...errText.matchAll(/(\d{3,4})x(\d{3,4})@\[(\d+(?:\.\d+)?)/g)].map(m => ({ w: +m[1], h: +m[2], fps: +m[3] }))
        .filter(m => m.fps >= 10 && m.fps <= 31 && m.w <= 1920)
        .sort((a, b) => b.w * b.h - a.w * a.h || b.fps - a.fps)
      if (modes.length) { run.picked = [modes[0].w + 'x' + modes[0].h, String(modes[0].fps)]; log(link.slotName + ' using ' + run.picked.join(' @ ')); return later(id, 500) }
    }
    // It connected and dropped within a minute: every short connection leaves a broken recording in Cloud
    // Storage, so wait longer each time (30 s, 1, 2, 4… up to 10 min) and say which device keeps stopping
    if (wasSending && lived < 60e3 && (run.quick || 0) < 3) {
      run.quick = (run.quick || 0) + 1
      setState(id, 'starting', 'Reconnecting')
      return later(id, 1000)
    }
    if (wasSending && lived < 60e3) {
      run.fails = (run.fails || 0) + 1
      const wait = Math.min(600e3, 30e3 * 2 ** (run.fails - 1))
      setState(id, 'error', (link.kind === 'audio' ? link.audio : link.video) + ' keeps stopping. Trying again in ' + (wait >= 60e3 ? Math.round(wait / 60e3) + ' min' : Math.round(wait / 1e3) + ' s'))
      return later(id, wait)
    }
    if (wasSending) { run.fails = 0; run.quick = 0 }
    if (/videotoolbox/i.test(errText) && !run.x264) { run.x264 = true; return later(id, 500) }
    if (/(video size|framerate|pixel format).*not supported|Selected (video size|framerate)/i.test(errText) && run.mode < VIDEO_MODES.length - 1) { run.mode++; return later(id, 500) }
    if (wasSending) { setState(id, 'starting', 'Reconnecting'); return later(id, RETRY_DROPPED_MS) }
    // Mux refusing the stream (no set on, so the slot is closed) names the ingest address; anything else is the device
    if (!errText || /global-live\.mux\.com|rtmp:\/\/127\.0\.0\.1/.test(errText) && /Input\/output error|Connection refused|Broken pipe|Server returned|Operation timed out|End of file|Connection reset/i.test(errText)) {
      setState(id, 'waiting'); return later(id, RETRY_WAITING_MS)
    }
    console.error('[this-mac]', link.slotName, errText.split('\n').filter(Boolean).slice(-2).join(' | '))
    setState(id, 'error', 'Could not open ' + (link.kind === 'audio' ? link.audio : link.video) + '. Unplug it and plug it in again.')
    later(id, RETRY_WAITING_MS)
  })
}

function stop(id) {
  const run = runs[id]
  if (!run) return
  clearTimeout(run.timer)
  if (run.proc) { run.proc.removeAllListeners('exit'); run.proc.kill('SIGINT') }
  if (run.preview) run.preview.kill('SIGINT')
  clearInterval(run.stallCheck)
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
    runs[id] = { id, proc: null, preview: null, state: 'starting', detail: '', timer: null, mode: 0, x264: false }
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

// The live picture on the website: the newest preview frame of each linked camera, every 3 seconds
const sentAt = {}
async function sendFrames() {
  for (const [id, l] of Object.entries(links)) {
    if (l.kind !== 'camera' || !l.frameCam) continue
    const f = frames[id]
    if (!f || f.at <= (sentAt[id] || 0) || Date.now() - f.at > 3000) continue
    sentAt[id] = f.at
    try {
      const r = await net.fetch('https://local-assets.com/api/camera-frame', { method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-LA-Cam': l.frameCam, 'X-LA-Pass': open(l.framePass) }, body: f.jpg })
      if (r.status === 404) { delete l.frameCam; save() }   // the camera was removed from Camera Control
    } catch {}
  }
}

function init(onChange) {
  notify = onChange
  load()
  poll().then(sync)
  setInterval(() => poll().catch(() => {}), POLL_MS)
  setInterval(() => sendFrames().catch(() => {}), 1000)
}

function state(venue) {
  const out = {}
  for (const [id, l] of Object.entries(links)) {
    if (venue && l.venue !== venue) continue
    const r = runs[id] || {}
    out[l.slotId] = { video: l.video || '', audio: l.audio || '', kind: l.kind, state: r.state || 'starting', detail: r.detail || '', frame: !!l.frameCam }
  }
  return { devices: { video: devices.video.map(d => d.name), audio: devices.audio.map(d => d.name) }, links: out }
}

function link({ venue, slotId, slotName, kind, video, audio, key, frame }) {
  const id = venue + '/' + slotId
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This Mac can\'t keep the stream key safely')
  stop(id)
  links[id] = { venue, slotId, slotName, kind, video: kind === 'audio' ? '' : video, audio, key: seal(key),
    ...(frame && frame.cam && frame.pass ? { frameCam: frame.cam, framePass: seal(frame.pass) } : {}) }
  save(); sync(); notify()
}

function unlink(venue, slotId) {
  const id = venue + '/' + slotId
  stop(id)
  delete links[id]
  save(); awake(); notify()
}

// Record now: whatever is waiting connects straight away instead of at its next retry
function kick() {
  for (const [id, run] of Object.entries(runs)) if (!run.proc && run.state !== 'missing') { clearTimeout(run.timer); run.timer = null; start(id) }
}

function stopAll() { for (const id of Object.keys(runs)) stop(id) }

module.exports = { init, state, link, unlink, kick, stopAll, preview }
