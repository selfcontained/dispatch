-- Agent-to-agent messages: durable record of dispatch_send_message deliveries.
-- Delivery itself stays ephemeral (tmux injection); this table is for viewing.

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY,
  sender_agent_id text NOT NULL,
  recipient_agent_id text NOT NULL,
  sender_name text NOT NULL,
  recipient_name text NOT NULL,
  content text NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  -- Stored even though sender/recipient repo roots are equal today (same-repo
  -- send rule). Present so cross-repo messaging becomes a config flip, not a
  -- migration.
  sender_repo_root text,
  recipient_repo_root text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_sender_created_idx
  ON agent_messages (sender_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_messages_recipient_created_idx
  ON agent_messages (recipient_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_messages_recipient_unread_idx
  ON agent_messages (recipient_agent_id) WHERE read_at IS NULL;
