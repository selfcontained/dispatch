-- Up Migration

CREATE TABLE IF NOT EXISTS provider_quota_observations (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  account_label TEXT,
  account_id TEXT,
  source TEXT NOT NULL,
  window_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  used_percent NUMERIC,
  resets_at TIMESTAMPTZ,
  window_seconds INTEGER,
  status TEXT NOT NULL,
  trigger TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_observed_at
  ON provider_quota_observations(observed_at);

CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_provider_window
  ON provider_quota_observations(provider, window_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_resets_at
  ON provider_quota_observations(resets_at);

-- Down Migration

DROP TABLE IF EXISTS provider_quota_observations;
