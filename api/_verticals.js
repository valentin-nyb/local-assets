import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { put, del as delBlob } from '@vercel/blob';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';

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

// The times the clips are cut at (same as the upload pipeline always used)
export function clipTimes(duration) {
  const count = Math.min(Math.floor(duration / 30), 5);
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
  const master = masters.find(a => day(a) === date) || masters[0] || null;
  const shown = new Map(), hidden = new Map();
  if (!master) return { master, shown, hidden };
  const next = masters.filter(a => Number(a.created_at) > Number(master.created_at)).pop();
  for (const a of assets) {
    const m = SUB.exec(String(a.passthrough || '').trim());
    if (!m || m[1].toUpperCase() !== artist) continue;
    if (Number(a.created_at) < Number(master.created_at) || (next && Number(a.created_at) >= Number(next.created_at))) continue;
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

// Starts one cutting job per clip that hasn't been cut yet; each runs in its own function
export async function startVerticals(redis, slug, master, artist, origin) {
  const pid = (master.playback_ids || [])[0]?.id;
  if (!pid) throw new Error('The full recording has no playback ID yet');
  const done = await redis.hGetAll(doneKey(master.id));
  const todo = clipTimes(Number(master.duration)).filter(t => !done[t.n]);
  await Promise.all(todo.map(t => fetch(`${origin}/api/vertical-clips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cut', job: signJob({ slug, masterId: master.id, pid, artist, n: t.n, start: t.start, end: t.end }) }),
    signal: AbortSignal.timeout(20000),
  }).catch(e => console.error('[verticals] start', t.n, e.message))));
  return todo.length;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err = (err + d).slice(-2000); });
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg: ' + err.trim().split('\n').pop())));
  });
}

// Cuts one vertical original: 9:16 centre crop of the full recording, 1080×1920, 30fps
export async function cutVertical(redis, auth, job) {
  const lock = `v_lock:${job.masterId}:${job.n}`;
  if (!(await redis.set(lock, '1', { NX: true, EX: 900 }))) return { skipped: 'already cutting' };
  if (await redis.hGet(doneKey(job.masterId), String(job.n))) return { skipped: 'already cut' };
  const out = path.join(os.tmpdir(), `v-${job.masterId}-${job.n}-${Date.now()}.mp4`);
  try {
    await run([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(job.start), '-t', String(job.end - job.start),
      '-i', `https://stream.mux.com/${job.pid}.m3u8?rendition_order=desc`,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'crop=trunc(ih*9/16/2)*2:ih,scale=1080:1920:flags=lanczos,setsar=1,fps=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
    ]);
    const blob = await put(`watermarks/${job.slug}/vertical-${crypto.randomBytes(6).toString('hex')}.mp4`, fs.createReadStream(out),
      { access: 'public', contentType: 'video/mp4', addRandomSuffix: false, multipart: true });
    // Hidden until it's ready; then it takes the clip's place (finishVerticals)
    const asset = await muxReq(auth, '/video/v1/assets', {
      method: 'POST',
      body: JSON.stringify({
        input: [{ url: blob.url }],
        playback_policy: ['public'],
        passthrough: tagFor(job.artist, job.n, true),
        static_renditions: [{ resolution: 'highest' }],
      }),
    });
    await redis.hSet(doneKey(job.masterId), String(job.n), asset.id);
    await redis.sAdd(originalsKey(job.slug), asset.id);
    await redis.hSet(jobsKey(job.slug), asset.id, JSON.stringify({ artist: job.artist, n: job.n, blob: blob.url, master: job.masterId, at: Date.now() }));
    return { id: asset.id };
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
        await muxReq(auth, `/video/v1/assets/${encodeURIComponent(other.id)}`, { method: 'DELETE' }).catch(() => {});
      }
      await muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ passthrough: tagFor(job.artist, job.n) }) });
      done++;
    } else {
      // Failed or gone: allow it to be cut again
      await redis.hDel(doneKey(job.master), String(job.n));
      await redis.sRem(originalsKey(slug), id);
    }
    if (job.blob) await delBlob(job.blob).catch(() => {});
    await redis.hDel(jobsKey(slug), id);
  }
  return { pending, done };
}
