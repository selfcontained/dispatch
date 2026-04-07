-- Decouple job name from filename. The unique identity for file-based
-- jobs is (directory, file_path), not (directory, name). Name becomes
-- a user-friendly display label from frontmatter.

-- Drop the old (directory, name) unique constraint by looking up its actual
-- name from pg_constraint, since the auto-generated name may differ on
-- restored or altered databases.
DO $$
DECLARE
  old_constraint TEXT;
BEGIN
  SELECT conname INTO old_constraint
  FROM pg_constraint
  WHERE conrelid = 'jobs'::regclass
    AND contype = 'u'
    AND conkey @> ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'jobs'::regclass AND attname = 'directory'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'jobs'::regclass AND attname = 'name')
    ]
  LIMIT 1;

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE jobs DROP CONSTRAINT %I', old_constraint);
  END IF;
END $$;

ALTER TABLE jobs ADD CONSTRAINT jobs_directory_file_path_key UNIQUE (directory, file_path);
