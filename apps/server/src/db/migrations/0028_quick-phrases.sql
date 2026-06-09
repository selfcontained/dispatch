CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (length(text) <= 1000 AND length(text) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
