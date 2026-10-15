import { pausedBy, sendPaused } from './_suspend.js';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig, getMuxAuthForVenue, platformAdmins, isAdminVenue } from './_venues.js';
import { calendarKey, cleanCalendarUrl, fetchEvents } from './_calendar.js';
import { listLiveStreams } from './_live.js';
import crypto from 'crypto';
import dns from 'dns';
import { viscaFor, isContinuous, privateHost } from './_visca.js';
import { relayKeyHash, cmdsKey, seenKey, tokenKey } from './camera-relay.js';
import { scheduleWindow } from './camera-schedule.js';

// The venue relay is online when it polled in the last 45 s
async function relayStatus(redis, slug) {
  const seen = JSON.parse(await redis.get(seenKey(slug)) || 'null');
  const hasKey = !!(await redis.get(tokenKey(slug)));
  return { set: hasKey, online: !!(seen && Date.now() - seen.at < 45000), lastSeen: seen?.at || null, version: seen?.version || '' };
}

// Venue cameras (OBSBOT Tail 2 with NDI HX3).
// Each camera has a Mux live stream that its video is sent to, either by the camera's own
// RTMP output or by a venue computer that picks up the camera's NDI feed (OBS + DistroAV).
// Camera details live in Redis under cameras:<venueSlug>; live status comes from Mux.

const MAX_CAMERAS = 16;
const RTMPS_URL = 'rtmps://global-live.mux.com:443/app';
const RTMP_URL  = 'rtmp://global-live.mux.com:5222/app';
// Our own ingest address: live.local-assets.com, a DNS alias (CNAME) of Mux's ingest. Used once the alias
// is in place; plain RTMP only (RTMPS checks Mux's certificate, which doesn't name our domain)
const OWN_RTMP_URL = 'rtmp://live.local-assets.com:5222/app';
let _ownIngest = { ok: false, at: 0 };
async function ownIngestReady() {
  if (Date.now() - _ownIngest.at < 10 * 60e3) return _ownIngest.ok;
  const ok = await dns.promises.resolveCname('live.local-assets.com').then(r => r.some(x => /(^|\.)mux\.com\.?$/i.test(x))).catch(() => false);
  _ownIngest = { ok, at: Date.now() };
  return ok;
}
const SRT_HOST  = 'srt://global-live.mux.com:6001';

const key = slug => `cameras:${slug}`;
// Which venue a Mux live stream belongs to, so the Mux webhook can find the camera when a recording ends
const STREAM_MAP = 'camera_streams';
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

