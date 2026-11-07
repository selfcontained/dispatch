-- A bounded materialized view per agent, separate from transcript turns.
-- The host journal remains the replay source; no command output or paths stored.
CREATE TABLE agent_background_work (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL
);
