-- Up Migration

CREATE TABLE IF NOT EXISTS provider_quota_snapshots (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  account_label TEXT,
  account_id TEXT,
  source TEXT NOT NULL,
  window_id TEXT NOT NULL,
  title TEXT NOT NULL,
  used_percent NUMERIC,
  window_minutes INTEGER,
  resets_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_quota_snapshots_unique_window
  ON provider_quota_snapshots (
    provider,
    (COALESCE(account_id, '')),
    (COALESCE(account_label, '')),
    window_id,
    source
  );

CREATE INDEX IF NOT EXISTS idx_provider_quota_snapshots_provider
  ON provider_quota_snapshots(provider);

CREATE INDEX IF NOT EXISTS idx_provider_quota_snapshots_fetched_at
  ON provider_quota_snapshots(fetched_at);

-- Down Migration

DROP TABLE IF EXISTS provider_quota_snapshots;
