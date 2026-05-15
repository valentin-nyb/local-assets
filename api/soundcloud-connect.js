import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail } from './_venues.js';

const REDIRECT_URI = 'https://local-assets.com/api/soundcloud-callback';

export default async function handler(req, res) {
  const email = req.query.email || req.headers['x-user-email'] || '';
  if (!email) return res.status(401).json({ error: 'Email required' });

  const venue = findVenueByEmail(email);
  if (!venue) return res.status(403).json({ error: 'No venue found for this email' });

  if (!process.env.SOUNDCLOUD_CLIENT_ID) {
    return res.status(503).json({ error: 'SOUNDCLOUD_CLIENT_ID not configured' });
  }

  // PKCE: generate verifier + challenge
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state         = crypto.randomBytes(16).toString('hex');

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    await redis.set(`sc_state:${state}`, JSON.stringify({ venueSlug: venue.slug, codeVerifier }), { EX: 600 });
  } finally {
    await redis.quit();
  }

  const params = new URLSearchParams({
    client_id:             process.env.SOUNDCLOUD_CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    response_type:         'code',
    code_challenge_method: 'S256',
    code_challenge:        codeChallenge,
    state,
    scope:                 'non-expiring',
  });

  res.redirect(`https://secure.soundcloud.com/authorize?${params}`);
}
