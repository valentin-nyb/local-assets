import { getWebSessionAuth } from './_venues.js';
import { listLiveStreams } from './_live.js';
import { getPipelineDb } from './_pipeline-db.js';

// A queued clip job that nobody has picked up for this long means the clip worker is not running.
const STALLED_AFTER_MIN = 10;

async function getPipelineHealth(venueSlug) {
  const db = getPipelineDb();
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE status = 'queued')                                        AS queued,
       count(*) FILTER (WHERE status NOT IN ('queued', 'done', 'error', 'cancelled'))   AS running,
       count(*) FILTER (WHERE status = 'error' AND updated_at > now() - interval '24 hours') AS failed,
       count(*) FILTER (WHERE status = 'done'  AND updated_at > now() - interval '24 hours') AS done,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued')) / 60   AS oldest_queued_min
     FROM pipeline_jobs WHERE venue_slug = $1`,
    [venueSlug]
  );
  const r = rows[0] || {};
  const oldest = r.oldest_queued_min == null ? null : Math.round(Number(r.oldest_queued_min));
  return {
    queued:  Number(r.queued)  || 0,
    running: Number(r.running) || 0,
    failed:  Number(r.failed)  || 0,
    done:    Number(r.done)    || 0,
    oldestQueuedMin: oldest,
    stalled: oldest != null && oldest >= STALLED_AFTER_MIN && !(Number(r.running) > 0),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const [cameras, pipeline] = await Promise.all([
    session.muxAuth
      ? listLiveStreams(session.muxAuth).catch(e => { console.error('[system-health] live', e.message); return null; })
      : Promise.resolve([]),
    session.venueSlug
      ? getPipelineHealth(session.venueSlug).catch(e => { console.error('[system-health] pipeline', e.message); return null; })
      : Promise.resolve(null),
  ]);

  return res.status(200).json({ cameras, pipeline, timestamp: Date.now() });
}
