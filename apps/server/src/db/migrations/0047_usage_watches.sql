-- An agent's subscription to a provider's remaining usage crossing a
-- threshold. `armed` is the episode flag: false once a matched reading was
-- reported, true again after the reading moves back past the threshold.
-- notified_at identifies the episode; delivered_at is set once the agent's
-- runtime accepted it, so a claim lost to shutdown or a crash is rearmed at boot.
CREATE TABLE usage_watches (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine text NOT NULL,
  comparison text NOT NULL CHECK (comparison IN ('at_or_below', 'at_or_above')),
  threshold numeric NOT NULL CHECK (threshold >= 0 AND threshold <= 100),
  armed boolean NOT NULL DEFAULT true,
  last_observed_at timestamptz,
  last_headroom numeric,
  notified_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agent_id, engine, comparison, threshold)
);
CREATE INDEX usage_watches_engine_idx ON usage_watches(engine);
