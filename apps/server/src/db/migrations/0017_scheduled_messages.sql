CREATE TABLE scheduled_messages (
  id UUID PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX scheduled_messages_agent_idx ON scheduled_messages(agent_id, created_at);
CREATE INDEX scheduled_messages_current_idx ON scheduled_messages ((payload->>'status'))
  WHERE payload->>'status' IN ('active', 'paused', 'uncertain');
