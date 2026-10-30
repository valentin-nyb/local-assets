// Long forms rendered on this Mac: a 2-hour 4K set is too long to draw again on the website's servers, so a™
// does it here with the Mac's video hardware (VideoToolbox) and uploads the result straight to Mux:
// - "wm": the Brand Kit watermark with its moving (GIF) logo over the picture
// - "sound": the camera sent no sound, so the decks' recording goes in, lined up with the picture
// The site queues the jobs (api/watermark-clips.js, macNext / macReport); one runs at a time, in the background.
const { app, net, powerSaveBlocker } = require('electron')
const { spawn } = require('child_process')
const https = require('https')
const path = require('path')
const fs = require('fs')
const os = require('os')

const SITE = 'https://local-assets.com'
const FFMPEG = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(__dirname, 'vendor', process.arch, 'ffmpeg')
const IDLE_MS = 2 * 60e3          // look for work every 2 minutes
const BEAT_MS = 30e3              // tell the site how far it is every 30 s
let getToken = null, busy = false, proc = null, timer = null

// This Mac's name: a watermark asked for here is rendered here
const device = () => os.hostname().replace(/\.local$/, '')

function log(line) {
  try {
    const f = path.join(app.getPath('userData'), 'renders.log')
    try { if (fs.statSync(f).size > 512e3) fs.renameSync(f, f + '.1') } catch {}
    fs.appendFileSync(f, new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}

async function api(body) {
  const token = getToken ? await getToken() : ''
  if (!token) return null
  const r = await net.fetch(SITE + '/api/watermark-clips', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error('site answered ' + r.status)
  return r.json()
}
const report = (id, r) => api({ action: 'macReport', id, ...r }).catch(e => log('report: ' + e.message))

// Read over the network as a stream, reconnecting if the connection drops
const net_in = url => ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30', '-i', url]

function ffmpegArgs(job, out) {
  const args = ['-hide_banner', '-loglevel', 'error', '-stats', '-y', ...net_in(job.video)]
  let n = 1, soundIn = null, baseIn = null, gifIn = null, decksIn = null
  if (job.sound) { args.push(...net_in(job.sound)); soundIn = n++ }
  if (job.kind === 'wm' && job.wm?.base) { args.push('-i', job.wm.base); baseIn = n++ }
  if (job.kind === 'wm' && job.wm?.gif) { args.push('-ignore_loop', '0', '-i', job.wm.gif); gifIn = n++ }
  if (job.decks) {
    // The decks' recording at the picture's time: offset seconds further on (or, below 0, that much later)
    const off = Number(job.decks.offset) || 0
    if (off > 0) args.push('-ss', off.toFixed(3)); else if (off < 0) args.push('-itsoffset', (-off).toFixed(3))
    args.push(...net_in(job.decks.url)); decksIn = n++
  }
  const vw = job.vw, vh = job.vh
  const maps = []
  if (job.kind === 'wm') {
    let f = `[${baseIn}:v]scale=${vw}:${vh}[b];[0:v][b]overlay=0:0[v1]`
    const a = job.wm.at
    if (gifIn != null && a) {
      const k = vw / a.W, even = x => Math.max(2, Math.round(x / 2) * 2)
      f += `;[${gifIn}:v]scale=${even(a.w * k)}:${even(a.h * k)}:flags=lanczos,format=rgba,colorchannelmixer=aa=${a.opacity ?? 1}[g];[v1][g]overlay=${Math.round(a.left * k)}:${Math.round(a.top * k)}:shortest=1,format=yuv420p[v]`
    } else f += ';[v1]format=yuv420p[v]'
    // The Mac's video hardware, at about the bitrate of a good 4K master
    const bps = Math.round(vw * vh * 30 * 0.14)
    args.push('-filter_complex', f, '-map', '[v]', '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-profile:v', 'high',
      '-b:v', String(bps), '-maxrate', String(Math.round(bps * 1.5)), '-bufsize', String(bps * 2))
  } else {
    maps.push('-map', '0:v:0'); args.push('-c:v', 'copy')
  }
  args.push(...maps)
  if (decksIn != null) args.push('-map', `${decksIn}:a:0`, '-c:a', 'aac', '-b:a', '256k', '-af', 'aresample=async=1000:first_pts=0')
  else if (soundIn != null) args.push('-map', `${soundIn}:a:0`, '-c:a', 'aac', '-b:a', '256k')
  else args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '256k')
  if (job.dur) args.push('-t', String(Math.ceil(job.dur)))
  args.push('-f', 'mp4', out)
  return args
}

function render(job, out, onProgress) {
  return new Promise((resolve, reject) => {
    proc = spawn(FFMPEG, ffmpegArgs(job, out), { stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    proc.stderr.on('data', d => {
      const s = String(d); tail = (tail + s).slice(-2000)
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s)
      if (m && job.dur) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / job.dur))
    })
    proc.on('error', e => { proc = null; reject(e) })
    proc.on('close', code => { proc = null; code === 0 ? resolve() : reject(new Error('ffmpeg ' + code + ': ' + tail.trim().split('\n').filter(l => !/^frame=|size=/.test(l)).pop())) })
  })
}

// Straight to Mux (its upload address, no sign-in needed), streamed from the disk
function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size
    const req = https.request(url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': size } }, res => {
      res.resume(); res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve() : reject(new Error('Mux answered ' + res.statusCode)))
    })
    req.on('error', reject)
    let sent = 0
    const rs = fs.createReadStream(file, { highWaterMark: 4 << 20 })
    rs.on('data', c => { sent += c.length; onProgress(sent / size) })
    rs.on('error', reject)
    rs.pipe(req)
  })
}

