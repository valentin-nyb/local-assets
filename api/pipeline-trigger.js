import { getWebSessionAuth } from './_venues.js';
import crypto from 'crypto';
import { createClient } from 'redis';
import { intakeKey } from './_verticals.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const { uploadId, artistName } = req.body || {};
  if (!uploadId || !artistName) {
    return res.status(400).json({ error: 'uploadId and artistName required' });
  }

  const jobId  = crypto.randomBytes(8).toString('hex');
  const artist = artistName.toUpperCase().trim();

  // Vertical clips are cut by api/vertical-clips.js with this account's own Mux keys, once the
  // recording is ready (the old worker, which used shared keys, is retired).
  const venueSlug = session.venueSlug || '';
  if (!venueSlug) return res.status(403).json({ error: 'No Cloud Storage for this account' });
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  try {
    await redis.connect();
    await redis.hSet(intakeKey(venueSlug), String(uploadId), JSON.stringify({ artist, at: Date.now() }));
    console.log(`[pipeline-trigger] Intake ${uploadId} for "${artist}" venue=${venueSlug}`);
    return res.status(200).json({ jobId, intake: true });
  } catch (e) {
    console.error('[pipeline-trigger]', e.message);
    return res.status(500).json({ error: 'Failed to queue clip generation' });
  } finally {
    await redis.quit().catch(() => {});
  }
}
