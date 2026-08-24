-- Durable configuration and handoff state for continuation jobs.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS continuation_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_iterations INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS completion_criteria TEXT[];
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recovery_instructions TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_max_iterations_positive'
  ) THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_max_iterations_positive
      CHECK (max_iterations IS NULL OR max_iterations > 0);
  END IF;
END $$;

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS continuation JSONB;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS chain_id TEXT;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS chain_iteration INTEGER;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS continuation_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS continuation_retries INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_job_runs_continuation_pending
  ON job_runs(job_id) WHERE continuation_pending = TRUE;
