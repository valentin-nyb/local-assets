import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { listLiveStreams } from './_live.js';

// Venue cameras (OBSBOT Tail 2 with NDI HX3).
// Each camera has a Mux live stream that its video is sent to, either by the camera's own
// RTMP output or by a venue computer that picks up the camera's NDI feed (OBS + DistroAV).
// Camera details live in Redis under cameras:<venueSlug>; live status comes from Mux.

const MAX_CAMERAS = 16;
const RTMPS_URL = 'rtmps://global-live.mux.com:443/app';
const RTMP_URL  = 'rtmp://global-live.mux.com:5222/app';
const SRT_HOST  = 'srt://global-live.mux.com:6001';

const key = slug => `cameras:${slug}`;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
// Camera addresses are only used as http://<ip>/ links on the venue network.
const validHost = v => !v || /^[a-zA-Z0-9.-]{1,63}(:\d{1,5})?$/.test(v);

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

async function readCameras(redis, slug) {
  try { return JSON.parse(await redis.get(key(slug)) || '[]'); } catch { return []; }
}

async function mux(muxAuth, path, init = {}) {
  const r = await fetch('https://api.mux.com' + path, {
    ...init,
    headers: { Authorization: muxAuth, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const body = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.messages?.[0] || `Cloud Storage error (${r.status})`);
  return body.data;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  const slug = session.venueSlug;
  if (!slug || !session.muxAuth) return res.status(200).json({ cameras: [] });

  try {
    if (req.method === 'GET') {
      const [saved, streams] = await Promise.all([
        withRedis(r => readCameras(r, slug)),
        listLiveStreams(session.muxAuth),
      ]);
      const byId = new Map(streams.map(s => [s.id, s]));
      const cameras = saved.map(c => {
        const s = byId.get(c.streamId);
        byId.delete(c.streamId);
        return { ...c, status: s ? s.status : 'missing', playbackId: s?.playbackId || null, liveSince: s?.liveSince || null };
      });
      // Streams created directly in Mux still show up, without camera details.
      for (const s of byId.values()) {
        cameras.push({ id: s.id, streamId: s.id, name: s.name || 'Camera', model: '', ndiName: '', ip: '', status: s.status, playbackId: s.playbackId, liveSince: s.liveSince || null, external: true });
      }
      return res.status(200).json({ cameras });
    }

    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};

    if (body.action === 'add' || body.action === 'update') {
      const name    = clean(body.name, 40);
      const ndiName = clean(body.ndiName, 80);
      const ip      = clean(body.ip, 70);
      if (!name) return res.status(400).json({ error: 'Give the camera a name' });
      if (!validHost(ip)) return res.status(400).json({ error: 'Camera address should look like 192.168.1.50' });

      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        if (body.action === 'update') {
          const cam = cams.find(c => c.id === body.id);
          if (!cam) return res.status(404).json({ error: 'Camera not found' });
          Object.assign(cam, { name, ndiName, ip });
          await redis.set(key(slug), JSON.stringify(cams));
          return res.status(200).json({ camera: cam });
        }
        if (cams.length >= MAX_CAMERAS) return res.status(400).json({ error: `Up to ${MAX_CAMERAS} cameras per venue` });
        const stream = await mux(session.muxAuth, '/video/v1/live-streams', {
          method: 'POST',
          body: JSON.stringify({
            playback_policy: ['public'],
            latency_mode: 'low',
            reconnect_window: 60,
            passthrough: name,
          }),
        });
        const cam = {
          id: 'cam_' + stream.id.slice(0, 12),
          streamId: stream.id,
          name,
          model: 'OBSBOT Tail 2',
          ndiName,
          ip,
          createdAt: Date.now(),
        };
        cams.push(cam);
        await redis.set(key(slug), JSON.stringify(cams));
        return res.status(200).json({ camera: cam });
      });
    }

    if (body.action === 'connection') {
      // Stream key is a secret: only returned on request, to a signed-in user of this venue.
      const cams = await withRedis(r => readCameras(r, slug));
      const cam = cams.find(c => c.id === body.id);
      if (!cam) return res.status(404).json({ error: 'Camera not found' });
      const s = await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`);
      return res.status(200).json({
        rtmpsUrl: RTMPS_URL,
        rtmpUrl: RTMP_URL,
        streamKey: s.stream_key,
        srtUrl: s.srt_passphrase ? `${SRT_HOST}?streamid=${s.stream_key}&passphrase=${s.srt_passphrase}` : null,
      });
    }

    if (body.action === 'remove') {
      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        const cam = cams.find(c => c.id === body.id);
        if (!cam) return res.status(404).json({ error: 'Camera not found' });
        await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`, { method: 'DELETE' })
          .catch(e => { if (!/404/.test(e.message)) throw e; });
        await redis.set(key(slug), JSON.stringify(cams.filter(c => c.id !== cam.id)));
        return res.status(200).json({ ok: true });
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[cameras]', e.message);
    return res.status(502).json({ error: e.message });
  }
}
