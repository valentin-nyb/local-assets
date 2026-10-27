// local / assets multi-camera edit, run by the camera relay on the venue's Mac mini.
// For one session: downloads every camera's recording and the HQ audio from the DJ's console, lines each
// camera up with the HQ audio (by matching their sound), cuts between the cameras on the music's phrases,
// renders the edit with the Mac's hardware encoder and uploads it to Mux as the session's long form.
// Needs ffmpeg (brew install ffmpeg).

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FPS_ENV = 100;            // loudness envelope: 100 values a second (10 ms)
const PCM_RATE = 8000;          // sound used for matching: 8 kHz mono

// ── ffmpeg ──
export function findFfmpeg() {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(':')]) {
    const f = path.join(dir, 'ffmpeg');
    if (dir && fs.existsSync(f)) return f;
  }
  return null;
}
let FFMPEG = findFfmpeg();
let FFPROBE = FFMPEG && fs.existsSync(path.join(path.dirname(FFMPEG), 'ffprobe')) ? path.join(path.dirname(FFMPEG), 'ffprobe') : null;
let WORK = path.join(os.homedir(), 'la-relay', 'edits');
// a™ for Mac runs the edits itself: its own ffmpeg (no ffprobe beside it) and its own working folder
// nice: render at a lower priority, so the cameras a™ is recording on the same Mac never wait for the edit
let NICE = 0;
export function configure({ ffmpeg, workDir, nice } = {}) {
  if (nice) NICE = Number(nice) || 0;
  if (ffmpeg) { FFMPEG = ffmpeg; FFPROBE = fs.existsSync(path.join(path.dirname(ffmpeg), 'ffprobe')) ? path.join(path.dirname(ffmpeg), 'ffprobe') : null; }
  if (workDir) WORK = workDir;
}
export const canRender = () => !!FFMPEG;
const run = (bin, args, { onLine } = {}) => new Promise((ok, bad) => {
  const p = NICE ? spawn('/usr/bin/nice', ['-n', String(NICE), bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => { const t = d.toString(); err = (err + t).slice(-4000); if (onLine) t.split(/\r|\n/).forEach(onLine); });
  p.on('error', bad);
  p.on('close', code => code === 0 ? ok() : bad(new Error(path.basename(bin) + ' failed: ' + err.split('\n').filter(Boolean).slice(-2).join(' '))));
});
// A file's streams and length: ffprobe when there is one, else read from what ffmpeg prints about its input
const probe = file => FFPROBE ? JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' }).stdout || '{}') : probeWithFfmpeg(file);
export function probeWithFfmpeg(file) {
  const t = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const streams = [];
  for (const line of t.split('\n')) {
    const m = /Stream #\d+:\d+.*?: (Video|Audio): (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Audio') { streams.push({ codec_type: 'audio' }); continue; }
    const size = /, (\d{2,5})x(\d{2,5})[ ,]/.exec(m[2]), fps = /([\d.]+) fps/.exec(m[2]);
    streams.push({ codec_type: 'video', width: size ? Number(size[1]) : undefined, height: size ? Number(size[2]) : undefined, r_frame_rate: fps ? Math.round(Number(fps[1]) * 1000) + '/1000' : undefined });
  }
  return { streams, format: { duration: d ? String(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) : undefined } };
}
const hwEncoder = () => /h264_videotoolbox/.test(spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');

// ── Mux streams: the best video rendition and the audio rendition of a playback ID ──
async function streamParts(pid) {
  if (String(pid).startsWith('/')) return { video: pid, audio: null };   // a local file (testing on this Mac)
  const url = `https://stream.mux.com/${pid}.m3u8`;
  const text = await (await fetch(url)).text();
  const abs = u => new URL(u, url).href, lines = text.split(/\r?\n/);
  const audioLine = lines.find(l => /^#EXT-X-MEDIA:.*TYPE=AUDIO/.test(l) && /URI="/.test(l));
  let best = null, bw = -1;
  lines.forEach((l, i) => {
    if (!l.startsWith('#EXT-X-STREAM-INF')) return;
    const b = Number((/BANDWIDTH=(\d+)/.exec(l) || [])[1] || 0), u = lines.slice(i + 1).find(x => x && !x.startsWith('#'));
    if (u && b > bw) { bw = b; best = abs(u); }
  });
  return { video: best, audio: audioLine ? abs(/URI="([^"]+)"/.exec(audioLine)[1]) : null };
}

// ── Matching each camera to the HQ audio ──
// A loudness-change envelope (onsets) at 100 values a second; kicks and transitions line up between recordings
function envelope(pcmFile) {
  const buf = fs.readFileSync(pcmFile), n = Math.floor(buf.length / 2), hop = PCM_RATE / FPS_ENV;
  const frames = Math.floor(n / hop), env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) { const v = buf.readInt16LE(i * 2) / 32768; s += v * v; }
    const e = Math.log(1e-6 + Math.sqrt(s / hop));
    env[f] = Math.max(0, e - prev); prev = e;
  }
  let m = 0; for (const v of env) m += v; m /= env.length || 1;
  let sd = 0; for (let i = 0; i < env.length; i++) { env[i] -= m; sd += env[i] * env[i]; }
  sd = Math.sqrt(sd / (env.length || 1)) || 1;
  for (let i = 0; i < env.length; i++) env[i] /= sd;
  return env;
}
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// Where the camera starts on the HQ audio's timeline, in seconds (negative: before the audio), and how sure
export function matchOffset(hq, cam) {
  let n = 1; while (n < hq.length + cam.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(hq); br.set(cam);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], m = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = m; }
  fft(ar, ai, true);
  let best = -Infinity, at = 0, second = -Infinity;
  for (let i = 0; i < n; i++) if (ar[i] > best) { best = ar[i]; at = i; }
  for (let i = 0; i < n; i++) { const d = Math.min(Math.abs(i - at), n - Math.abs(i - at)); if (d > 300 && ar[i] > second) second = ar[i]; }
  const lag = at > n / 2 ? at - n : at;   // hq[t + lag] ~ cam[t]
  return { offset: lag / FPS_ENV, confidence: second > 0 ? best / second : 99 };
}

