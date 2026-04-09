-- Remove the file_path column from jobs. Job definitions are now created
-- and managed entirely through the UI — no filesystem scanning.

-- Drop the unique constraint first, then the column.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_directory_file_path_key;
DROP INDEX IF EXISTS jobs_directory_file_path_key;
ALTER TABLE jobs DROP COLUMN IF EXISTS file_path;
