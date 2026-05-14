import { createClient } from 'redis';

const REDIRECT_URI = 'https://local-assets.com/api/soundcloud-callback';

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: '/client.html?soundcloud=denied' });
    return res.end();
  }

  if (!code || !state) return res.status(400).send('Missing parameters');

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const raw = await redis.get(`sc_state:${state}`);
    if (!raw) return res.status(400).send('Invalid or expired state. Please try connecting again.');
    await redis.del(`sc_state:${state}`);

    const { venueSlug, codeVerifier } = JSON.parse(raw);
    if (!venueSlug || !codeVerifier) return res.status(400).send('Invalid state data.');

    // PKCE token exchange — no client_secret
    const tokenRes = await fetch('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.SOUNDCLOUD_CLIENT_ID,
        client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        code,
        code_verifier: codeVerifier,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[soundcloud-callback] Token exchange failed:', tokenData);
      return res.status(500).send('Could not connect SoundCloud. Please try again.');
    }

    const meRes = await fetch('https://api.soundcloud.com/me', {
      headers: { Authorization: `OAuth ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const me = meRes.ok ? await meRes.json() : {};

    await redis.set(`sc_tokens:${venueSlug}`, JSON.stringify({
      access_token:      tokenData.access_token,
      refresh_token:     tokenData.refresh_token || '',
      soundcloudUserId:  String(me.id || ''),
      soundcloudUsername: me.username || me.permalink || '',
    }), { EX: 60 * 60 * 24 * 365 });

    console.log(`[soundcloud-callback] Connected @${me.username || me.id} for venue ${venueSlug}`);
    res.writeHead(302, { Location: '/client.html?soundcloud=connected' });
    res.end();
  } finally {
    await redis.quit();
  }
}
