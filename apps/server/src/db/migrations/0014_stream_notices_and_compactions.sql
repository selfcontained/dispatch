-- Session notices (advisories such as a model fallback) and context
-- compactions are rows of the engine's stream of their own. A compaction is
-- updated in place under its id as it runs, like a tool call.
ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn', 'plan',
                  'notice', 'compaction'));
