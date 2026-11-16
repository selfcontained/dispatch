-- Source attention history shares stream retention without rendering as status.
-- Existing rows and all previously accepted kinds remain valid.
ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn', 'plan',
                 'notice', 'compaction', 'attention'));
