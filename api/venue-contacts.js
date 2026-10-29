import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// Contacts the account's artists can call or email (venue manager, sound engineer, bookings…).
// Stored per account in Redis as contacts:<venueSlug>, a JSON list of up to 4.
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

async function withRedis(fn) {
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  const slug = session.venueSlug;
  if (!slug) return res.status(403).json({ error: 'No venue for this account' });
  const key = `contacts:${slug}`;

  try {
    if (req.method === 'GET') {
      let contacts = [];
      try { contacts = JSON.parse(await withRedis(r => r.get(key)) || '[]'); } catch {}
      return res.status(200).json({ contacts: Array.isArray(contacts) ? contacts : [] });
    }
    if (req.method !== 'POST') return res.status(405).end();
    // Artists with access see the contacts; the account sets them
    if (session.member) return res.status(403).json({ error: 'Only the account can do this' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const contacts = (Array.isArray(body.contacts) ? body.contacts : []).slice(0, 4).map(c => ({
      role: clean(c?.role, 40),
      name: clean(c?.name, 60),
      phone: clean(c?.phone, 30).replace(/[^\d+()\-\s]/g, ''),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(c?.email, 120)) ? clean(c.email, 120) : '',
    })).filter(c => c.phone || c.email);
    await withRedis(r => contacts.length ? r.set(key, JSON.stringify(contacts)) : r.del(key));
    return res.status(200).json({ contacts });
  } catch (e) {
    console.error('[venue-contacts]', e.message);
    return res.status(500).json({ error: 'Could not save' });
  }
}
