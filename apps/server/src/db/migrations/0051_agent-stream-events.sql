-- Stream events from harnesses Dispatch drives over a protocol (dsh over
-- ACP). One row per assistant message, thought, or tool call; tool calls are
-- rewritten in place as their status changes (key = toolCallId). seq orders
-- rows within one agent and never changes after insert.
CREATE TABLE IF NOT EXISTS agent_stream_events (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status')),
  key         TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_stream_events_agent_key
  ON agent_stream_events (agent_id, kind, key)
  WHERE key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_stream_events_agent_created
  ON agent_stream_events (agent_id, created_at DESC, id DESC);
