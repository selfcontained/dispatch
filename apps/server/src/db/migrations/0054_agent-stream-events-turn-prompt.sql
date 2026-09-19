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
