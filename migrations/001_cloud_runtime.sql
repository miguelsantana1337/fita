CREATE TABLE IF NOT EXISTS fita_batches (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  format text NOT NULL CHECK (format IN ('mp3', 'm4a', 'opus')),
  quality text NOT NULL CHECK (quality IN ('128', '192', '256', '320')),
  concurrency smallint NOT NULL CHECK (concurrency BETWEEN 1 AND 4),
  source_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  archive_path text,
  archive_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fita_batches_user_created_idx
  ON fita_batches (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fita_jobs (
  id uuid PRIMARY KEY,
  batch_id uuid REFERENCES fita_batches(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  url text NOT NULL,
  format text NOT NULL CHECK (format IN ('mp3', 'm4a', 'opus')),
  quality text NOT NULL CHECK (quality IN ('128', '192', '256', '320')),
  title text NOT NULL DEFAULT 'Faixa do YouTube',
  state text NOT NULL DEFAULT 'queued' CHECK (
    state IN ('queued', 'starting', 'downloading', 'ready', 'error', 'cancelled')
  ),
  progress real NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  speed text,
  eta text,
  error text,
  filename text,
  blob_path text,
  blob_url text,
  sandbox_name text,
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fita_jobs_user_created_idx
  ON fita_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS fita_jobs_batch_idx
  ON fita_jobs (batch_id, created_at);

CREATE INDEX IF NOT EXISTS fita_jobs_active_idx
  ON fita_jobs (user_id, state)
  WHERE state IN ('starting', 'downloading');
