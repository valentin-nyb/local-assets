import { getWebSessionAuth } from './_venues.js';
import { createClient } from 'redis';
import crypto from 'crypto';

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

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    // Pass venue's Mux credentials so the worker uses the right account per-venue
    const venueSlug = session.venueSlug || '';
    const muxAuth = session.venue
      ? { tokenId: session.venue.mux_token_id || '', tokenSecret: session.venue.mux_token_secret || '' }
      : null;
    const job = { jobId, uploadId, artistName: artist, venueSlug, muxAuth };
    await redis.lPush('pipeline:queue', JSON.stringify(job));
    await redis.set(
      `pipeline:job:${jobId}`,
      JSON.stringify({ done: 0, total: 30, status: 'queued', artistName: artist, venueSlug, updatedAt: Date.now() }),
      { EX: 7200 }
    );
    console.log(`[pipeline-trigger] Queued job ${jobId} for "${artist}" venue=${venueSlug}`);
    return res.status(200).json({ jobId });
  } catch (e) {
    console.error('[pipeline-trigger] Redis error:', e.message);
    return res.status(500).json({ error: 'Failed to queue pipeline job' });
  } finally {
    await redis.quit().catch(() => {});
  }
}
