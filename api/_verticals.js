import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { put, del as delBlob, list as listBlobs } from '@vercel/blob';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';
import { planMaxClips } from './_billing.js';

// Vertical clips: cut once from a session's full recording, cropped to 9:16 at 1080×1920, and kept as
// the originals ("ARTIST // SOCIAL // NN"). A watermark is put on copies of these, never on the
// originals, so the originals are never cut again.

export const muxReq = (auth, p, init = {}) => fetch('https://api.mux.com' + p, {
  ...init,
  headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  signal: AbortSignal.timeout(15000),
}).then(async r => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body?.error?.messages?.[0] || `Mux ${r.status}`); e.status = r.status; throw e; }
  return body.data;
});

export const SUB = /^(.+?) \/\/ (SOCIAL|SOCIALRAW) \/\/ (\d+)$/i;
// Any vertical-clip tag: "ARTIST // SOCIAL // NN", the older "ARTIST // SOCIAL", or JSON { artist, camera: 'SOCIAL' }
export function socialInfo(a) {
  const pt = String(a?.passthrough || '').trim();
  const m = SUB.exec(pt);
  if (m) return { artist: m[1].toUpperCase().trim(), n: Number(m[3]), hidden: m[2].toUpperCase() === 'SOCIALRAW' };
  const u = /^(.+?) \/\/ (SOCIAL|SOCIALRAW)$/i.exec(pt);
  if (u) return { artist: u[1].toUpperCase().trim(), n: null, hidden: u[2].toUpperCase() === 'SOCIALRAW' };
  try {
    const o = JSON.parse(pt);
    const cam = String(o?.camera || '').toUpperCase();
    if (o?.artist && (cam === 'SOCIAL' || cam === 'SOCIALRAW')) return { artist: String(o.artist).toUpperCase().trim(), n: Number(o.clip || o.n) || null, hidden: cam === 'SOCIALRAW' };
  } catch {}
  return null;
}
export const tagFor = (artist, n, hidden) => `${artist} // ${hidden ? 'SOCIALRAW' : 'SOCIAL'} // ${String(n).padStart(2, '0')}`;
export const originalsKey = slug => `v_orig:${slug}`;       // set: vertical originals
const jobsKey = slug => `v_jobs:${slug}`;                    // hash: new original → JSON { artist, n, blob, master }
const doneKey = masterId => `v_done:${masterId}`;           // hash: n → original's id (cut once)
const failKey = masterId => `v_fail:${masterId}`;
const failedKey = slug => `v_failed:${slug}`;               // hash: masterId:n → JSON { artist, n, at, error } (cleared when it's cut)
const readyKey = slug => `v_ready:${slug}`;                 // sorted set: originals that finished, by time

// Vertical clips health for System Health: cutting now, failed (last 24 h) and finished (last 24 h)
export async function verticalsHealth(redis, slug) {
  const since = Date.now() - 86400e3;
  const [jobs, failed, done] = await Promise.all([
    redis.hLen(jobsKey(slug)),
    redis.hGetAll(failedKey(slug)),
    redis.zCount(readyKey(slug), since, '+inf'),
  ]);
  const recent = Object.values(failed).map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(f => f && f.at > since);
  await redis.zRemRangeByScore(readyKey(slug), '-inf', since - 7 * 86400e3).catch(() => {});
  return { processing: jobs, failed: recent.length, failedArtists: [...new Set(recent.map(f => f.artist))], done };
}           // hash: n → failed attempts (no endless retries)

// The times the clips are cut at (same as the upload pipeline always used)
export function clipTimes(duration, want = 5) {
  const count = Math.min(Math.floor(duration / 30), Math.max(1, want));
  if (count < 1) return [];
  const seg = Math.min(45, duration / count);
  const gap = (duration - seg * count) / (count + 1);
  return Array.from({ length: count }, (_, i) => { const start = gap * (i + 1) + seg * i; return { n: i + 1, start, end: Math.min(start + seg, duration) }; });
}

export async function listAllAssets(auth) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await muxReq(auth, `/video/v1/assets?limit=100&page=${page}`);
    out.push(...(batch || []));
    if (!batch || batch.length < 100) break;
  }
  return out;
}

