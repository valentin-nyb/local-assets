import crypto from 'crypto';
import { createClient } from 'redis';
import { verifyWebToken, getWebSessionAuth, freshVenues } from './_venues.js';

// The venue relay (relay/la-camera-relay.mjs on the venue's computer) picks up camera commands here.
//   GET  ?wait=1   waits up to 20 s for commands, returns { commands: [{ ip, bytes, hold }] }
//   POST { seen }  heartbeat with the relay's version and the cameras it could reach
// Auth: "Authorization: Bearer <slug>.<secret>", the relay key made in Camera Control, or the sign-in token of
// a™ for Mac (signed in as the account itself), which runs the relay built in.

export const relayKeyHash = secret => crypto.createHash('sha256').update(String(secret)).digest('hex');
export const cmdsKey = slug => `cam_cmds:${slug}`;
export const seenKey = slug => `cam_relay_seen:${slug}`;
export const tokenKey = slug => `cam_relay_key:${slug}`;

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  // a™ for Mac is the relay too: it signs in like the website (the account's own sign-in token, not a relay key).
  // An artist with access to someone else's account can't run it for them.
  let app = null;
  if (raw.startsWith('eyJ') && verifyWebToken(raw)) {
    await freshVenues();
    const session = getWebSessionAuth(req);
    if (!session?.venueSlug || session.member) return res.status(403).json({ error: 'Only the account itself runs camera control and edits on its Mac' });
    app = session;
  }
  const dot = raw.indexOf('.');
  const slug = app ? app.venueSlug : dot > 0 ? raw.slice(0, dot) : '', secret = app ? '' : dot > 0 ? raw.slice(dot + 1) : '';
  if (!slug || !/^[A-Za-z0-9-]{1,60}$/.test(slug) || (!app && secret.length < 20)) return res.status(401).json({ error: 'Relay key missing' });

  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try {
    if (!app) {
      const want = await redis.get(tokenKey(slug));
      const got = relayKeyHash(secret);
      if (!want || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return res.status(401).json({ error: 'Relay key not valid. Make a new one in Camera Control.' });
    }

    const now = Date.now();
    // Multi-camera edits (api/multicam.js): the Mac mini takes the next job and reports its progress
    if (req.method === 'GET' && req.query.job) {
      const id = await redis.lPop(`mc_queue:${slug}`);
      const job = id ? JSON.parse(await redis.hGet(`mc_jobs:${slug}`, id) || 'null') : null;
      if (!job) return res.status(200).json({ job: null });
      Object.assign(job, { status: 'running', stage: 'Starting on the venue\'s Mac', pct: 0, updatedAt: now });
      await redis.hSet(`mc_jobs:${slug}`, id, JSON.stringify(job));
      return res.status(200).json({ job: { id: job.id, artist: job.artist, date: job.date, sources: job.sources, audio: job.audio, upload: job.upload, audioUpload: job.audioUpload || null } });
    }
    if (req.method === 'POST' && req.query.job) {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = String(body.id || '');
      const job = /^[a-f0-9]{16}$/.test(id) ? JSON.parse(await redis.hGet(`mc_jobs:${slug}`, id) || 'null') : null;
      if (!job) return res.status(404).json({ error: 'No such job' });
      const status = ['running', 'done', 'failed'].includes(body.status) ? body.status : job.status;
      Object.assign(job, { status, stage: String(body.stage || job.stage).slice(0, 120), pct: Math.max(0, Math.min(100, Number(body.pct) || 0)),
        message: String(body.message || '').slice(0, 400), updatedAt: now, warnings: Array.isArray(body.warnings) ? body.warnings.map(String).slice(0, 10) : (job.warnings || []) });
      await redis.hSet(`mc_jobs:${slug}`, id, JSON.stringify(job));
      if (status !== 'running') console.log('[multicam]', slug, id, status, job.message);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const reach = Array.isArray(body.reachable) ? body.reachable.map(String).slice(0, 32) : [];
      await redis.set(seenKey(slug), JSON.stringify({ at: now, version: String(body.version || '').slice(0, 20), reachable: reach, render: !!body.render, app: !!app }), { EX: 3600 });
      // Whether the account has network cameras to steer (OBSBOT with an address): a™ only waits for
      // camera commands then, so a Mac without them doesn't hold a connection open all day
      let cams = []; try { cams = JSON.parse(await redis.get(`cameras:${slug}`) || '[]'); } catch (_) {}
      return res.status(200).json({ ok: true, remote: cams.some(c => c && c.kind === 'obsbot' && String(c.ip || '').trim()) });
    }
    if (req.method !== 'GET') return res.status(405).end();

    // Polling counts as being online
    const prev = JSON.parse(await redis.get(seenKey(slug)) || '{}');
    await redis.set(seenKey(slug), JSON.stringify({ ...prev, at: now }), { EX: 3600 });
    // Commands waiting now, else wait for the next one (a blocking pop on its own connection)
    let items = await redis.lRange(cmdsKey(slug), 0, -1);
    if (items.length) await redis.lTrim(cmdsKey(slug), items.length, -1);
    else if (req.query.wait) {
      const b = redis.duplicate();
      await b.connect();
      try {
        const r = await b.blPop(cmdsKey(slug), 20);
        if (r) items = [r.element];
      } finally { await b.quit().catch(() => {}); }
    }
    const commands = items.map(x => { try { return JSON.parse(x); } catch { return null; } })
      .filter(c => c && Date.now() - c.at < 10000);   // stale commands (relay was away) are dropped
    return res.status(200).json({ commands });
  } catch (e) {
    console.error('[camera-relay]', slug, e.message);
    return res.status(500).json({ error: 'Relay error' });
  } finally {
    await redis.quit().catch(() => {});
  }
}
