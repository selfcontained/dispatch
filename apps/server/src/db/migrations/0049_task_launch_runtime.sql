-- Per-task runtime/model override for column trigger launches. Null inherits
-- the launch template and column automation; a model requires a runtime.
ALTER TABLE tasks ADD COLUMN launch_agent_type text;
ALTER TABLE tasks ADD COLUMN launch_model text;
