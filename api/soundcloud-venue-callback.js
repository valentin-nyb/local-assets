import { createClient } from 'redis';

const CALLBACK_URI = 'https://local-assets.com/api/soundcloud-venue-callback';

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: '/dashboard?soundcloud=denied' });
    return res.end();
  }
  if (!code || !state) return res.status(400).send('Missing parameters');

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const raw = await redis.get(`sc_oauth_state:${state}`);
    if (!raw) {
      res.writeHead(302, { Location: '/dashboard?soundcloud=expired' });
      return res.end();
    }
    await redis.del(`sc_oauth_state:${state}`);

    const { venueSlug, codeVerifier } = JSON.parse(raw);
    if (!venueSlug || !codeVerifier) {
      res.writeHead(302, { Location: '/dashboard?soundcloud=error' });
      return res.end();
    }

    // PKCE token exchange — secure.soundcloud.com endpoint
    const tokenRes = await fetch('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.SOUNDCLOUD_CLIENT_ID,
        client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
        redirect_uri:  CALLBACK_URI,
        code,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json();
    console.log('[soundcloud-venue-callback] token exchange status:', tokenRes.status, 'ok:', tokenRes.ok);
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[soundcloud-venue-callback] Token exchange failed:', JSON.stringify(tokenData));
      res.writeHead(302, { Location: '/dashboard?soundcloud=error' });
      return res.end();
    }

    await redis.set(`sc_tokens:${venueSlug}`, JSON.stringify({
      access_token:  tokenData.access_token,
      refresh_token: tokenData.refresh_token || '',
    }), { EX: 60 * 60 * 24 * 365 });

    console.log(`[soundcloud-venue-callback] Connected SoundCloud for venue: ${venueSlug}`);
    res.writeHead(302, { Location: '/dashboard?soundcloud=connected' });
    res.end();
  } finally {
    await redis.quit();
  }
}
