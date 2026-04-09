-- Drop the file_path column and its unique constraint from the jobs table.
-- Jobs are now fully DB-backed; file_path is no longer used.

-- Drop the old UNIQUE(directory, file_path) constraint if it exists.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'jobs'::regclass
    AND contype = 'u'
    AND conkey @> ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'jobs'::regclass AND attname = 'directory'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'jobs'::regclass AND attname = 'file_path')
    ]
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE jobs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

-- Drop standalone unique indexes on (directory, file_path) if any exist.
DO $$
DECLARE
  idx_name TEXT;
BEGIN
  FOR idx_name IN
    SELECT i.indexname
    FROM pg_indexes i
    JOIN pg_index pi ON pi.indexrelid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass
    WHERE i.tablename = 'jobs'
      AND pi.indisunique
      AND pi.indkey::text = (
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'jobs'::regclass AND attname = 'directory')::TEXT
        || ' ' ||
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'jobs'::regclass AND attname = 'file_path')::TEXT
      )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx_name);
  END LOOP;
END $$;

-- Drop the columns.
ALTER TABLE jobs DROP COLUMN IF EXISTS file_path;
ALTER TABLE jobs DROP COLUMN IF EXISTS additional_instructions;
