ALTER TABLE tasks ADD COLUMN archived_at timestamptz NULL;
CREATE INDEX tasks_active_project_idx ON tasks (project_id) WHERE archived_at IS NULL;
