-- Decouple job name from filename. The unique identity for file-based
-- jobs is (directory, file_path), not (directory, name). Name becomes
-- a user-friendly display label from frontmatter.

-- Drop old unique constraint and add new one
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_directory_name_key;
ALTER TABLE jobs ADD CONSTRAINT jobs_directory_file_path_key UNIQUE (directory, file_path);
