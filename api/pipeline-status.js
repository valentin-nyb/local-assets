import { getPipelineDb } from './_pipeline-db.js';
import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(200).json([]);

  try {
    const db = getPipelineDb();
    const { jobId } = req.query;

    if (jobId) {
      const result = await db.query(
        `SELECT id, artist_name, venue_slug, status, done, total, uploaded, failed, error, updated_at
         FROM pipeline_jobs
         WHERE id = $1 AND venue_slug = $2
           AND (status NOT IN ('done', 'error') OR updated_at > now() - interval '1 hour')`,
        [jobId, venueSlug]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Job not found' });
      return res.status(200).json(formatJob(result.rows[0]));
    }

    const result = await db.query(
      `SELECT id, artist_name, venue_slug, status, done, total, uploaded, failed, error, updated_at
       FROM pipeline_jobs
       WHERE venue_slug = $1
         AND (status NOT IN ('done', 'error') OR updated_at > now() - interval '1 hour')
       ORDER BY updated_at DESC`,
      [venueSlug]
    );
    return res.status(200).json(result.rows.map(formatJob));
  } catch (e) {
    console.error('[pipeline-status] Database error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch pipeline status' });
  }
}

function formatJob(row) {
  return {
    jobId: row.id,
    artistName: row.artist_name,
    venueSlug: row.venue_slug,
    status: row.status,
    done: row.done,
    total: row.total,
    uploaded: row.uploaded,
    failed: row.failed,
    error: row.error,
    updatedAt: new Date(row.updated_at).getTime(),
  };
}
