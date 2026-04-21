-- Phase 1 of the review round-trip feature (CRU-128).
-- Captures resolution metadata on feedback items and introduces a
-- parent "resolution" record per review. No round-trip loop yet —
-- round_number defaults to 1 so Phase 2 (CRU-131) can layer on
-- additional rounds without a table migration.

ALTER TABLE agent_feedback
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS resolution_commit TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE persona_reviews
  ADD COLUMN IF NOT EXISTS last_reviewed_commit TEXT;

CREATE TABLE IF NOT EXISTS persona_review_resolutions (
  id SERIAL PRIMARY KEY,
  review_id INT NOT NULL REFERENCES persona_reviews(id) ON DELETE CASCADE,
  round_number INT NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  resolution_commit TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_persona_review_resolutions_review_id
  ON persona_review_resolutions(review_id);
