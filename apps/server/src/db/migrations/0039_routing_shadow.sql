-- The marker survives diagnostic retention and reconnects. Never alters placement.
ALTER TABLE agent_stream_events ADD COLUMN routing_shadow_observed boolean NOT NULL DEFAULT false;
CREATE TABLE routing_shadow_daily (
  day date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0
);
CREATE TABLE routing_shadow_records (
  turn_id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL,
  message_ids jsonb NOT NULL,
  placement jsonb NOT NULL,
  explicit_thread boolean NOT NULL,
  status text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX routing_shadow_records_created ON routing_shadow_records(created_at DESC, turn_id DESC);

CREATE SEQUENCE routing_shadow_synthetic_ids;
