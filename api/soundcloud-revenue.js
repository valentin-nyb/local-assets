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

    // Account shown in the Connect Platforms panel
    let account = null;
    try {
      const me = await fetch('https://api.soundcloud.com/me', {
        headers: { Authorization: `OAuth ${access_token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (me.ok) {
        const u = await me.json();
        account = { name: u.username || u.full_name || '', avatar: u.avatar_url || '', tracks: Number(u.track_count) || 0 };
      }
    } catch (_) {}

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
    return res.status(200).json({ connected: true, plays: totalPlays, estimatedRevenue, account, currency: 'GBP' });
  } finally {
    await redis.quit();
  }
}
