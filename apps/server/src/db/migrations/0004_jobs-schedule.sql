-- Store the full job configuration on the jobs table so jobs can run
-- without re-reading the .md file. Also enables UI-only job creation
-- and server-side overrides in Phase 3.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS schedule TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS timeout_ms INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS needs_input_timeout_ms INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notify JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS prompt TEXT;
