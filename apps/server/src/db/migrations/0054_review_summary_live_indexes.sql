-- The sidebar review summary starts from live agents: each live reviewer's
-- latest review, and archived reviewers' reviews addressed to a live agent.
-- These keep it from scanning every review and archived agent ever kept.
CREATE INDEX blocks_review_target_idx
  ON blocks (to_agent_id, author_agent_id, created_at DESC, id DESC)
  WHERE kind = 'review' AND author_kind = 'agent' AND to_agent_id IS NOT NULL;

CREATE INDEX agents_live_idx ON agents (id) WHERE deleted_at IS NULL;
