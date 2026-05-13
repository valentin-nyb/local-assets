import { createClient } from 'redis';

const REDIRECT_URI = 'https://local-assets.com/api/youtube-callback';

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: '/dashboard?youtube=denied' });
    return res.end();
  }
  if (!code || !state) return res.status(400).send('Missing parameters');

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const venueSlug = await redis.get(`yt_oauth_state:${state}`);
    if (!venueSlug) {
      res.writeHead(302, { Location: '/dashboard?youtube=expired' });
      return res.end();
    }
    await redis.del(`yt_oauth_state:${state}`);

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      console.error('[youtube-callback] Token exchange failed:', tokens);
      res.writeHead(302, { Location: '/dashboard?youtube=error' });
      return res.end();
    }

    await redis.set(`youtube_token:${venueSlug}`, JSON.stringify({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    }), { EX: 60 * 60 * 24 * 365 });

    console.log(`[youtube-callback] Connected YouTube for venue: ${venueSlug}`);
    res.writeHead(302, { Location: '/dashboard?youtube=connected' });
    res.end();
  } finally {
    await redis.quit();
  }
}
