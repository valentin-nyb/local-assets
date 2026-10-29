import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { listLiveStreams } from './_live.js';
import { verticalsHealth } from './_verticals.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const verticals = async () => {
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    await redis.connect();
    try { return await verticalsHealth(redis, session.venueSlug); } finally { await redis.quit().catch(() => {}); }
  };
  const [cameras, clips] = await Promise.all([
    session.muxAuth
      ? listLiveStreams(session.muxAuth).catch(e => { console.error('[system-health] live', e.message); return null; })
      : Promise.resolve([]),
    session.venueSlug ? verticals().catch(e => { console.error('[system-health] verticals', e.message); return null; }) : Promise.resolve(null),
  ]);

  return res.status(200).json({ cameras, clips, timestamp: Date.now() });
}
