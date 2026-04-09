-- Dispatch Jobs foundation.

-- Up Migration

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  agent_type TEXT NOT NULL DEFAULT 'codex',
  use_worktree BOOLEAN NOT NULL DEFAULT false,
  branch_name TEXT,
  full_access BOOLEAN NOT NULL DEFAULT false,
  additional_instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (directory, name)
);

CREATE INDEX IF NOT EXISTS idx_jobs_directory ON jobs(directory);
CREATE INDEX IF NOT EXISTS idx_jobs_name ON jobs(name);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  report JSONB,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_question TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_job_runs_agent_id ON job_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status);
CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON job_runs(started_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_runs_one_active_per_job
  ON job_runs(job_id)
  WHERE status IN ('started', 'running', 'needs_input');

-- Down Migration

DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS jobs;
