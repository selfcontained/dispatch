-- The ACP runtime stream: one row per assistant text, thought, tool
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
-- The chat feed's anti-join asks, for every row of every page, whether some
-- turn row claims that chat message as its prompt. Nothing indexed that
-- question: `agent_stream_events` carries (agent_id, seq), (agent_id, kind,
-- key) WHERE key IS NOT NULL (turn rows have a null key, so it never
-- applies) and (agent_id, created_at DESC, id DESC). Postgres answered it
-- with a sequential scan that was not even restricted to the agent, so one
-- agent's feed page slowed down as a *different* agent accumulated rows.
-- Measured on a synthetic 60k-row agent: 64.6ms and 8576 buffers without
-- this index, 2.5ms and 413 with it.
--
-- Partial and expression-based so it indexes only what the anti-join reads.
-- The expression must stay in step with TURN_PROMPT_CHAT_ID_PATH in
-- apps/server/src/chat/turns.ts, which is where the same path is spelled for
-- the query itself.
CREATE INDEX IF NOT EXISTS agent_stream_events_turn_prompt
  ON agent_stream_events (agent_id, ((payload->'prompt'->>'chatMessageId')))
  WHERE kind = 'turn';
