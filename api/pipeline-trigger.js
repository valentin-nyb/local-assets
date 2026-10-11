import { getWebSessionAuth } from './_venues.js';
import { getPipelineDb } from './_pipeline-db.js';
import crypto from 'crypto';
import { createClient } from 'redis';
import { resolveWatermark } from './_watermark.js';

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

  try {
    const venueSlug = session.venueSlug || '';
    // Brand Kit watermark for this artist's clips (null when off or no logo uploaded)
    let watermark = null;
    if (venueSlug) {
      const redis = createClient({ url: process.env.REDIS_URL });
      try { await redis.connect(); watermark = await resolveWatermark(redis, venueSlug, artist); }
      catch (e) { console.error('[pipeline-trigger] watermark skipped:', e.message); }
      finally { await redis.quit().catch(() => {}); }
    }
    const db = getPipelineDb();
    await db.query(
      `INSERT INTO pipeline_jobs (id, upload_id, artist_name, venue_slug, watermark)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, uploadId, artist, venueSlug, watermark && JSON.stringify(watermark)]
    );
    console.log(`[pipeline-trigger] Queued job ${jobId} for "${artist}" venue=${venueSlug}`);
    return res.status(200).json({ jobId });
  } catch (e) {
    console.error('[pipeline-trigger] Database error:', e.message);
    return res.status(500).json({ error: 'Failed to queue pipeline job' });
  }
}
