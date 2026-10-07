CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id text PRIMARY KEY,
  upload_id text NOT NULL,
  artist_name text NOT NULL,
  venue_slug text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'waiting', 'processing', 'done', 'error')),
  done integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 30,
  uploaded integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  locked_by text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_jobs_queue_idx
  ON pipeline_jobs (created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS pipeline_jobs_lease_idx
  ON pipeline_jobs (lease_until)
  WHERE status IN ('waiting', 'processing');

CREATE INDEX IF NOT EXISTS pipeline_jobs_venue_updated_idx
  ON pipeline_jobs (venue_slug, updated_at DESC);