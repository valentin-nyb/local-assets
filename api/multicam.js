import { videoQuality } from './_video-quality.js';
import crypto from 'crypto';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { listAllAssets } from './_verticals.js';
import { seenKey } from './camera-relay.js';
import { playbackPolicy } from './_signing.js';

// Multi-camera edit: every long form of a session (same artist and date, filmed by several cameras at the
// same time) cut together into one full set, on the HQ audio from the DJ's console.
// The platform finds the recordings and queues the job; the venue's Mac (a™ for Mac, or relay/la-camera-relay.mjs)
// downloads them, lines each camera up with the HQ audio, cuts on the music's phrases, renders and
// uploads the edit back as the session's long form (camera "EDIT").
//   GET  ?artist=&date=                  what the session has and the edit's progress
//   POST { action:'start', artist, date } queue the edit

export const jobsKey = slug => `mc_jobs:${slug}`;     // hash: jobId → job
export const queueKey = slug => `mc_queue:${slug}`;   // list of jobIds waiting for the venue's Mac
const sessionKey = (slug, artist, date) => `mc_session:${slug}:${artist}|${date}`;
const SUB = ['AUDIO', 'SOCIAL', 'SOCIALRAW', 'THUMB', 'EDIT'];

const ptOf = a => { try { const o = JSON.parse(String(a.passthrough || '')); return o && typeof o === 'object' ? o : null; } catch { return null; } };
const hasTrack = (a, type) => (a.tracks || []).some(t => t.type === type);

// The session's camera recordings and its HQ audio
export function sessionSources(assets, artist, date) {
  const ready = assets.filter(a => a.status === 'ready' && (a.playback_ids || [])[0]?.id && Number(a.duration) > 10);
  const cams = ready.filter(a => { const o = ptOf(a); return o && String(o.artist || '').toUpperCase().trim() === artist && o.date === date && !SUB.includes(String(o.camera || 'MASTER').toUpperCase()) && hasTrack(a, 'video'); })
    .map(a => ({ id: a.id, pid: a.playback_ids[0].id, camera: String(ptOf(a).camera || 'MASTER').toUpperCase(), duration: Number(a.duration),
      hasAudio: hasTrack(a, 'audio'), recStart: a.recording_times?.[0]?.started_at ? Date.parse(a.recording_times[0].started_at) : (ptOf(a).start ? Date.parse(ptOf(a).start) : null) }))
    .sort((x, y) => (x.camera === 'MASTER' ? -1 : 0) - (y.camera === 'MASTER' ? -1 : 0) || x.camera.localeCompare(y.camera));
  const audio = ready.filter(a => { const o = ptOf(a); return o ? String(o.artist || '').toUpperCase().trim() === artist && o.date === date && String(o.camera || '').toUpperCase() === 'AUDIO'
    : String(a.passthrough || '').trim().toUpperCase() === `${artist} // AUDIO`; })
    .sort((a, b) => (ptOf(b) ? 1 : 0) - (ptOf(a) ? 1 : 0) || Number(b.created_at) - Number(a.created_at))[0];
  const edit = ready.find(a => { const o = ptOf(a); return o && String(o.artist || '').toUpperCase().trim() === artist && o.date === date && String(o.camera || '').toUpperCase() === 'EDIT'; });
  if (cams.length) { const m = cams.find(c => c.camera === 'MASTER') || cams[0]; cams.forEach(c => { c.main = c === m; }); }
  return { cams, audio: audio ? { id: audio.id, pid: audio.playback_ids[0].id, duration: Number(audio.duration) } : null, edit: edit ? { id: edit.id, pid: edit.playback_ids[0].id } : null };
}

// An edit the Mac stopped reporting on (a™ closed, the Mac asleep or offline): it reports every few seconds
// while it works, so after 10 minutes of silence the edit counts as failed and can be started again
const STALE_MS = 10 * 60e3;
export function settleStale(job) {
  if (job && job.status === 'running' && Date.now() - (job.updatedAt || 0) > STALE_MS)
    Object.assign(job, { status: 'failed', stage: 'Failed', message: 'The Mac stopped working on the edit (a™ was closed, or the Mac went to sleep or offline). Start it again.' });
  return job;
}

