-- Per-task runtime/model override for column trigger launches. Null inherits
-- the launch template and column automation. The override is an explicit
-- pair: both set or both null, so no launch falls back to a default model.
ALTER TABLE tasks ADD COLUMN launch_agent_type text;
ALTER TABLE tasks ADD COLUMN launch_model text;
ALTER TABLE tasks ADD CONSTRAINT tasks_launch_runtime_pair
  CHECK ((launch_agent_type IS NULL) = (launch_model IS NULL));
