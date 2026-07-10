CREATE TABLE IF NOT EXISTS whiteboards (
  agent_id   TEXT PRIMARY KEY,
  scene      JSONB NOT NULL DEFAULT '{"elements":[]}',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT 'user',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
