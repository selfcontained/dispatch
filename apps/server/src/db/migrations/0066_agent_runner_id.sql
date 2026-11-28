DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM runner_registrations WHERE id = 'local') THEN
    RAISE EXCEPTION 'Runner registration "local" conflicts with the controller runner ID';
  END IF;
END;
$$;

-- The default allows older controllers to insert local agents after rollback.
ALTER TABLE agents ADD COLUMN runner_id text NOT NULL DEFAULT 'local';
