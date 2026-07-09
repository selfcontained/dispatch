CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  reviewer_type TEXT NOT NULL,
  reviewer_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  base_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_agent ON reviews(agent_id);
CREATE INDEX IF NOT EXISTS idx_reviews_assigned ON reviews(assigned_agent_id);

CREATE TABLE IF NOT EXISTS review_feedback_items (
  id SERIAL PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  diff_snapshot TEXT,
  base_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_feedback_items_review ON review_feedback_items(review_id);

CREATE TABLE IF NOT EXISTS review_thread_messages (
  id SERIAL PRIMARY KEY,
  feedback_item_id INTEGER NOT NULL REFERENCES review_feedback_items(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'text',
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_thread_messages_item ON review_thread_messages(feedback_item_id);
