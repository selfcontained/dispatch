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

DO $$
DECLARE
  directory_attnum SMALLINT;
  file_path_attnum SMALLINT;
  existing_unique BOOLEAN;
BEGIN
  SELECT attnum INTO directory_attnum
  FROM pg_attribute
  WHERE attrelid = 'jobs'::regclass
    AND attname = 'directory';

  SELECT attnum INTO file_path_attnum
  FROM pg_attribute
  WHERE attrelid = 'jobs'::regclass
    AND attname = 'file_path';

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'jobs'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[directory_attnum, file_path_attnum]
    UNION ALL
    SELECT 1
    FROM pg_index
    WHERE indrelid = 'jobs'::regclass
      AND indisunique
      AND indisvalid
      AND indpred IS NULL
      AND indkey::text = directory_attnum::TEXT || ' ' || file_path_attnum::TEXT
  ) INTO existing_unique;

  IF NOT existing_unique THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_directory_file_path_key UNIQUE (directory, file_path);
  END IF;
END $$;
