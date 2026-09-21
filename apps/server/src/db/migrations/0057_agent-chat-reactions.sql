-- Emoji reactions on Chat messages, in both directions: the user reacts to
-- the agent's posts, and the agent reacts to the user's (dispatch_chat_react).
-- A user reaction is injected into the agent's pane — like a user message,
-- in its own envelope naming the reacted message — and shown as a chip under
-- the post. An agent reaction is only shown. Removing a reaction only removes
-- the chip.
--
-- One row per (message, author, emoji): each side of the conversation is a
-- single party, so a second click on the same emoji is a toggle, not a count.
CREATE TABLE IF NOT EXISTS agent_chat_reactions (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL
    REFERENCES agent_chat_messages (id) ON DELETE CASCADE,
  -- Denormalized from the message so recovery and per-agent reads need no join.
  agent_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'user')),
  emoji text NOT NULL,
  -- User reactions only: whether pane injection succeeded; NULL while
  -- pending, as for user messages. Always NULL on agent reactions.
  delivered boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, author_kind, emoji)
);

-- Startup recovery sweeps user reactions whose delivery died with the process.
CREATE INDEX IF NOT EXISTS agent_chat_reactions_pending_idx
  ON agent_chat_reactions (agent_id)
  WHERE author_kind = 'user' AND delivered IS NULL;