async function runJob(job) {
  const out = path.join(os.tmpdir(), `la-render-${job.id.replace(/[^A-Za-z0-9]/g, '-')}.mp4`)
  const blocker = powerSaveBlocker.start('prevent-app-suspension')
  let pct = 0, stage = 'rendering', lastBeat = 0
  const beat = force => { if (force || Date.now() - lastBeat > BEAT_MS) { lastBeat = Date.now(); report(job.id, { progress: pct, stage }) } }
  try {
    // Room on the disk for the result (about its bitrate × length, with a margin)
    const need = job.kind === 'wm' ? job.vw * job.vh * 30 * 0.14 / 8 * (job.dur || 7200) * 1.2 : 0
    try { const st = fs.statfsSync(os.tmpdir()); const free = st.bavail * st.bsize; if (need && free < need + 5e9) throw new Error(`needs about ${Math.ceil((need + 5e9) / 1e9)} GB free on this Mac (${Math.floor(free / 1e9)} GB free)`) } catch (e) { if (/needs about/.test(e.message)) throw e }
    log(`${job.id} ${job.kind} ${job.artist}: rendering`)
    beat(true)
    await render(job, out, p => { pct = Math.round(p * 90); beat() })
    stage = 'uploading'; pct = 90; beat(true)
    log(`${job.id}: uploading ${Math.round(fs.statSync(out).size / 1e6)} MB`)
    await upload(job.upload, out, p => { pct = 90 + Math.round(p * 10); beat() })
    await report(job.id, { done: true })
    log(`${job.id}: done`)
  } catch (e) {
    log(`${job.id}: failed: ${e.message}`)
    await report(job.id, { failed: e.message })
  } finally {
    powerSaveBlocker.stop(blocker)
    fs.rm(out, { force: true }, () => {})
  }
}

async function look() {
  clearTimeout(timer)
  if (busy) return
  busy = true
  try {
    const d = await api({ action: 'macNext', device: device() }).catch(() => null)
    if (d && d.job) { await runJob(d.job); busy = false; return look() }
  } finally { busy = false }
  timer = setTimeout(look, IDLE_MS)
}

function init(tokenOf) {
  getToken = tokenOf
  timer = setTimeout(look, 30e3)   // once the window has signed in
  app.on('before-quit', () => { if (proc) try { proc.kill('SIGKILL') } catch {} })
}

module.exports = { init, look, device }
