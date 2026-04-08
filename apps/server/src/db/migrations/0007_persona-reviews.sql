CREATE TABLE IF NOT EXISTS persona_reviews (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reviewing',
  message TEXT,
  verdict TEXT,
  summary TEXT,
  files_reviewed JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_persona_reviews_agent_id ON persona_reviews(agent_id);
CREATE INDEX IF NOT EXISTS idx_persona_reviews_parent_agent_id ON persona_reviews(parent_agent_id);
