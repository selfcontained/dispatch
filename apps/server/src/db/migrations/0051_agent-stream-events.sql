-- The Dispatch Harness stream: one row per assistant text, thought, tool
-- call, status line, turn, or plan, folded from Agent Client Protocol
-- session updates. Every statement is guarded so the file re-runs as a
-- no-op on an install whose table predates it; the constraint is replaced
-- rather than created because an older table may carry it without 'plan'.
CREATE TABLE IF NOT EXISTS agent_stream_events (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  key         TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_stream_events_agent_key
  ON agent_stream_events (agent_id, kind, key)
  WHERE key IS NOT NULL;

-- The Chat feed reads an agent's newest rows by time (chat/feed.ts).
CREATE INDEX IF NOT EXISTS agent_stream_events_agent_created
  ON agent_stream_events (agent_id, created_at DESC, id DESC);

ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events
  ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn', 'plan'));
