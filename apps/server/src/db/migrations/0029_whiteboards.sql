CREATE TABLE IF NOT EXISTS whiteboards (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  scene JSONB NOT NULL DEFAULT '{"elements": []}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT 'user',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
