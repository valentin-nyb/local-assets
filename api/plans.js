import { createClient } from 'redis';
import { readPlans, planForType } from './_billing.js';

// Public plan list for the home page (names, prices and what each includes), as edited in Billing → Plans.
// Nothing private: the same numbers the pricing section shows. Cached at the edge for a minute.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    const plans = (await readPlans(redis)).filter(p => p.id !== 'payg').map(p => ({
      id: p.id, name: p.name, price: Number(p.price) || 0, signupFee: Number(p.signupFee) || 0,
      maxClips: Number(p.maxClips) || 0, cameras: Number(p.cameras) || 0,
      included: { storedMinutes: Number(p.included?.storedMinutes) || 0, deliveredMinutes: Number(p.included?.deliveredMinutes) || 0, fileGB: Number(p.included?.fileGB) || 0 },
    }));
    // Each plan as an artist, a record label and a venue get it: price and what's included, in words
    const all = (await readPlans(redis)).filter(p => p.id !== 'payg');
    const byType = Object.fromEntries(['artist', 'label', 'venue'].map(t => [t, all.map(p => { const x = planForType(p, t); return { id: x.id, price: Number(x.price) || 0, features: x.features || [] }; })]));
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    return res.status(200).json({ plans, byType });
  } catch (e) {
    console.error('[plans]', e.message);
    return res.status(500).json({ error: 'Plans unavailable' });
  } finally { await redis.quit().catch(() => {}); }
}