// Every camera stream records: when the broadcast ends Mux saves it as an asset, which
// api/_camera-recording.js then names after the artist on stage and sends for vertical clips.
// How long Mux waits for a dropped stream before calling it ended: phones, own cameras and the decks are
// started and stopped by hand, so they end within seconds; a venue OBSBOT rides out short network drops
const reconnectFor = kind => (kind === 'obsbot' ? 60 : 10);
function newStreamBody(name, kind = 'obsbot') {
  return JSON.stringify({
    playback_policy: ['public'],
    latency_mode: 'low',
    reconnect_window: reconnectFor(kind),
    // Mux now takes one passthrough for the stream and its recordings; recordings keep this label until
    // each set is saved for its DJ (api/_camera-recording.js), so they never show as sessions on their own
    passthrough: 'CAMERA // RECORDING',
    new_asset_settings: { playback_policy: ['public'] },
  });
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
  if (req.method !== 'GET' && session?.venueSlug) { const _p = await pausedBy(session.venueSlug); if (_p) return sendPaused(res, _p); }
  const slug = session.venueSlug;
  const adminAll = req.method === 'GET' && platformAdmins().includes(session.email) && isAdminVenue(session.venue) && !session.venue?.actingAdmin;
  if (!adminAll && (!slug || !session.muxAuth)) return res.status(200).json({ cameras: [] });

  // A venue's cameras with their live status from Mux
  const venueCameras = async (vslug, auth) => {
    const [saved, streams] = await Promise.all([
      withRedis(r => readCameras(r, vslug)),
      listLiveStreams(auth),
    ]);
    if (saved.length) {
      await withRedis(r => r.hSet(STREAM_MAP, Object.fromEntries(saved.map(c => [c.streamId, vslug])))).catch(() => {});
    }
    const byId = new Map(streams.map(s => [s.id, s]));
    const cameras = saved.map(c => {
      const s = byId.get(c.streamId);
      byId.delete(c.streamId);
      return { ...c, status: s ? s.status : 'missing', playbackId: s?.playbackId || null, liveSince: s?.liveSince || null, recording: s ? s.recording : true };
    });
    // Streams created directly in Mux still show up, without camera details.
    for (const s of byId.values()) {
      cameras.push({ id: s.id, streamId: s.id, name: s.name || 'Camera', model: '', ndiName: '', ip: '', status: s.status, playbackId: s.playbackId, liveSince: s.liveSince || null, recording: s.recording, external: true });
    }
    return cameras;
  };

  try {
    // The local / assets admin account: every client's cameras, by account
    if (req.method === 'GET' && platformAdmins().includes(session.email) && isAdminVenue(session.venue) && !session.venue?.actingAdmin) {
      const cfg = getVenuesConfig();
      const venues = await Promise.all(Object.entries(cfg).filter(([k, v]) => !isAdminVenue({ slug: k, ...v })).map(async ([k, v]) => {
        const auth = getMuxAuthForVenue({ slug: k, ...v });
        if (!auth) return { slug: k, name: v.name || k, cameras: [], error: 'No Cloud Storage keys' };
        try { return { slug: k, name: v.name || k, cameras: await venueCameras(k, auth), relay: await withRedis(r => relayStatus(r, k)).catch(() => null) }; }
        catch (e) { return { slug: k, name: v.name || k, cameras: [], error: e.message }; }
      }));
      return res.status(200).json({ admin: true, venues, cameras: [], calendar: { connected: false } });
    }

    if (req.method === 'GET') {
      const cameras = await venueCameras(slug, session.muxAuth);
      // The venue calendar: who is on now, and the next sets
      let calendar = { connected: false };
      const calUrl = await withRedis(r => r.get(calendarKey(slug))).catch(() => null);
      if (calUrl) {
        calendar = { connected: true, host: new URL(calUrl).hostname };
        try {
          const now = Date.now();
          const events = await fetchEvents(calUrl, now - 12 * 3600e3, now + 60 * 86400e3);
          const cur = events.find(e => e.start <= now && e.end > now);
          calendar.current = cur ? { artist: cur.artist, venue: cur.venue, start: cur.start, end: cur.end } : null;
          calendar.upcoming = events.filter(e => e.start > now).slice(0, 6).map(e => ({ artist: e.artist, venue: e.venue, start: e.start, end: e.end }));
          // When the cameras that follow the calendar open and close
          const w = scheduleWindow(events, now);
          calendar.schedule = { open: w.open, closesAt: w.closesAt, opensAt: w.opensAt, nextArtist: w.next?.artist || null, currentArtist: w.current?.artist || null };
        } catch (e) { console.error('[cameras] calendar', slug, e.message); calendar.error = e.message || 'The calendar could not be read'; }
      }
      const relay = await withRedis(r => relayStatus(r, slug)).catch(() => null);
      return res.status(200).json({ cameras, calendar, relay });
    }

    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {};

    if (body.action === 'add' || body.action === 'update') {
      const name    = clean(body.name, 40);
      const ndiName = clean(body.ndiName, 80);
      // An OBSBOT (controllable over the venue network) or any other camera that streams RTMP:
      // a DJI Osmo, a Sony Alpha through a laptop, a phone…
      // …or the DJ mixer's sound ("audio"): its recordings become each session's HQ AUDIO
      const kind    = ['other', 'audio'].includes(body.kind) ? body.kind : 'obsbot';
      const ip      = kind === 'obsbot' ? clean(body.ip, 70) : '';
      const model   = kind === 'audio' ? 'Decks audio' : kind === 'other' ? (clean(body.model, 40) || 'Own camera') : 'OBSBOT Tail 2';
      if (!name) return res.status(400).json({ error: 'Give the camera a name' });
      if (!validHost(ip)) return res.status(400).json({ error: 'Camera address should look like 192.168.1.50' });

      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        if (body.action === 'update') {
          const cam = cams.find(c => c.id === body.id);
          if (!cam) return res.status(404).json({ error: 'Camera not found' });
          const kindChanged = (cam.kind || 'obsbot') !== kind;
          Object.assign(cam, { name, ndiName: kind === 'obsbot' ? ndiName : '', ip, kind, model });
          if (cam.streamId && (kindChanged || !cam.reconnectSet)) {
            await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`, { method: 'PATCH', body: JSON.stringify({ reconnect_window: reconnectFor(kind) }) }).catch(() => {});
            cam.reconnectSet = true;
          }
          if (typeof body.followCalendar === 'boolean') cam.followCalendar = body.followCalendar;
          await redis.set(key(slug), JSON.stringify(cams));
          return res.status(200).json({ camera: cam });
        }
        if (cams.length >= MAX_CAMERAS) return res.status(400).json({ error: `Up to ${MAX_CAMERAS} cameras per venue` });
        const stream = await mux(session.muxAuth, '/video/v1/live-streams', { method: 'POST', body: newStreamBody(name, kind) });
        const cam = {
          id: 'cam_' + stream.id.slice(0, 12),
          streamId: stream.id,
          name,
          model,
          kind,
          ndiName: kind === 'obsbot' ? ndiName : '',
          ip,
          artist: clean(body.artist, 60),
          autoClips: true,
          followCalendar: body.followCalendar !== false,
          createdAt: Date.now(),
        };
        cams.push(cam);
        await redis.set(key(slug), JSON.stringify(cams));
        await redis.hSet(STREAM_MAP, cam.streamId, slug);
        return res.status(200).json({ camera: cam });
      });
    }

    if (body.action === 'setCalendar') {
      // Empty link disconnects; otherwise the link must be a readable iCal calendar
      if (!String(body.url || '').trim()) {
        await withRedis(r => r.del(calendarKey(slug)));
        return res.status(200).json({ calendar: { connected: false } });
      }
      const url = cleanCalendarUrl(body.url);
      if (!url) return res.status(400).json({ error: 'Paste the calendar\'s iCal link (it starts with https:// or webcal://).' });
      try { await fetchEvents(url, Date.now(), Date.now() + 86400e3); }
      catch (e) { return res.status(400).json({ error: (/web page|calendar page|Google Calendar|answered/.test(e.message) ? e.message : 'That link could not be read as a calendar. Use the secret iCal address from Google Calendar, or a public link from Apple Calendar.') }); }
      await withRedis(r => r.set(calendarKey(slug), url));
      return res.status(200).json({ calendar: { connected: true, host: new URL(url).hostname } });
    }

    if (body.action === 'onStage') {
      // Who is playing in front of this camera. Changing it during a broadcast marks the moment,
      // and the recording is split there when it ends (one session per artist).
      const artist = clean(body.artist, 60).replace(/[<>]/g, '');
      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        const cam = cams.find(c => c.id === body.id);
        if (!cam) return res.status(404).json({ error: 'Camera not found' });
        const before = cam.artist || '';
        if (typeof body.autoClips === 'boolean') cam.autoClips = body.autoClips;
        cam.artist = artist;
        // Without a calendar: the session's name, venue and date, given to the recording when the stream ends
        cam.stageTitle = clean(body.title, 80).replace(/[<>]/g, '');
        cam.stageVenue = clean(body.venue, 60).replace(/[<>]/g, '');
        cam.stageDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : '';
        await redis.set(key(slug), JSON.stringify(cams));
        if (artist.toUpperCase() !== before.toUpperCase()) {
          const mk = `cam_markers:${cam.streamId}`;
          await redis.rPush(mk, JSON.stringify({ at: Date.now(), from: before, to: artist }));
          await redis.expire(mk, 60 * 60 * 24 * 14);
        }
        return res.status(200).json({ camera: cam });
      });
    }

    // "Preview now": opens a calendar camera's stream for 10 minutes between sets (api/camera-schedule.js keeps it open)
    if (body.action === 'preview') {
      return await withRedis(async redis => {
        const cam = (await readCameras(redis, slug)).find(c => c.id === body.id);
        if (!cam?.streamId) return res.status(404).json({ error: 'Camera not found' });
        await redis.set(`cam_preview:${cam.streamId}`, String(Date.now()), { EX: 600 });
        await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}/enable`, { method: 'PUT' }).catch(() => {});
        await redis.set(`cam_sched:${cam.streamId}`, 'enabled');
        return res.status(200).json({ ok: true, until: Date.now() + 600e3 });
      });
    }

    if (body.action === 'enableRecording') {
      // Streams created before recording was switched on: replace the stream with one that records.
      // Mux only takes recording settings when a stream is created, so the stream key changes.
      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        const cam = cams.find(c => c.id === body.id);
        if (!cam) return res.status(404).json({ error: 'Camera not found' });
        const old = await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`).catch(() => null);
        if (old?.status === 'active') return res.status(409).json({ error: 'Stop the camera\'s stream first, then turn on recording' });
        const stream = await mux(session.muxAuth, '/video/v1/live-streams', { method: 'POST', body: newStreamBody(cam.name) });
        await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`, { method: 'DELETE' })
          .catch(e => { if (!/404/.test(e.message)) console.error('[cameras] old stream delete:', e.message); });
        await redis.hDel(STREAM_MAP, cam.streamId);
        cam.streamId = stream.id;
        await redis.set(key(slug), JSON.stringify(cams));
        await redis.hSet(STREAM_MAP, cam.streamId, slug);
        return res.status(200).json({ camera: cam });
      });
    }

    if (body.action === 'connection') {
      // Stream key is a secret: only returned on request, to a signed-in user of this venue.
      const cams = await withRedis(r => readCameras(r, slug));
      const cam = cams.find(c => c.id === body.id);
      if (!cam) return res.status(404).json({ error: 'Camera not found' });
      const s = await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`);
      const own = await ownIngestReady();
      return res.status(200).json({
        rtmpsUrl: RTMPS_URL,
        rtmpUrl: own ? OWN_RTMP_URL : RTMP_URL,
        streamKey: s.stream_key,
        srtUrl: s.srt_passphrase ? `${SRT_HOST}?streamid=${s.stream_key}&passphrase=${s.srt_passphrase}` : null,
      });
    }

    if (body.action === 'control') {
      // Remote control: a VISCA command for one camera, passed on by the venue relay
      const bytes = viscaFor(body.cmd || {});
      if (!bytes) return res.status(400).json({ error: 'Unknown camera command' });
      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        const cam = cams.find(c => c.id === body.id);
        if (!cam) return res.status(404).json({ error: 'Camera not found' });
        const host = String(cam.ip || '').split(':')[0];
        if (!privateHost(host)) return res.status(400).json({ error: 'Add the camera\'s IP address on the venue network (like 192.168.1.50) in Edit first.' });
        const relay = await relayStatus(redis, slug);
        if (!relay.online) return res.status(409).json({ error: 'relay_offline', relay });
        await redis.rPush(cmdsKey(slug), JSON.stringify({ ip: host, bytes, hold: isContinuous(body.cmd), at: Date.now() }));
        await redis.lTrim(cmdsKey(slug), -50, -1);
        await redis.expire(cmdsKey(slug), 60);
        return res.status(200).json({ ok: true });
      });
    }

    if (body.action === 'relayKey') {
      // A new key for the venue relay (the old one stops working). Shown once.
      const secret = crypto.randomBytes(24).toString('base64url');
      await withRedis(r => r.set(tokenKey(slug), relayKeyHash(secret)));
      return res.status(200).json({ key: `${slug}.${secret}` });
    }

    if (body.action === 'relayStatus') {
      return res.status(200).json({ relay: await withRedis(r => relayStatus(r, slug)) });
    }

    if (body.action === 'remove') {
      return await withRedis(async redis => {
        const cams = await readCameras(redis, slug);
        const cam = cams.find(c => c.id === body.id);
        if (!cam) return res.status(404).json({ error: 'Camera not found' });
        await mux(session.muxAuth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}`, { method: 'DELETE' })
          .catch(e => { if (!/404/.test(e.message)) throw e; });
        await redis.set(key(slug), JSON.stringify(cams.filter(c => c.id !== cam.id)));
        await redis.hDel(STREAM_MAP, cam.streamId);
        return res.status(200).json({ ok: true });
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[cameras]', e.message);
    return res.status(502).json({ error: e.message });
  }
}
