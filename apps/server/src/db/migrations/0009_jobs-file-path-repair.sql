-- Repair databases where the jobs table was created before migration 0003
-- added the file_path column (CREATE TABLE IF NOT EXISTS was a no-op).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS file_path TEXT;
