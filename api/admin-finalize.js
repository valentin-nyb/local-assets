import { createClient } from 'redis';

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

    return res.status(200).json({ ok: true, ...data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  } finally {
    await redis.quit();
  }
}
