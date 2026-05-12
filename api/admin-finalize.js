import { createClient } from 'redis';
import { findVenueByEmail, signWebToken } from './_venues.js';

async function getRedis() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const redis = await getRedis();
  try {
    const raw = await redis.get(`web:pending:${token}`);
    if (!raw) return res.status(401).json({ error: 'Invalid or expired token' });

    await redis.del(`web:pending:${token}`);
    const data = JSON.parse(raw);

    // Issue a short-lived signed token so API endpoints can resolve the venue + Mux creds
    const venue    = findVenueByEmail(data.email);
    const webToken = signWebToken(data.email, venue?.slug || '');

    return res.status(200).json({ ok: true, ...data, webToken });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    await redis.quit();
  }
}
