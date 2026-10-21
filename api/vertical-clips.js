import { pausedBy, sendPaused } from './_suspend.js';
import { createClient } from 'redis';
import { waitUntil } from '@vercel/functions';
import { getWebSessionAuth } from './_venues.js';
import { listAllAssets, sessionClips, startVerticals, startMoments, cutVertical, verifyJob, venueAuth, finishVerticals, processIntakes } from './_verticals.js';
import { planMaxClips } from './_billing.js';

// Vertical originals for a session, cut once from its full recording.
//   POST { action: 'start', artist, date }   (signed-in venue) starts the clips that aren't cut yet
//   POST { action: 'moments', artist, date, times } cuts clips at the moments picked (seconds), replacing clips 1…n
//   POST { action: 'cut', job }              (signed job from 'start' or the Mux webhook) cuts one clip

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  if (body.action === 'cut') {
    const job = verifyJob(body.job);
    if (!job) return res.status(401).json({ error: 'Invalid job' });
    const auth = venueAuth(job.slug);
    if (!auth) return res.status(403).json({ error: 'No Cloud Storage for this venue' });
    // Answer straight away; the cut carries on in this function
    waitUntil((async () => {
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      try {
        const out = await cutVertical(redis, auth, job);
        console.log('[vertical-clips]', job.slug, job.artist, job.n, JSON.stringify(out));
      } catch (e) {
        console.error('[vertical-clips] cut failed', job.slug, job.artist, job.n, e.message);
      } finally {
        await redis.quit().catch(() => {});
      }
    })());
    return res.status(202).json({ started: true });
  }

  if (body.action !== 'start' && body.action !== 'moments' && body.action !== 'limits' && body.action !== 'intake') return res.status(400).json({ error: 'Unknown action' });
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (body.action === 'limits') {
    // The plan's clip limit, and how many the recording is long enough for
    const r0 = createClient({ url: process.env.REDIS_URL }); await r0.connect();
    try {
      const max = await planMaxClips(r0, session.venueSlug);
      const { master } = session.muxAuth ? sessionClips(await listAllAssets(session.muxAuth), String(body.artist || '').toUpperCase().trim(), String(body.date || '')) : {};
      const fits = master ? Math.max(1, Math.floor(Number(master.duration) / 30)) : max;
      // The recording itself, so the moments can be picked from its frames
      return res.status(200).json({ max: Math.min(max, fits), planMax: max, unlimited: max >= 60, pid: (master?.playback_ids || [])[0]?.id || null, duration: Number(master?.duration) || 0 });
    } finally { await r0.quit().catch(() => {}); }
  }
  if (body.action === 'intake') {
    // New uploads whose recording is now ready start their vertical clips (once)
    if (!session.venueSlug || !session.muxAuth) return res.status(200).json({ started: 0 });
    const r1 = createClient({ url: process.env.REDIS_URL }); await r1.connect();
    try {
      const started = await processIntakes(r1, session.venueSlug, session.muxAuth, `https://${req.headers.host}`);
      if (started) console.log('[vertical-clips] intake', session.venueSlug, 'started', started);
      return res.status(200).json({ started });
    } catch (e) { console.error('[vertical-clips] intake', e.message); return res.status(200).json({ started: 0 }); }
    finally { await r1.quit().catch(() => {}); }
  }
  if (req.method !== 'GET' && session?.venueSlug) { const _p = await pausedBy(session.venueSlug); if (_p) return sendPaused(res, _p); }
  if (!session.venueSlug || !session.muxAuth) return res.status(403).json({ error: 'No Cloud Storage for this account' });
  const artist = String(body.artist || '').toUpperCase().trim();
  if (!artist) return res.status(400).json({ error: 'Choose a session' });
  { const _p = await pausedBy(session.venueSlug, `artist:${artist}`); if (_p) return sendPaused(res, _p); }

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const { master } = sessionClips(await listAllAssets(session.muxAuth), artist, String(body.date || ''));
    if (!master) return res.status(400).json({ error: 'The full recording of this session is not in Cloud Storage.' });
    // Finish or clear earlier attempts first, so a retry always starts the clips that are still missing
    await finishVerticals(redis, session.venueSlug, session.muxAuth, await listAllAssets(session.muxAuth)).catch(e => console.error('[vertical-clips] finish', e.message));
    const max = await planMaxClips(redis, session.venueSlug);
    if (body.action === 'moments') {
      const times = (Array.isArray(body.times) ? body.times : []).map(Number).filter(t => isFinite(t) && t >= 0).slice(0, max);
      if (!times.length) return res.status(400).json({ error: 'Pick at least one moment' });
      const started = await startMoments(redis, session.venueSlug, master, artist, `https://${req.headers.host}`, times);
      return res.status(200).json({ started });
    }
    const count = Math.min(max, Math.max(1, Math.round(Number(body.count) || max)));
    const started = await startVerticals(redis, session.venueSlug, master, artist, `https://${req.headers.host}`, true, count);
    console.log('[vertical-clips] start', session.venueSlug, artist, master.id, 'started', started, 'status', master.status, 'policy', (master.playback_ids || [])[0]?.policy);
    return res.status(200).json({ started });
  } catch (e) {
    console.error('[vertical-clips]', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    await redis.quit().catch(() => {});
  }
}
