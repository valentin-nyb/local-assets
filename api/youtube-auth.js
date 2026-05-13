import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail } from './_venues.js';

const REDIRECT_URI = 'https://local-assets.com/api/youtube-callback';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Email required' });

  const venue = findVenueByEmail(email);
  console.log('[youtube-auth] email:', email, 'venue:', venue?.name);
  if (!venue) return res.status(403).json({ error: 'No venue found for this email' });

  const venueSlug = venue.slug;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: 'Google OAuth not configured — set GOOGLE_CLIENT_ID in Vercel env vars' });
  }

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const state = crypto.randomBytes(16).toString('hex');
    await redis.set(`yt_oauth_state:${state}`, venueSlug, { EX: 600 });

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  REDIRECT_URI,
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
      state,
      access_type:   'offline',
      prompt:        'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    console.log('[youtube-auth] client_id:', clientId.slice(0, 20) + '...', 'redirect_uri:', REDIRECT_URI, 'authUrl:', authUrl);
    return res.status(200).json({ authUrl });
  } finally {
    await redis.quit();
  }
}
