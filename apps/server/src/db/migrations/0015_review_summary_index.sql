-- Latest submitted review per author, without scanning unrelated stream blocks.
CREATE INDEX blocks_review_author_idx
  ON blocks (author_agent_id, created_at DESC, id DESC)
  WHERE kind = 'review' AND author_kind = 'agent';
