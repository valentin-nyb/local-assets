import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(400).json({ error: 'No venue found for this account' });

  const platform = req.query.platform;
  if (!['youtube', 'soundcloud'].includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform — must be "youtube" or "soundcloud"' });
  }

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    const key = platform === 'youtube'
      ? `youtube_token:${venueSlug}`
      : `sc_tokens:${venueSlug}`;
    await redis.del(key);
    return res.status(200).json({ ok: true, platform, venueSlug });
  } finally {
    await redis.quit().catch(() => {});
  }
}
