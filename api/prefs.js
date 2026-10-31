import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// How the app looks for one person, kept with their login so it's the same on every device
// (side menu → the accent dots → Save). Redis hash ui_prefs:<email>.
//   GET                        { accent }
//   POST { accent }            saved ('' = the original neon green, or the person's own colour as #RRGGBB)
const ACCENTS = ['', 'yellow', 'orange', 'red', 'pink', 'indigo', 'blue', 'teal'];
const ok = a => ACCENTS.includes(a) || /^#[0-9a-f]{6}$/.test(a);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const key = `ui_prefs:${session.email}`;
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const accent = String(body.accent ?? '').toLowerCase();
      if (!ok(accent)) return res.status(400).json({ error: 'Pick one of the accent colours' });
      await redis.hSet(key, 'accent', accent);
      return res.status(200).json({ accent });
    }
    const p = await redis.hGetAll(key);
    return res.status(200).json({ accent: ok(p?.accent || '') ? p.accent : '' });
  } finally { await redis.quit().catch(() => {}); }
}
