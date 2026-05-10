-- Fixup: 0020_jobs-callable may have been partially applied to production
-- before the singleton column and index drop were added to the file.
-- This migration is idempotent — safe to run whether 0020 was fully or
-- partially applied.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS singleton BOOLEAN NOT NULL DEFAULT true;
DROP INDEX IF EXISTS idx_job_runs_one_active_per_job;
