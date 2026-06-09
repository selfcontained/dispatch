ALTER TABLE quick_phrases
  ADD COLUMN IF NOT EXISTS label TEXT
    CHECK (label IS NULL OR (length(label) <= 200 AND length(label) > 0));
