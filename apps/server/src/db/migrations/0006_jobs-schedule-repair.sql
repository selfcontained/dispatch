-- Repair databases where an early revision of 0004_jobs-schedule was recorded
-- before all job configuration columns had been added.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS timeout_ms INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS needs_input_timeout_ms INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notify JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS prompt TEXT;
