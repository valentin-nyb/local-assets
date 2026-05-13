import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// SoundCloud doesn't expose actual earnings via API.
// Estimate using SoundCloud Pro partner programme approximate rate.
const GBP_PER_PLAY = 0.004;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(200).json({ connected: false, plays: 0, estimatedRevenue: 0 });

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const raw = await redis.get(`sc_tokens:${venueSlug}`);
    if (!raw) return res.status(200).json({ connected: false, plays: 0, estimatedRevenue: 0 });

    const { access_token } = JSON.parse(raw);

    let totalPlays = 0;
    let nextUrl = 'https://api.soundcloud.com/me/tracks?limit=200&linked_partitioning=true';
    let pages = 0;
    while (nextUrl && pages < 10) {
      const r = await fetch(nextUrl, {
        headers: { Authorization: `OAuth ${access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) break;
      const data = await r.json();
      const tracks = Array.isArray(data) ? data : (data.collection || []);
      for (const t of tracks) totalPlays += Number(t.playback_count) || 0;
      nextUrl = data.next_href || null;
      pages++;
    }

    const estimatedRevenue = Math.round(totalPlays * GBP_PER_PLAY * 100) / 100;
    return res.status(200).json({ connected: true, plays: totalPlays, estimatedRevenue, currency: 'GBP' });
  } finally {
    await redis.quit();
  }
}
