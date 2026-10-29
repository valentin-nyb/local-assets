import crypto from 'crypto';
import { createClient } from 'redis';
import { getWebSessionAuth, framePass } from './_venues.js';

// A camera's live picture for Camera Control, sent by the a™ app every few seconds while the camera is
// linked on a Mac (also between sets, when nothing is recorded). Nothing is stored for long: each frame
// lives 20 seconds.
//   POST  (the app)       headers X-LA-Cam: <slug>.<camId>, X-LA-Pass: <framePass>; body: the JPEG
//   GET   ?cam=<camId>    (a signed-in user of that account) → { src, at } or 204
const key = (slug, camId) => `cam_frame:${slug}:${camId}`;
const MAX = 400 * 1024;

async function withRedis(fn) {
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      const [slug, camId] = String(req.headers['x-la-cam'] || '').split('.');
      const pass = String(req.headers['x-la-pass'] || '');
      if (!slug || !camId || !/^[A-Za-z0-9-]{1,80}$/.test(slug) || !/^[A-Za-z0-9_-]{1,80}$/.test(camId)) return res.status(400).json({ error: 'Bad camera' });
      const want = framePass(slug, camId);
      if (pass.length !== want.length || !crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(want))) return res.status(403).json({ error: 'Not allowed' });
      const body = await rawBody(req);
      if (body.length < 100 || body[0] !== 0xff || body[1] !== 0xd8) return res.status(400).json({ error: 'Not a JPEG' });
      const ok = await withRedis(async r => {
        const cams = JSON.parse(await r.get(`cameras:${slug}`) || '[]');
        if (!cams.some(c => c.id === camId)) return false;   // the camera was removed: the app stops sending
        await r.set(key(slug, camId), JSON.stringify({ at: Date.now(), jpg: body.toString('base64') }), { EX: 20 });
        return true;
      });
      return ok ? res.status(204).end() : res.status(404).json({ error: 'Camera not found' });
    }
    if (req.method === 'GET') {
      const session = getWebSessionAuth(req);
      if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
      const slug = session.venueSlug, camId = String(req.query?.cam || '');
      if (!slug || !/^[A-Za-z0-9_-]{1,80}$/.test(camId)) return res.status(400).json({ error: 'Bad camera' });
      const raw = await withRedis(r => r.get(key(slug, camId)));
      if (!raw) return res.status(204).end();
      const f = JSON.parse(raw);
      return res.status(200).json({ at: f.at, src: 'data:image/jpeg;base64,' + f.jpg });
    }
    return res.status(405).end();
  } catch (e) {
    console.error('[camera-frame]', e.message);
    return res.status(500).json({ error: 'Could not handle the frame' });
  }
}
