ALTER TABLE tasks ADD COLUMN launch_templates jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(launch_templates) = 'object');

-- Preferences outlive templates deliberately: a deleted template must fail
-- visibly rather than silently inherit. Deleted stages have no next entry.
CREATE FUNCTION remove_task_column_launch_templates() RETURNS trigger AS $$
BEGIN
  UPDATE tasks SET launch_templates = launch_templates - OLD.id
    WHERE project_id = OLD.project_id AND launch_templates ? OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER task_column_launch_templates_cleanup AFTER DELETE ON task_columns
  FOR EACH ROW EXECUTE FUNCTION remove_task_column_launch_templates();
