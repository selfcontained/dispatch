ALTER TABLE task_columns ADD COLUMN capacity integer CHECK (capacity > 0);
CREATE INDEX tasks_active_column_idx ON tasks (column_id) WHERE archived_at IS NULL;