// The full recordings of an artist, oldest first
export function artistMasters(assets, artist) {
  const masterOf = a => {
    const pt = String(a.passthrough || '').trim();
    if (pt.toUpperCase() === artist) return true;
    try { const o = JSON.parse(pt); return o && String(o.artist || '').toUpperCase().trim() === artist && !['AUDIO', 'SOCIAL', 'SOCIALRAW', 'THUMB'].includes(String(o.camera || '').toUpperCase()); } catch { return false; }
  };
  return assets.filter(a => masterOf(a) && Number(a.duration) > 10).sort((a, b) => Number(a.created_at) - Number(b.created_at));
}
// The recording a clip belongs to: the one it was cut from (meta.external_id), else that of the clip it was
// copied from (a watermarked copy). A clip that names its recording never moves to another session: if that
// recording was deleted, the clip belongs to none. Only old clips that name nothing go to the newest recording before them.
export function clipOwner(a, byId, masters, depth = 0) {
  const ext = a?.meta?.external_id;
  if (ext && masters.some(m => m.id === ext)) return ext;
  const src = a?.source_asset_id && byId.get(a.source_asset_id);
  if (src && depth < 5) {
    if (masters.some(m => m.id === src.id)) return src.id;
    if (socialInfo(src)) return clipOwner(src, byId, masters, depth + 1);
  }
  if (ext || a?.source_asset_id) return null;
  let owner = null;
  for (const m of masters) if (Number(m.created_at) <= Number(a.created_at)) owner = m.id;
  return owner;
}

// The session's full recording and its clips by number
export function sessionClips(assets, artist, date) {
  const masterOf = a => {
    const pt = String(a.passthrough || '').trim();
    if (pt.toUpperCase() === artist) return true;
    try { const o = JSON.parse(pt); return o && String(o.artist || '').toUpperCase().trim() === artist && !['AUDIO', 'SOCIAL', 'THUMB'].includes(String(o.camera || '').toUpperCase()); } catch { return false; }
  };
  const day = a => new Date(Number(a.created_at) * 1000).toISOString().slice(0, 10);
  const masters = assets.filter(a => a.status === 'ready' && masterOf(a) && Number(a.duration) > 10)
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  // The session's own date (set at upload) first, then the upload day
  const dateOf = a => { try { const o = JSON.parse(a.passthrough); if (o?.date) return String(o.date); } catch {} return null; };
  const master = masters.find(a => dateOf(a) === date) || masters.find(a => !dateOf(a) && day(a) === date) || masters.find(a => day(a) === date) || null;
  const shown = new Map(), hidden = new Map();
  if (!master) return { master, shown, hidden };
  const byId = new Map(assets.map(a => [a.id, a]));
  const all = artistMasters(assets, artist);
  for (const a of assets) {
    const m = SUB.exec(String(a.passthrough || '').trim());
    if (!m || m[1].toUpperCase() !== artist) continue;
    if (clipOwner(a, byId, all) !== master.id) continue;
    const n = Number(m[3]);
    if (m[2].toUpperCase() === 'SOCIAL') shown.set(n, a);
    else hidden.set(n, [...(hidden.get(n) || []), a]);
  }
  return { master, shown, hidden };
}

export const videoSize = a => { const t = (a?.tracks || []).find(x => x.type === 'video'); return t ? [Number(t.max_width) || 0, Number(t.max_height) || 0] : [0, 0]; };

// ── Signed requests between our own functions ──
const secret = () => process.env.LOCAL_ASSETS_API_KEY || 'dev-secret-change-me';
export function signJob(job) {
  const data = Buffer.from(JSON.stringify({ ...job, exp: Date.now() + 10 * 60e3 })).toString('base64url');
  return data + '.' + crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}
export function verifyJob(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const job = JSON.parse(Buffer.from(data, 'base64url').toString()); return job.exp > Date.now() ? job : null; } catch { return null; }
}

export function venueAuth(slug) {
  const cfg = getVenuesConfig()[slug];
  return cfg ? getMuxAuthForVenue({ slug, ...cfg }) : null;
}

// The venue whose Cloud Storage holds this asset (for webhook events, which don't say)
export async function venueForAsset(assetId) {
  for (const slug of Object.keys(getVenuesConfig())) {
    const auth = venueAuth(slug);
    if (!auth) continue;
    const a = await muxReq(auth, `/video/v1/assets/${encodeURIComponent(assetId)}`).catch(() => null);
    if (a) return { slug, auth, asset: a };
  }
  return null;
}

