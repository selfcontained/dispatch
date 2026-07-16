-- Make browser feedback submission retries safe after ambiguous client failures.

ALTER TABLE browser_feedback_submissions
  ADD COLUMN IF NOT EXISTS client_submission_id uuid;

-- Existing rows predate client-provided ids. Their server ids are already UUIDs
-- and provide a stable, unique backfill before the column becomes required.
UPDATE browser_feedback_submissions
   SET client_submission_id = id
 WHERE client_submission_id IS NULL;

ALTER TABLE browser_feedback_submissions
  ALTER COLUMN client_submission_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'browser_feedback_submissions_token_client_id_unique'
       AND conrelid = 'browser_feedback_submissions'::regclass
  ) THEN
    ALTER TABLE browser_feedback_submissions
      ADD CONSTRAINT browser_feedback_submissions_token_client_id_unique
      UNIQUE (token_id, client_submission_id);
  END IF;
END
$$;
