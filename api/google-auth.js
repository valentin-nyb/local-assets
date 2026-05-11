import { kv } from '@vercel/kv';
import crypto from 'crypto';

const REDIRECT_URI = 'https://local-assets.com/api/google-callback';

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Google OAuth not configured' });

  // CSRF state — verified in the callback
  const state = crypto.randomBytes(16).toString('hex');
  await kv.set(`oauth:state:${state}`, '1', { ex: 600 });

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
}
