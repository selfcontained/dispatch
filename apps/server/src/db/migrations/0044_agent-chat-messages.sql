-- Chat surface: durable record of the Chat tab conversation between the user
-- and one agent. Agent replies arrive via the dispatch_chat_post MCP tool;
-- user messages are persisted here before being injected into the pane.
-- See docs/chat-surface-plan.md.

CREATE TABLE IF NOT EXISTS agent_chat_messages (
  id uuid PRIMARY KEY,
  -- No FK constraint, matching agent_events: rows survive agent deletion so
  -- history views stay readable.
  agent_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'user')),
  kind text NOT NULL DEFAULT 'reply'
    CHECK (kind IN ('reply', 'update', 'question', 'summary')),
  text text NOT NULL,
  reply_to uuid,
  question jsonb,
  answer jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- User messages only: whether pane injection succeeded.
  delivered boolean,
  -- Agent messages only: when the user saw it.
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_chat_messages_agent_created_idx
  ON agent_chat_messages (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_chat_messages_agent_unread_idx
  ON agent_chat_messages (agent_id)
  WHERE author_kind = 'agent' AND read_at IS NULL;
