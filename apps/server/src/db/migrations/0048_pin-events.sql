-- Pin activity log: one row each time an agent creates, updates, or deletes
-- a sidebar pin. `agents.pins` stays the current state (what the sidebar
-- shows); this table is the history the Chat feed reads so a pin appears in
-- the stream at the moment it changed. Entries render the pin live by id, so
-- only the label is snapshotted — enough to name a pin that has since been
-- deleted.

CREATE TABLE IF NOT EXISTS pin_events (
  id serial PRIMARY KEY,
  -- No FK constraint, matching agent_events: rows survive agent deletion so
  -- history views stay readable.
  agent_id text NOT NULL,
  pin_id text NOT NULL,
  label text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pin_events_agent_created_idx
  ON pin_events (agent_id, created_at DESC);