// Decks audio: has the recording's sound copied out as an audio-only recording (api/watermark-clips.js)
export async function startAudioOnly(slug, asset, origin = 'https://local-assets.com') {
  const pid = asset.playback_ids?.[0]?.id;
  if (!pid) return;
  await fetch(`${origin}/api/watermark-clips`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ action: 'audioOnly', job: signJob({ kind: 'audio-only', slug, assetId: asset.id, pid, passthrough: asset.passthrough }) }) });
}

// Starts one cutting job per clip that hasn't been cut yet; each runs in its own function
export async function startVerticals(redis, slug, master, artist, origin, retry = false, count = null) {
  if (!count) count = await planMaxClips(redis, slug);
  // Automatic starts (Mux webhook or the upload's intake) happen once per recording
  if (!retry && !(await redis.set(`v_auto:${master.id}`, '1', { NX: true, EX: 90 * 86400 }))) return 0;
  if (retry) {   // pressed by hand: try failed clips again
    await redis.del(failKey(master.id));
    const f = await redis.hKeys(failedKey(slug));
    for (const k of f) if (k.startsWith(master.id + ':')) await redis.hDel(failedKey(slug), k);
  }
  const pid = (master.playback_ids || [])[0]?.id;
  if (!pid) throw new Error('The full recording has no playback ID yet');
  if (retry) {
    // Clips already cut that no longer exist (deleted or failed) are cut again
    const done = await redis.hGetAll(doneKey(master.id));
    const masterHasSound = (master.tracks || []).some(t => t.type === 'audio');
    for (const [n, id] of Object.entries(done)) {
      const a = await muxReq(venueAuth(slug), `/video/v1/assets/${encodeURIComponent(id)}`).catch(() => null);
      const silent = a?.status === 'ready' && masterHasSound && !(a.tracks || []).some(t => t.type === 'audio');
      if (!a || a.status === 'errored' || silent) {
        await redis.hDel(doneKey(master.id), n);
        // A clip cut without sound is replaced by the new cut once that's ready
        if (silent) await redis.sRem(originalsKey(slug), id);
      }
    }
  }
  const done = await redis.hGetAll(doneKey(master.id));
  const fails = await redis.hGetAll(failKey(master.id));
  // A clip that failed twice isn't retried automatically
  const todo = clipTimes(Number(master.duration), count).filter(t => !done[t.n] && Number(fails[t.n] || 0) < 2);
  await Promise.all(todo.map(t => fetch(`${origin}/api/vertical-clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cut', job: signJob({ slug, masterId: master.id, pid, artist, n: t.n, start: t.start, end: t.end }) }),
    signal: AbortSignal.timeout(20000),
  }).catch(e => console.error('[verticals] start', t.n, e.message))));
  return todo.length;
}

// The best video rendition and the separate sound rendition of an HLS stream (absolute URLs)
async function streamParts(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('playlist ' + r.status);
  const text = await r.text();
  console.log('[verticals] playlist', text.split(/\r?\n/).filter(l => /^#EXT-X-(MEDIA|STREAM-INF)/.test(l)).slice(0, 6).join(' | ').slice(0, 900));
  const abs = u => new URL(u, url).href;
  const lines = text.split(/\r?\n/);
  const audioLine = lines.find(l => /^#EXT-X-MEDIA:.*TYPE=AUDIO/.test(l) && /URI="/.test(l));
  const audio = audioLine ? abs(/URI="([^"]+)"/.exec(audioLine)[1]) : null;
  let best = null, bw = -1;
  lines.forEach((l, i) => {
    if (!l.startsWith('#EXT-X-STREAM-INF')) return;
    const b = Number((/BANDWIDTH=(\d+)/.exec(l) || [])[1] || 0);
    const u = lines.slice(i + 1).find(x => x && !x.startsWith('#'));
    if (u && b > bw) { bw = b; best = abs(u); }
  });
  return { video: best, audio };
}

// The session's HQ AUDIO ("ARTIST // AUDIO", or { artist, camera: 'AUDIO' }): the one dated like the recording,
// else the one uploaded after this recording and before the artist's next one
async function sessionAudio(auth, job) {
  const assets = await listAllAssets(auth);
  const master = assets.find(a => a.id === job.masterId);
  if (!master) return null;
  const info = a => {
    const pt = String(a.passthrough || '').trim();
    if (pt.toUpperCase() === `${job.artist} // AUDIO`) return {};
    try { const o = JSON.parse(pt); if (String(o?.artist || '').toUpperCase().trim() === job.artist && String(o.camera || '').toUpperCase() === 'AUDIO') return o; } catch {}
    return null;
  };
  const day = a => new Date(Number(a.created_at) * 1000).toISOString().slice(0, 10);
  let mdate = day(master); try { const o = JSON.parse(master.passthrough); if (o?.date) mdate = o.date; } catch {}
  const later = assets.filter(a => a.id !== master.id && Number(a.created_at) > Number(master.created_at) && Number(a.duration) > 10
    && !String(a.passthrough || '').includes(' // ') && (() => { try { const o = JSON.parse(a.passthrough); return String(o?.artist || '').toUpperCase().trim() === job.artist && !['AUDIO', 'SOCIAL', 'SOCIALRAW', 'THUMB'].includes(String(o.camera || '').toUpperCase()); } catch { return String(a.passthrough || '').trim().toUpperCase() === job.artist; } })())
    .sort((a, b) => Number(a.created_at) - Number(b.created_at))[0];
  const audios = assets.filter(a => a.status === 'ready' && (a.playback_ids || [])[0]?.id && info(a))
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const pick = audios.find(a => info(a).date === mdate)
    || audios.find(a => Number(a.created_at) >= Number(master.created_at) && (!later || Number(a.created_at) < Number(later.created_at)));
  return pick ? { id: pick.id, pid: pick.playback_ids[0].id } : null;
}

// Whether a file has a sound stream
function hasAudio(file) {
  return new Promise(resolve => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err += d; });
    ff.on('error', () => resolve(false));
    ff.on('close', () => resolve(/Stream #\S+.*Audio:/.test(err)));
  });
}

export function run(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err = (err + d).slice(-2000); });
    ff.on('error', reject);
    ff.on('close', code => { if (err.trim()) console.log('[verticals] ffmpeg said:', err.trim().slice(-600)); code === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.trim().split('\n').pop())); });
  });
}

