ALTER TABLE agents ADD COLUMN host_launch_id text;

CREATE TABLE pending_agent_stops (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  runner_id text,
  launch_id text,
  force boolean NOT NULL
);
