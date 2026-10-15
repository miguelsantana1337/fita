ALTER TABLE fita_jobs
  ADD COLUMN IF NOT EXISTS worker_id text;

ALTER TABLE fita_jobs
  ADD COLUMN IF NOT EXISTS lease_id uuid;

ALTER TABLE fita_jobs
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE fita_jobs
  ADD COLUMN IF NOT EXISTS upload_path text;

ALTER TABLE fita_jobs
  ADD COLUMN IF NOT EXISTS file_size bigint;

CREATE INDEX IF NOT EXISTS fita_jobs_worker_queue_idx
  ON fita_jobs (state, created_at)
  WHERE state IN ('queued', 'starting', 'downloading');

CREATE TABLE IF NOT EXISTS fita_batch_sources (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES fita_batches(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  url text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'resolving', 'resolved', 'error', 'cancelled')
  ),
  error text,
  worker_id text,
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fita_batch_sources_queue_idx
  ON fita_batch_sources (state, created_at)
  WHERE state IN ('queued', 'resolving');

CREATE INDEX IF NOT EXISTS fita_batch_sources_batch_idx
  ON fita_batch_sources (batch_id, created_at);

CREATE TABLE IF NOT EXISTS fita_workers (
  id text PRIMARY KEY,
  label text NOT NULL DEFAULT 'Mac FITA',
  version text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fita_workers_last_seen_idx
  ON fita_workers (last_seen DESC);
