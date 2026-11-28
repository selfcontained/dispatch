-- Persist the trusted launcher's binding for a resumed remote reviewer.
ALTER TABLE agents ADD COLUMN runner_worktree_owner text;
