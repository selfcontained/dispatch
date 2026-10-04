-- 0001_baseline first shipped block_reactions with UNIQUE NULLS NOT DISTINCT,
-- which PostgreSQL 14 rejects. The baseline now builds the COALESCE unique
-- index instead; databases that ran the old baseline swap the constraint for
-- that index here. A no-op on databases that ran the new baseline.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'block_reactions'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE block_reactions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS block_reactions_unique_idx
  ON block_reactions (block_id, author_kind, COALESCE(author_agent_id, ''), emoji);
