import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

async function refreshToken(redis, venueSlug, stored) {
  if (!stored.refresh_token) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) return null;
  const updated = { ...stored, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
  await redis.set(`yt_tokens:${venueSlug}`, JSON.stringify(updated), { EX: 60 * 60 * 24 * 365 });
  return updated;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(200).json({ connected: false, revenue: 0, views: 0 });

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const raw = await redis.get(`yt_tokens:${venueSlug}`);
    if (!raw) return res.status(200).json({ connected: false, revenue: 0, views: 0 });

    let stored = JSON.parse(raw);
    if (Date.now() > stored.expires_at - 60000) {
      stored = await refreshToken(redis, venueSlug, stored);
      if (!stored) return res.status(200).json({ connected: false, error: 'token_expired', revenue: 0, views: 0 });
    }

    const endDate   = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

    const analyticsRes = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?` +
      new URLSearchParams({ ids: 'channel==MINE', startDate, endDate, metrics: 'estimatedRevenue,views', currency: 'GBP' }),
      { headers: { Authorization: `Bearer ${stored.access_token}` }, signal: AbortSignal.timeout(15000) }
    );

    const analyticsData = await analyticsRes.json();
    if (!analyticsRes.ok) {
      console.error('[youtube-revenue] Analytics API error:', analyticsData.error?.message);
      // Channel is connected but not monetised — still report as connected
      return res.status(200).json({ connected: true, revenue: 0, views: 0, note: 'not_monetised' });
    }

    let revenue = 0, views = 0;
    for (const row of (analyticsData.rows || [])) {
      revenue += Number(row[0]) || 0;
      views   += Number(row[1]) || 0;
    }

    return res.status(200).json({ connected: true, revenue: Math.round(revenue * 100) / 100, views, currency: 'GBP' });
  } finally {
    await redis.quit();
  }
}
