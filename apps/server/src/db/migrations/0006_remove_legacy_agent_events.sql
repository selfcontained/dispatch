DROP TABLE IF EXISTS agent_events;

ALTER TABLE agents
  DROP COLUMN IF EXISTS latest_event_type,
  DROP COLUMN IF EXISTS latest_event_message,
  DROP COLUMN IF EXISTS latest_event_metadata,
  DROP COLUMN IF EXISTS latest_event_updated_at;
