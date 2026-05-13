import { createClient } from 'redis';
import crypto from 'crypto';
import { getWebSessionAuth } from './_venues.js';

const REDIRECT_URI = 'https://local-assets.com/api/youtube-callback';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug) return res.status(400).json({ error: 'No venue associated with this account' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Google OAuth not configured' });

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const state = crypto.randomBytes(16).toString('hex');
    await redis.set(`yt_oauth_state:${state}`, session.venueSlug, { EX: 600 });

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  REDIRECT_URI,
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/yt-analytics.readonly',
      state,
      access_type:   'offline',
      prompt:        'consent',
    });

    return res.status(200).json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  } finally {
    await redis.quit();
  }
}
