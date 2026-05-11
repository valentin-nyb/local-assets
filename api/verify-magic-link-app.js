import { kv } from '@vercel/kv';
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing token' });
  }

  const email = await kv.get(`magic:${token}`);
  if (!email) {
    return res.status(401).json({ error: 'Token expired or already used' });
  }

  // Single-use: delete immediately
  await kv.del(`magic:${token}`);

  const clientId = await kv.get(`client:email:${email}`);
  if (!clientId) {
    return res.status(404).json({ error: 'No client profile found' });
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  await kv.set(`session:${sessionToken}`, clientId, { ex: 7 * 24 * 3600 });

  return res.status(200).json({ sessionToken });
}
