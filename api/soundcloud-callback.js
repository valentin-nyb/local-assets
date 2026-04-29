import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: '/client.html?soundcloud=denied' });
    return res.end();
  }

  if (!code || !state) return res.status(400).send('Missing parameters');

  const clientId = await kv.get(`soundcloud:state:${state}`);
  if (!clientId) return res.status(400).send('Invalid or expired state. Please try connecting again.');
  await kv.del(`soundcloud:state:${state}`);

  const tokenRes = await fetch('https://api.soundcloud.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: process.env.SOUNDCLOUD_CLIENT_ID,
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://local-assets.com/api/soundcloud-callback',
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('[SoundCloud] Token exchange failed:', tokenData);
    return res.status(500).send('Could not connect SoundCloud. Please try again.');
  }

  const meRes = await fetch('https://api.soundcloud.com/me', {
    headers: { Authorization: `OAuth ${tokenData.access_token}`, Accept: 'application/json' }
  });
  const me = meRes.ok ? await meRes.json() : {};

  await kv.hset(`client:${clientId}`, {
    soundcloudToken: tokenData.access_token,
    soundcloudRefreshToken: tokenData.refresh_token || '',
    soundcloudUserId: String(me.id || ''),
    soundcloudUsername: me.username || me.permalink || '',
  });

  console.log(`[SoundCloud] Connected @${me.username || me.id} for client ${clientId}`);

  res.writeHead(302, { Location: '/client.html?soundcloud=connected' });
  res.end();
}
