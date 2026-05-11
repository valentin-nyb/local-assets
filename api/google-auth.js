import { createClient } from 'redis';
import crypto from 'crypto';

const REDIRECT_URI = 'https://local-assets.com/api/google-callback';

async function getRedis() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Google OAuth not configured' });

  const redis = await getRedis();
  try {
    const state = crypto.randomBytes(16).toString('hex');
    await redis.set(`oauth:state:${state}`, '1', { EX: 600 });

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  REDIRECT_URI,
      response_type: 'code',
      scope:         'openid email',
      state,
      access_type:   'online',
      prompt:        'select_account',
    });

    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    res.end();
  } finally {
    await redis.quit();
  }
}
