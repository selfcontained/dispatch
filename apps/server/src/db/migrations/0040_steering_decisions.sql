CREATE TABLE steering_decision_daily (
  day date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0
);
CREATE TABLE steering_decision_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL,
  message_id uuid NOT NULL,
  turn_seq bigint NOT NULL,
  status text NOT NULL,
  prompt_version text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}',
  UNIQUE(agent_id, message_id, turn_seq)
);
CREATE INDEX steering_decision_records_created ON steering_decision_records(created_at DESC);