// The account's colour look (Brand Kit → Colour looks, chosen with Use as LUT) is applied to every vertical clip,
// so all clips have the same grade. Downloaded for the cut; none chosen → the clip keeps its own colours.
async function colourLook(redis, slug) {
  try {
    // The look chosen with "Use as LUT" in Brand Kit; none chosen → no grade
    const chosen = await redis.get(`brand_lut:${slug}`);
    if (!chosen) return null;
    const { blobs } = await listBlobs({ prefix: `brand/${slug}/`, limit: 1000 });
    const cube = blobs.find(b => b.url === chosen && /\.cube$/i.test(b.pathname));
    if (!cube) return null;
    const r = await fetch(cube.url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const file = path.join(os.tmpdir(), `look-${String(slug).replace(/[^A-Za-z0-9-]/g, '')}-${Date.now()}.cube`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return file;
  } catch (e) { console.error('[verticals] colour look', e.message); return null; }
}

// Cuts one vertical original: 9:16 centre crop of the full recording, 1080×1920, 30fps (with the venue's colour look)
export async function cutVertical(redis, auth, job) {
  const lock = `v_lock:${job.masterId}:${job.n}`;
  if (!(await redis.set(lock, '1', { NX: true, EX: 900 }))) return { skipped: 'already cutting' };
  if (await redis.hGet(doneKey(job.masterId), String(job.n))) return { skipped: 'already cut' };
  const out = path.join(os.tmpdir(), `v-${job.masterId}-${job.n}-${Date.now()}.mp4`);
  try {
    // Read only the part to cut: Mux instant clipping serves just that stretch of the recording, so the cutter
    // never has to jump into the middle of the stream (which fails on recordings stored as fMP4).
    // If that comes out empty, fall back to the downloadable MP4 when it exists.
    const len = Math.max(1, job.end - job.start);
    const look = await colourLook(redis, job.slug);
    if (look) setTimeout(() => fs.rm(look, { force: true }, () => {}), 600e3);
    const tail = ['-vf', 'crop=trunc(ih*9/16/2)*2:ih,scale=1080:1920:flags=lanczos,setsar=1,fps=30' + (look ? ',lut3d=file=' + look : ''),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
    const encode = ['-map', '0:v:0', '-map', '0:a:0?', ...tail];
    const sizeOf = () => (fs.existsSync(out) ? fs.statSync(out).size : 0);
    // Mux keeps the sound as its own track in the stream, so the best picture and the sound are read as two inputs
    const clipUrl = `https://stream.mux.com/${job.pid}.m3u8?rendition_order=desc&asset_start_time=${Math.floor(job.start)}&asset_end_time=${Math.ceil(job.end)}`;
    const { video, audio } = await streamParts(clipUrl).catch(e => { console.error('[verticals] playlist', e.message); return {}; });
    const inputs = video && audio ? ['-i', video, '-i', audio] : ['-i', clipUrl];
    const maps = video && audio ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?'];
    await run(['-hide_banner', '-loglevel', 'warning', '-y', ...inputs, '-t', String(len), ...maps, ...tail])
      .catch(e => console.error('[verticals] instant clip', e.message));
    // Cut without the sound: the sound comes from the session's HQ AUDIO (same stretch of the set).
    // Empty, or no HQ AUDIO: cut again from the downloadable MP4, which carries picture and sound together.
    let silent = sizeOf() >= 200 * 1024 && !(await hasAudio(out));
    if (silent) {
      console.error('[verticals] no sound in the stream cut', job.n, 'video', video || clipUrl, 'audio', audio || 'none');
      const hq = await sessionAudio(auth, job).catch(e => { console.error('[verticals] hq audio lookup', e.message); return null; });
      if (hq) {
        const keep = out + '.silent.mp4';
        fs.renameSync(out, keep);
        await run(['-hide_banner', '-loglevel', 'warning', '-y', '-i', keep,
          '-i', `https://stream.mux.com/${hq.pid}.m3u8?asset_start_time=${Math.floor(job.start)}&asset_end_time=${Math.ceil(job.end)}`,
          '-t', String(len), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out])
          .catch(e => console.error('[verticals] hq audio', e.message));
        const ok = sizeOf() >= 200 * 1024 && await hasAudio(out);
        console.log('[verticals] hq audio', job.n, hq.id, ok ? 'added' : 'failed');
        if (ok) { silent = false; fs.rm(keep, { force: true }, () => {}); } else fs.renameSync(keep, out);
      }
    }
    if (sizeOf() < 200 * 1024 || silent) {
      const keep = out + '.silent.mp4';
      if (silent) fs.renameSync(out, keep);
      await run(['-hide_banner', '-loglevel', 'warning', '-y',
        '-ss', String(job.start), '-t', String(len), '-i', `https://stream.mux.com/${job.pid}/highest.mp4`, ...encode])
        .catch(e => console.error('[verticals] mp4 fallback', e.message));
      const ok = sizeOf() >= 200 * 1024 && await hasAudio(out);
      console.log('[verticals] mp4 fallback', job.n, ok ? 'with sound' : 'failed');
      if (silent && !ok) fs.renameSync(keep, out);   // keep the stream cut rather than nothing
      else fs.rm(keep, { force: true }, () => {});
    }
    // A cut that came out empty (stream not readable) is an error, not a clip
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    console.log('[verticals] cut', job.slug, job.artist, job.n, Math.round(size / 1024) + ' KB');
    if (size < 200 * 1024) throw new Error(`The cut came out empty (${size} bytes): the 4K long form couldn't be read`);
    const blob = await put(`watermarks/${job.slug}/vertical-${crypto.randomBytes(6).toString('hex')}.mp4`, fs.readFileSync(out),
      { access: 'public', contentType: 'video/mp4', addRandomSuffix: false, multipart: size > 50 * 1024 * 1024 });
    // Hidden until it's ready; then it takes the clip's place (finishVerticals)
    const asset = await muxReq(auth, '/video/v1/assets', {
      method: 'POST',
      body: JSON.stringify({
        input: [{ url: blob.url }],
        playback_policy: ['public'],
        passthrough: tagFor(job.artist, job.n, true),
        meta: { external_id: job.masterId },
        static_renditions: [{ resolution: 'highest' }],
      }),
    });
    await redis.hSet(doneKey(job.masterId), String(job.n), asset.id);
    await redis.hDel(failedKey(job.slug), `${job.masterId}:${job.n}`);
    await redis.sAdd(originalsKey(job.slug), asset.id);
    await redis.hSet(jobsKey(job.slug), asset.id, JSON.stringify({ artist: job.artist, n: job.n, blob: blob.url, master: job.masterId, at: Date.now() }));
    return { id: asset.id };
  } catch (e) {
    await redis.hIncrBy(failKey(job.masterId), String(job.n), 1).catch(() => {});
    await redis.hSet(failedKey(job.slug), `${job.masterId}:${job.n}`, JSON.stringify({ artist: job.artist, n: job.n, at: Date.now(), error: e.message.slice(0, 200) })).catch(() => {});
    throw e;
  } finally {
    fs.rm(out, { force: true }, () => {});
    await redis.del(lock).catch(() => {});
  }
}

// New originals that finished processing take their clip's place; what they replace is deleted
// (horizontal clips from before, and watermarked copies). Returns how many are still processing.
export async function finishVerticals(redis, slug, auth, assets) {
  const jobs = await redis.hGetAll(jobsKey(slug));
  if (!Object.keys(jobs).length) return { pending: 0, done: 0 };
  const byId = new Map(assets.map(a => [a.id, a]));
  const originals = new Set(await redis.sMembers(originalsKey(slug)));
  let pending = 0, done = 0;
  for (const [id, raw] of Object.entries(jobs)) {
    let job; try { job = JSON.parse(raw); } catch { await redis.hDel(jobsKey(slug), id); continue; }
    const a = byId.get(id);
    // Not listed yet, or still processing
    if ((!a && Date.now() - (job.at || 0) < 3600e3) || (a && a.status !== 'ready' && a.status !== 'errored')) { pending++; continue; }
    if (a?.status === 'ready') {
      const master = byId.get(job.master);
      // The last original of this recording to finish also clears out clips in the older tag formats
      const lastOfMaster = !Object.entries(jobs).some(([oid, r]) => oid !== id && String(r).includes(`"master":"${job.master}"`));
      for (const other of assets) {
        const info = socialInfo(other);
        if (!info || other.id === id || info.artist !== job.artist) continue;
        if (info.n !== job.n && !(info.n === null && lastOfMaster)) continue;
        if (master && Number(other.created_at) < Number(master.created_at)) continue;
        if (originals.has(other.id)) continue;
        // Only versions of this recording's clip (never another session's clips or their watermarked copies)
        if (clipOwner(other, byId, artistMasters(assets, job.artist)) !== job.master) continue;
        await muxReq(auth, `/video/v1/assets/${encodeURIComponent(other.id)}`, { method: 'DELETE' }).catch(() => {});
      }
      await muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ passthrough: tagFor(job.artist, job.n) }) });
      await redis.zAdd(readyKey(slug), { score: Date.now(), value: id }).catch(() => {});
      done++;
    } else {
      // Failed or gone: drop it (it only takes up room), allow one more try
      console.error('[verticals] processing failed', slug, job.artist, job.n, id, JSON.stringify(a?.errors || 'not found'));
      if (a) await muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
      await redis.hDel(doneKey(job.master), String(job.n));
      await redis.hIncrBy(failKey(job.master), String(job.n), 1);
      await redis.sRem(originalsKey(slug), id);
    }
    if (job.blob) await delBlob(job.blob).catch(() => {});
    await redis.hDel(jobsKey(slug), id);
  }
  return { pending, done };
}

