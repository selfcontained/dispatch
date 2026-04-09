-- Add unique constraint on (directory, name) so job identity is enforced at the
-- DB level now that file_path is no longer used as the identity key.
-- Uses CREATE UNIQUE INDEX IF NOT EXISTS for idempotency.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_directory_name_key ON jobs (directory, name);
