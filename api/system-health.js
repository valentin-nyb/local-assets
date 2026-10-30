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
  // Only this account's own cameras (and decks), by their names: its Mux storage can hold other live streams
  // (an old stream, or one shared with another account), which showed as "live" here although no camera of
  // this account was on
  const ownCameras = async () => {
    const all = await listLiveStreams(session.muxAuth, { includeDisabled: true });   // closed ones count as off
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    await redis.connect();
    let cams = [];
    try { cams = JSON.parse(await redis.get(`cameras:${session.venueSlug}`) || '[]'); } catch { cams = []; } finally { await redis.quit().catch(() => {}); }
    const byId = new Map(cams.filter(c => c.streamId).map(c => [c.streamId, c]));
    return all.filter(s => byId.has(s.id)).map(s => ({ ...s, name: byId.get(s.id).name || s.name }));
  };
  const [cameras, clips] = await Promise.all([
    session.muxAuth && session.venueSlug
      ? ownCameras().catch(e => { console.error('[system-health] live', e.message); return null; })
      : Promise.resolve([]),
    session.venueSlug ? verticals().catch(e => { console.error('[system-health] verticals', e.message); return null; }) : Promise.resolve(null),
  ]);

  return res.status(200).json({ cameras, clips, timestamp: Date.now() });
}