// ── The edit: tempo from the HQ audio, a cut every 4–16 bars, cameras chosen like a director would ──
function tempo(env) {
  const a = Math.floor(env.length * 0.3), seg = env.subarray(a, Math.min(env.length, a + 600 * FPS_ENV));
  let bestLag = 50, best = -Infinity;
  for (let lag = Math.round(FPS_ENV * 60 / 180); lag <= Math.round(FPS_ENV * 60 / 85); lag++) {
    let s = 0; for (let i = lag; i < seg.length; i++) s += seg[i] * seg[i - lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  let phase = 0, pb = -Infinity;
  for (let p = 0; p < bestLag; p++) { let s = 0; for (let i = a + p; i < a + seg.length; i += bestLag) s += env[i]; if (s > pb) { pb = s; phase = p; } }
  return { beat: bestLag / FPS_ENV, phase: phase / FPS_ENV };
}
function rng(seed) { let x = parseInt(String(seed).slice(0, 8), 16) || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; }; }
export function planCuts({ length, beat, phase, cams, seed }) {
  const r = rng(seed), bar = beat * 4, cuts = [];
  const from = c => c.offset, to = c => c.offset + c.duration;
  let t = 0, last = null, first = true;
  while (t < length - 0.05) {
    const bars = [4, 8, 8, 8, 16][Math.floor(r() * 5)];
    let end = Math.min(length, first ? (phase > 0.05 ? phase + bar * 4 : bar * 8) : t + bar * bars);
    first = false;
    if (length - end < bar * 2) end = length;
    // Cameras filming at this moment; prefer one that lasts the whole shot, else cut early where it stops
    const live = cams.filter(c => from(c) <= t + 0.01 && to(c) > t + 0.5);
    let pick = null;
    if (live.length) {
      const whole = live.filter(c => to(c) >= end - 0.01);
      const pool = whole.length ? whole : live;
      const opts = pool.length > 1 && last ? pool.filter(c => c !== last) : pool;
      const w = opts.map(c => (c.main ? 1.6 : 1)), sum = w.reduce((x, v) => x + v, 0);
      let x = r() * sum; pick = opts[opts.length - 1];
      for (let i = 0; i < opts.length; i++) { x -= w[i]; if (x <= 0) { pick = opts[i]; break; } }
      end = Math.min(end, to(pick));
    } else {
      // Nobody filming yet (or any more): black until the next camera starts
      const nextStart = Math.min(...cams.map(from).filter(v => v > t + 0.01), length);
      end = Math.min(end, nextStart);
    }
    const prev = cuts[cuts.length - 1];
    if (prev && prev.cam === pick) prev.end = end; else cuts.push({ start: t, end, cam: pick });
    last = pick; t = end;
  }
  return cuts;
}

// ── Upload to Mux in chunks (resumable), so a large edit survives a slow connection ──
async function uploadChunked(url, file, onPct) {
  if (url.startsWith('file://')) { fs.copyFileSync(file, url.slice(7)); onPct(1); return; }   // testing on this Mac
  const size = fs.statSync(file).size, CH = 64 * 1024 * 1024, fd = fs.openSync(file, 'r');
  try {
    for (let start = 0; start < size; start += CH) {
      const end = Math.min(size, start + CH), buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      for (let tryN = 1; ; tryN++) {
        try {
          const r = await fetch(url, { method: 'PUT', headers: { 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end - 1}/${size}`, 'Content-Type': 'video/mp4' }, body: buf });
          if (r.ok || r.status === 308) break;
          throw new Error('upload ' + r.status);
        } catch (e) { if (tryN >= 6) throw e; await new Promise(z => setTimeout(z, 5000 * tryN)); }
      }
      onPct(end / size);
    }
  } finally { fs.closeSync(fd); }
}

// ── The whole job ──
export async function runEdit(job, report) {
  if (!FFMPEG) throw new Error('ffmpeg is not installed on this Mac. Open Terminal and run: brew install ffmpeg');
  const dir = path.join(WORK, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const warnings = [];
  const step = (stage, pct) => report({ stage, pct: Math.round(pct) });
  try {
    // 1. Each camera: its best rendition, and its sound (for matching, or as the edit's sound)
    const cams = [];
    for (let i = 0; i < job.sources.length; i++) {
      const s = job.sources[i];
      step(`Downloading camera ${i + 1} of ${job.sources.length} (${s.camera})`, 2 + 25 * i / job.sources.length);
      const parts = await streamParts(s.pid);
      const file = path.join(dir, `cam${i}.mp4`);
      await run(FFMPEG, ['-y', '-i', parts.video, '-map', '0:v:0', '-c', 'copy', file]);
      const v = (probe(file).streams || []).find(x => x.codec_type === 'video') || {};
      const [fn, fd] = String(v.r_frame_rate || '30/1').split('/').map(Number);
      const cam = { ...s, file, width: v.width || 1920, height: v.height || 1080, fps: fd ? fn / fd : 30, duration: Number(probe(file).format?.duration) || s.duration, offset: null, main: !!s.main, sound: null, pcm: null };
      if (s.hasAudio) {
        try {
          cam.sound = path.join(dir, `cam${i}.wav`);
          await run(FFMPEG, ['-y', '-i', parts.audio || parts.video, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', cam.sound]);
          cam.pcm = path.join(dir, `cam${i}.pcm`);
          await run(FFMPEG, ['-y', '-i', cam.sound, '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', cam.pcm]);
        } catch (e) { cam.sound = cam.pcm = null; warnings.push(`${s.camera}: could not read its sound`); }
      }
      cams.push(cam);
    }
    if (!cams.some(c => c.main)) cams[0].main = true;

    // 2. The edit's sound: the HQ audio from the console, else the main camera's sound (the console feed),
    //    which then also goes up on its own as the session's HQ AUDIO
    const hqWav = path.join(dir, 'hq.wav'), hqPcm = path.join(dir, 'hq.pcm');
    let soundCam = null;
    if (job.audio) {
      step('Downloading the HQ audio', 28);
      const hqParts = await streamParts(job.audio.pid);
      await run(FFMPEG, ['-y', '-i', hqParts.audio || hqParts.video, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', hqWav]);
      await run(FFMPEG, ['-y', '-i', hqWav, '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', hqPcm]);
    } else {
      soundCam = cams.find(c => c.main && c.sound) || cams.find(c => c.sound);
      if (!soundCam) throw new Error('No HQ audio and no camera with sound to use instead');
      fs.copyFileSync(soundCam.sound, hqWav); fs.copyFileSync(soundCam.pcm, hqPcm);
      soundCam.offset = 0;
      if (!soundCam.main) warnings.push(`Sound taken from ${soundCam.camera} (the main camera has none)`);
    }
    const length = Number(probe(hqWav).format?.duration) || job.audio?.duration || soundCam.duration;
    const hqEnv = envelope(hqPcm);
    for (const c of cams) {
      if (c === soundCam || !c.pcm) continue;
      const m = matchOffset(hqEnv, envelope(c.pcm));
      if (m.confidence >= 1.4) c.offset = m.offset;
      else warnings.push(`${c.camera}: its sound didn't clearly match the ${job.audio ? 'HQ audio' : 'main camera'}`);
    }

    // 3. Cameras without matched sound: by their recording start time, against a camera that matched
    step('Lining the cameras up with the HQ audio', 32);
    const ref = cams.find(c => c.offset !== null && c.recStart);
    for (const c of cams) {
      if (c.offset !== null) continue;
      if (ref && c.recStart) { c.offset = ref.offset + (c.recStart - ref.recStart) / 1000; continue; }
      c.offset = 0;
      warnings.push(`${c.camera}: placed at the start of the HQ audio (no sound or start time to line it up)`);
    }
    if (cams.every(c => c.offset === 0 && !c.hasAudio)) warnings.push('No camera could be matched to the HQ audio: check the edit');

    // 4. The cuts
    const { beat, phase } = tempo(hqEnv);
    const cuts = planCuts({ length, beat, phase, cams, seed: job.id });
    const main = cams.find(c => c.main);
    const W = Math.max(...cams.map(c => c.width)), H = Math.round(W * 9 / 16 / 2) * 2, F = Math.round(main.fps * 100) / 100;
    const hw = hwEncoder(), bitrate = W >= 3000 ? '24M' : '12M';
    console.log(`[multicam] ${job.artist} ${job.date}: ${cams.length} cameras, ${(60 / beat).toFixed(1)} BPM, ${cuts.length} cuts, ${W}x${H}@${F}`, cams.map(c => `${c.camera}@${c.offset?.toFixed(2)}s`).join(' '));

    // 5. Render each shot exactly on the frame grid, then join them and lay the HQ audio under them
    const list = [];
    let frameAt = 0;
    for (let k = 0; k < cuts.length; k++) {
      const c = cuts[k], endFrame = Math.round(c.end * F), frames = endFrame - frameAt;
      if (frames <= 0) continue;
      const out = path.join(dir, `seg${String(k).padStart(5, '0')}.mp4`);
      const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${F},format=yuv420p`;
      const enc = hw ? ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-allow_sw', '1'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
      if (c.cam) {
        const camT = Math.max(0, frameAt / F - c.cam.offset);
        await run(FFMPEG, ['-y', '-ss', camT.toFixed(3), '-i', c.cam.file, '-an', '-vf', vf, '-frames:v', String(frames), ...enc, '-r', String(F), out]);
      } else {
        await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${F}`, '-frames:v', String(frames), ...enc, out]);
      }
      list.push(`file '${out}'`);
      frameAt = endFrame;
      if (k % 5 === 0) step(`Rendering the edit (${k + 1} of ${cuts.length} shots)`, 35 + 45 * k / cuts.length);
    }
    fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
    step('Adding the HQ audio', 81);
    const edit = path.join(dir, 'edit.mp4');
    await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-i', hqWav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-shortest', '-movflags', '+faststart', edit]);

    // 6. Upload: the session's new long form, then the usual clips and thumbnails follow
    await uploadChunked(job.upload.url, edit, p => step('Uploading the edit', 82 + (job.audioUpload ? 14 : 17) * p));
    if (job.audioUpload) {
      const m4a = path.join(dir, 'hq.m4a');
      await run(FFMPEG, ['-y', '-i', hqWav, '-t', String(length), '-c:a', 'aac', '-b:a', '320k', m4a]);
      await uploadChunked(job.audioUpload.url, m4a, p => step('Uploading the HQ audio', 96 + 3 * p));
    }
    report({ status: 'done', stage: 'Uploaded. Mux is processing the edit', pct: 100, warnings });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
