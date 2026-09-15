CREATE TABLE IF NOT EXISTS agent_background_processes (
  id uuid PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_background_processes_agent_created
  ON agent_background_processes (agent_id, created_at DESC);
