ALTER TABLE agents
  ADD COLUMN runner_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN runner_repository jsonb,
  ADD COLUMN runner_cleanup_pending boolean NOT NULL DEFAULT false;

CREATE INDEX agents_runner_cleanup_pending
  ON agents (id) WHERE runner_cleanup_pending AND deleted_at IS NOT NULL;