// Uploads waiting for their recording to be ready; each starts its vertical clips once (from api/pipeline-trigger.js)
export const intakeKey = slug => `v_intake:${slug}`;
export async function processIntakes(redis, slug, auth, origin) {
  const pending = await redis.hGetAll(intakeKey(slug));
  let started = 0;
  for (const [uploadId, raw] of Object.entries(pending)) {
    let it = {}; try { it = JSON.parse(raw); } catch {}
    if (Date.now() - Number(it.at || 0) > 2 * 86400e3) { await redis.hDel(intakeKey(slug), uploadId); continue; }
    const up = await muxReq(auth, `/video/v1/uploads/${encodeURIComponent(uploadId)}`).catch(() => null);
    if (!up?.asset_id) { if (up?.status === 'errored' || up?.status === 'cancelled') await redis.hDel(intakeKey(slug), uploadId); continue; }
    const a = await muxReq(auth, `/video/v1/assets/${encodeURIComponent(up.asset_id)}`).catch(() => null);
    if (!a || a.status === 'errored') { await redis.hDel(intakeKey(slug), uploadId); continue; }
    if (a.status !== 'ready' || !(a.playback_ids || [])[0]?.id || !(Number(a.duration) > 10)) continue;
    await redis.hDel(intakeKey(slug), uploadId);
    started += await startVerticals(redis, slug, a, String(it.artist || '').toUpperCase().trim(), origin);
  }
  return started;
}
