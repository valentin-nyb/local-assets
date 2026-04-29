import { kv } from '@vercel/kv';
import crypto from 'crypto';

function parseCookie(str) {
  const obj = {};
  if (!str) return obj;
  str.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    obj[pair.substring(0, idx).trim()] = decodeURIComponent(pair.substring(idx + 1).trim());
  });
  return obj;
}

export default async function handler(req, res) {
  const cookie = parseCookie(req.headers.cookie || '');
  const sessionToken = cookie.la_session;
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

  const clientId = await kv.get(`session:${sessionToken}`);
  if (!clientId) return res.status(401).json({ error: 'Session expired' });

  if (!process.env.SOUNDCLOUD_CLIENT_ID) {
    return res.status(500).json({ error: 'SOUNDCLOUD_CLIENT_ID not configured' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  await kv.set(`soundcloud:state:${state}`, clientId, { ex: 300 });

  const params = new URLSearchParams({
    client_id: process.env.SOUNDCLOUD_CLIENT_ID,
    redirect_uri: 'https://local-assets.com/api/soundcloud-callback',
    response_type: 'code',
    scope: 'non-expiring',
    state,
  });

  res.writeHead(302, { Location: `https://soundcloud.com/connect?${params}` });
  res.end();
}
