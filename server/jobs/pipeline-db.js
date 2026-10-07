import { Pool } from 'pg';

export function createPipelinePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured for the pipeline worker');

  const databaseUrl = new URL(process.env.DATABASE_URL);
  const sslMode = databaseUrl.searchParams.get('sslmode');
  const ssl = process.env.DATABASE_SSL === 'disable' || sslMode === 'disable'
    ? false
    : sslMode
      ? undefined
      : { rejectUnauthorized: false };

  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function claimNextJob(db, workerId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH candidate AS (
         SELECT id
         FROM pipeline_jobs
         WHERE status = 'queued'
            OR (status IN ('waiting', 'processing') AND (lease_until IS NULL OR lease_until < now()))
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE pipeline_jobs AS job
       SET status = 'waiting',
           done = 0,
           uploaded = 0,
           failed = 0,
           error = NULL,
           attempts = attempts + 1,
           locked_by = $1,
           lease_until = now() + interval '2 minutes',
           updated_at = now()
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.id, job.upload_id, job.artist_name, job.venue_slug`,
      [workerId]
    );
    await client.query('COMMIT');
    const row = result.rows[0];
    return row && {
      jobId: row.id,
      uploadId: row.upload_id,
      artistName: row.artist_name,
      venueSlug: row.venue_slug,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function updatePipelineJob(db, jobId, workerId, progress) {
  const terminal = progress.status === 'done' || progress.status === 'error';
  const result = await db.query(
    `UPDATE pipeline_jobs
     SET done = $3,
         total = $4,
         status = $5,
         uploaded = $6,
         failed = $7,
         error = $8,
         updated_at = now(),
         locked_by = CASE WHEN $9 THEN NULL ELSE locked_by END,
         lease_until = CASE WHEN $9 THEN NULL ELSE now() + interval '2 minutes' END
     WHERE id = $1 AND locked_by = $2
     RETURNING id`,
    [
      jobId,
      workerId,
      progress.done,
      progress.total,
      progress.status,
      progress.uploaded ?? 0,
      progress.failed ?? 0,
      progress.error ?? null,
      terminal,
    ]
  );
  if (!result.rowCount) throw new Error(`Lost lease for pipeline job ${jobId}`);
}

export async function renewPipelineJob(db, jobId, workerId) {
  const result = await db.query(
    `UPDATE pipeline_jobs
     SET lease_until = now() + interval '2 minutes'
     WHERE id = $1 AND locked_by = $2 AND status IN ('waiting', 'processing')`,
    [jobId, workerId]
  );
  if (!result.rowCount) throw new Error(`Lost lease for pipeline job ${jobId}`);
}