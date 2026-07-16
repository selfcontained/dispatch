-- A review agent owns one unified review record for its full review lifecycle.
-- Keep this separate from 0029 so existing installations receive the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique_agent_reviewer
  ON reviews(reviewer_agent_id)
  WHERE reviewer_type = 'agent' AND reviewer_agent_id IS NOT NULL;
