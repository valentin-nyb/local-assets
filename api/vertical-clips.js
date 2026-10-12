import { pausedBy, sendPaused } from './_suspend.js';
import { createClient } from 'redis';
import { waitUntil } from '@vercel/functions';
import { getWebSessionAuth } from './_venues.js';
import { listAllAssets, sessionClips, startVerticals, cutVertical, verifyJob, venueAuth } from './_verticals.js';

// Vertical originals for a session, cut once from its full recording.
//   POST { action: 'start', artist, date }   (signed-in venue) starts the clips that aren't cut yet
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

  if (body.action !== 'start') return res.status(400).json({ error: 'Unknown action' });
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
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
    const started = await startVerticals(redis, session.venueSlug, master, artist, `https://${req.headers.host}`);
    return res.status(200).json({ started });
  } catch (e) {
    console.error('[vertical-clips]', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    await redis.quit().catch(() => {});
  }
}
