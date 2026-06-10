CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  label TEXT CHECK (label IS NULL OR (length(label) <= 200 AND length(label) > 0)),
  text TEXT NOT NULL CHECK (length(text) <= 1000 AND length(text) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
