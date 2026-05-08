ALTER TABLE jobs ADD COLUMN callable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN singleton BOOLEAN NOT NULL DEFAULT true;

-- The blanket one-active-per-job unique index is now enforced in application
-- code so non-singleton jobs can have concurrent runs.
DROP INDEX IF EXISTS idx_job_runs_one_active_per_job;