// Queues the edit for the venue's Mac. Without HQ audio from the console, the main camera's sound is
// the edit's sound, and the Mac also uploads it on its own as the session's HQ AUDIO.
export async function startMulticam(r, slug, auth, artist, date, src, { title = '', auto = false } = {}) {
  if (src.cams.length < 2) return { status: 400, error: 'A multi-camera edit needs at least two camera recordings of this session' };
  if (!src.audio && !src.cams.some(c => c.hasAudio)) return { status: 400, error: 'Upload the HQ audio from the DJ\'s console for this session first' };
  const prevId = await r.get(sessionKey(slug, artist, date));
  const prev = settleStale(prevId ? JSON.parse(await r.hGet(jobsKey(slug), prevId) || 'null') : null);
  if (prev && !['done', 'failed'].includes(prev.status)) return { status: 409, error: 'The edit is already ' + prev.status };
  const upload = async (camera, extra) => {
    const up = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ timeout: 604800, new_asset_settings: { playback_policy: playbackPolicy(), video_quality: await videoQuality(slug), passthrough: JSON.stringify({ artist, date, camera }), ...extra } }),
    }).then(x => x.json());
    if (!up?.data?.url) throw new Error('Mux did not create the upload: ' + (up?.error?.messages?.[0] || 'unknown'));
    return { id: up.data.id, url: up.data.url };
  };
  const job = { id: crypto.randomBytes(8).toString('hex'), slug, artist, date, title: String(title).slice(0, 80), auto, status: 'queued', stage: 'Waiting for the venue\'s Mac',
    pct: 0, createdAt: Date.now(), updatedAt: Date.now(), sources: src.cams, audio: src.audio,
    upload: await upload('EDIT', { max_resolution_tier: '2160p', name: `${artist} — ${date} · Multi-camera edit`, static_renditions: [{ resolution: 'highest' }] }),
    audioUpload: src.audio ? null : await upload('AUDIO', { name: `${artist} — ${date} · HQ audio`, static_renditions: [{ resolution: 'audio-only' }] }) };
  await r.hSet(jobsKey(slug), job.id, JSON.stringify(job));
  await r.set(sessionKey(slug, artist, date), job.id);
  await r.rPush(queueKey(slug), job.id);
  console.log('[multicam] queued', slug, artist, date, src.cams.length, 'cameras', src.audio ? 'HQ audio' : 'camera audio', auto ? '(automatic)' : '', job.id);
  return { job };
}

async function withRedis(fn) {
  const r = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await r.connect();
  try { return await fn(r); } finally { await r.quit().catch(() => {}); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  if (!session?.muxAuth) return res.status(401).json({ error: 'Not signed in' });
  const slug = session.venueSlug;
  const body = req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})) : {};
  const artist = String((req.method === 'POST' ? body.artist : req.query.artist) || '').toUpperCase().trim().slice(0, 80);
  const date = String((req.method === 'POST' ? body.date : req.query.date) || '');
  if (!artist || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose a session' });

  try {
    const assets = await listAllAssets(session.muxAuth);
    const src = sessionSources(assets, artist, date);
    const out = await withRedis(async r => {
      const seen = JSON.parse(await r.get(seenKey(slug)) || 'null');
      const relay = { online: !!seen && Date.now() - seen.at < 120e3, canRender: !!seen?.render, version: seen?.version || null };
      const jobId = await r.get(sessionKey(slug, artist, date));
      let job = jobId ? JSON.parse(await r.hGet(jobsKey(slug), jobId) || 'null') : null;
      if (job && job.status === 'running' && settleStale(job).status === 'failed') await r.hSet(jobsKey(slug), job.id, JSON.stringify(job));

      if (req.method === 'POST' && body.action === 'start') {
        const started = await startMulticam(r, slug, session.muxAuth, artist, date, src, { title: body.title });
        if (started.error) return started;
        job = started.job;
      }
      return { relay, job };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    const job = out.job ? { id: out.job.id, status: out.job.status, stage: out.job.stage, pct: out.job.pct, message: out.job.message || '', updatedAt: out.job.updatedAt, warnings: out.job.warnings || [] } : null;
    return res.status(200).json({ cameras: src.cams.map(c => ({ camera: c.camera, duration: c.duration, hasAudio: c.hasAudio, main: c.main })), audio: !!src.audio, edit: src.edit, relay: out.relay, job });
  } catch (e) {
    console.error('[multicam]', slug, e.message);
    return res.status(500).json({ error: 'Could not check this session' });
  }
}
