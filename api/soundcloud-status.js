import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(200).json({ connected: false });

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    const raw = await redis.get(`sc_tokens:${venueSlug}`);
    return res.status(200).json({ connected: !!raw });
  } catch (e) {
    console.error('[soundcloud-status] Redis error:', e.message);
    return res.status(200).json({ connected: false });
  } finally {
    await redis.quit().catch(() => {});
  }
}
