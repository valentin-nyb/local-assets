import { createClient } from 'redis';

// SoundCloud access tokens expire after about an hour; swap the refresh token
// for a new one and store it for the venue.
export async function refreshScToken(venueSlug, refreshToken) {
  const res = await fetch('https://secure.soundcloud.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.SOUNDCLOUD_CLIENT_ID,
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    await redis.set(`sc_tokens:${venueSlug}`, JSON.stringify({
      access_token:  data.access_token,
      refresh_token: data.refresh_token || refreshToken,
    }), { EX: 60 * 60 * 24 * 365 });
  } finally {
    await redis.quit().catch(() => {});
  }
  return data.access_token;
}
