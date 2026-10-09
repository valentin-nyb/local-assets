import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// Editable session details (name and venue) for Distribution History.
// Stored per account in Redis hash session_meta:<venueSlug>, keyed "ARTIST|YYYY-MM-DD".
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  const slug = session.venueSlug;
  if (!slug) return res.status(403).json({ error: 'No venue for this account' });
  const key = `session_meta:${slug}`;

  try {
    if (req.method === 'GET') {
      const raw = await withRedis(r => r.hGetAll(key));
      const sessions = {};
      for (const [k, v] of Object.entries(raw || {})) { try { sessions[k] = JSON.parse(v); } catch {} }
      return res.status(200).json({ sessions });
    }
    if (req.method !== 'POST') return res.status(405).end();

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const artist = clean(body.artist, 80).toUpperCase();
    const date = String(body.date || '');
    if (!artist || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid session' });
    const meta = { title: clean(body.title, 80), venue: clean(body.venue, 60) };
    const field = `${artist}|${date}`;
    await withRedis(r => (meta.title || meta.venue) ? r.hSet(key, field, JSON.stringify(meta)) : r.hDel(key, field));
    return res.status(200).json({ key: field, meta });
  } catch (e) {
    console.error('[session-meta]', e.message);
    return res.status(500).json({ error: 'Could not save' });
  }
}
