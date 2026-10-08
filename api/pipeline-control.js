import { getWebSessionAuth } from './_venues.js';
import { getPipelineDb } from './_pipeline-db.js';

const ACTIVE = ['queued', 'waiting', 'processing'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug) return res.status(403).json({ error: 'No venue for this session' });

  const { jobId, action } = req.body || {};
  if (typeof jobId !== 'string' || !/^[a-f0-9]{16}$/.test(jobId)) {
    return res.status(400).json({ error: 'Valid jobId required' });
  }
  if (action !== 'cancel' && action !== 'restart') {
    return res.status(400).json({ error: 'action must be cancel or restart' });
  }

  try {
    const db = getPipelineDb();

    // Deleting the row makes a running worker lose its lease and abort.
    const result = action === 'cancel'
      ? await db.query(
          `DELETE FROM pipeline_jobs
           WHERE id = $1 AND venue_slug = $2 AND status = ANY($3)
           RETURNING id`,
          [jobId, session.venueSlug, ACTIVE]
        )
      : await db.query(
          `UPDATE pipeline_jobs
           SET status = 'queued', done = 0, uploaded = 0, failed = 0, error = NULL,
               locked_by = NULL, lease_until = NULL, updated_at = now()
           WHERE id = $1 AND venue_slug = $2 AND status <> 'done'
           RETURNING id`,
          [jobId, session.venueSlug]
        );

    if (!result.rowCount) {
      return res.status(409).json({ error: 'Job not found or not in a state that allows this action' });
    }
    console.log(`[pipeline-control] ${action} job ${jobId} venue=${session.venueSlug}`);
    return res.status(200).json({ jobId, action });
  } catch (e) {
    console.error('[pipeline-control] Database error:', e.message);
    return res.status(500).json({ error: 'Failed to update pipeline job' });
  }
}
