import { createClient } from 'redis';
import crypto from 'crypto';
import { getWebSessionAuth } from './_venues.js';

const CALLBACK_URI = 'https://local-assets.com/api/soundcloud-venue-callback';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug) return res.status(400).json({ error: 'No venue associated with this account' });

  if (!process.env.SOUNDCLOUD_CLIENT_ID) {
    return res.status(500).json({ error: 'SOUNDCLOUD_CLIENT_ID not configured' });
  }

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const state = crypto.randomBytes(16).toString('hex');
    await redis.set(`sc_oauth_state:${state}`, session.venueSlug, { EX: 300 });

    const params = new URLSearchParams({
      client_id:     process.env.SOUNDCLOUD_CLIENT_ID,
      redirect_uri:  CALLBACK_URI,
      response_type: 'code',
      scope:         'non-expiring',
      state,
    });

    return res.status(200).json({ authUrl: `https://soundcloud.com/connect?${params}` });
  } finally {
    await redis.quit();
  }
}
