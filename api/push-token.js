import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// The iPhone app's push notification token (la-native.js), kept per account so local / assets can tell
// the people of a venue when their clips are ready. Redis hash push_tokens:<venueSlug>: token → JSON.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const session = getWebSessionAuth(req);
  if (!session?.email || !session.venueSlug) return res.status(401).json({ error: 'Not authenticated' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const token = String(body.token || '');
  if (!/^[A-Fa-f0-9]{32,200}$/.test(token)) return res.status(400).json({ error: 'Invalid token' });
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try {
    await redis.hSet(`push_tokens:${session.venueSlug}`, token, JSON.stringify({
      email: session.email, artist: session.member?.name || null, platform: body.platform === 'ios' ? 'ios' : 'other', at: new Date().toISOString(),
    }));
    return res.status(200).json({ ok: true });
  } finally { await redis.quit().catch(() => {}); }
}
