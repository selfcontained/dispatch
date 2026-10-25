CREATE TABLE task_watches (
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  notified_through timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, agent_id)
);
CREATE INDEX task_watches_agent_idx ON task_watches(agent_id);
