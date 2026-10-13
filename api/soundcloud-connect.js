import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail, getWebSessionAuth } from './_venues.js';

const REDIRECT_URI = 'https://local-assets.com/api/soundcloud-callback';

export default async function handler(req, res) {
  // Who is connecting comes from a real sign-in only: the dashboard session token, or the client portal
  // session cookie. An email in the link or a header is never trusted (anyone could type another's).
  let email = getWebSessionAuth(req)?.email || '';
  if (!email) {
    const sid = /(?:^|;\s*)la_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (sid) {
      const r = createClient({ url: process.env.REDIS_URL });
      await r.connect();
      try {
        const clientId = await r.get(`session:${decodeURIComponent(sid)}`);
        if (clientId) email = String(await r.hGet(`client:${clientId}`, 'email') || '');
      } finally { await r.quit().catch(() => {}); }
    }
  }
  if (!email) return res.status(401).json({ error: 'Sign in first, then connect SoundCloud.' });

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
