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
    const venueSlug = await redis.get(`sc_oauth_state:${state}`);
    if (!venueSlug) {
      res.writeHead(302, { Location: '/dashboard?soundcloud=expired' });
      return res.end();
    }
    await redis.del(`sc_oauth_state:${state}`);

    const tokenRes = await fetch('https://api.soundcloud.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id:     process.env.SOUNDCLOUD_CLIENT_ID,
        client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  CALLBACK_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[soundcloud-venue-callback] Token exchange failed:', tokenData);
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
