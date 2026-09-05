-- A `turn` row per harness turn: written when a prompt is sent and settled
-- in place when the harness finishes. The Harness view cuts the stream into
-- turns on these rows instead of guessing from prompt text.
ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events
  ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn'));
