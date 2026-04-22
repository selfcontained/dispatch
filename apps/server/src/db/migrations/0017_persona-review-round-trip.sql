-- Phase 2 of the review round-trip feature (CRU-131).
-- Adds round tracking and the allow_recheck opt-in so a single reviewer
-- session can span an initial review and a follow-up recheck pass.
-- No status transitions are introduced here — this migration is pure
-- schema readiness for the backend ticket that lights up the loop.

-- Up Migration

ALTER TABLE persona_reviews
  ADD COLUMN IF NOT EXISTS round_number INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS allow_recheck BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE agent_feedback
  ADD COLUMN IF NOT EXISTS round_number INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS responds_to_feedback_id INT
    REFERENCES agent_feedback(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_feedback_responds_to
  ON agent_feedback(responds_to_feedback_id);

-- Down Migration

DROP INDEX IF EXISTS idx_agent_feedback_responds_to;

ALTER TABLE agent_feedback
  DROP COLUMN IF EXISTS responds_to_feedback_id,
  DROP COLUMN IF EXISTS round_number;

ALTER TABLE persona_reviews
  DROP COLUMN IF EXISTS allow_recheck,
  DROP COLUMN IF EXISTS round_number;
