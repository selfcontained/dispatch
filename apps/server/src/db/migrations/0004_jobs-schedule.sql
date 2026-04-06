-- Add schedule column to jobs table so scheduling doesn't require
-- re-reading the .md file every time. Also enables UI override in Phase 3.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS schedule TEXT;
