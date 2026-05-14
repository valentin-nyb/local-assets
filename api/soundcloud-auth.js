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
    return res.status(503).json({ error: 'SoundCloud integration not yet enabled — set SOUNDCLOUD_CLIENT_ID in Vercel env vars' });
  }

  // PKCE
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state         = crypto.randomBytes(16).toString('hex');

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    await redis.set(`sc_oauth_state:${state}`, JSON.stringify({
      venueSlug:    session.venueSlug,
      codeVerifier,
    }), { EX: 600 });

    const params = new URLSearchParams({
      client_id:             process.env.SOUNDCLOUD_CLIENT_ID,
      redirect_uri:          CALLBACK_URI,
      response_type:         'code',
      code_challenge_method: 'S256',
      code_challenge:        codeChallenge,
      state,
    });

    console.log('[soundcloud-auth] venue:', session.venueSlug, 'callback:', CALLBACK_URI);
    return res.status(200).json({ authUrl: `https://secure.soundcloud.com/authorize?${params}` });
  } finally {
    await redis.quit();
  }
}
