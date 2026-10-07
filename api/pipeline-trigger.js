import { getWebSessionAuth } from './_venues.js';
import { getPipelineDb } from './_pipeline-db.js';
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

  try {
    const venueSlug = session.venueSlug || '';
    const db = getPipelineDb();
    await db.query(
      `INSERT INTO pipeline_jobs (id, upload_id, artist_name, venue_slug)
       VALUES ($1, $2, $3, $4)`,
      [jobId, uploadId, artist, venueSlug]
    );
    console.log(`[pipeline-trigger] Queued job ${jobId} for "${artist}" venue=${venueSlug}`);
    return res.status(200).json({ jobId });
  } catch (e) {
    console.error('[pipeline-trigger] Database error:', e.message);
    return res.status(500).json({ error: 'Failed to queue pipeline job' });
  }
}
