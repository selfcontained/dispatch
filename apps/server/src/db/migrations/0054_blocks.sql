-- Streams and blocks (docs/design/blocks.md). One stream per root agent; a
-- block is one post in it by an agent or a person, optionally addressed to
-- an agent (delivered as a prompt) and optionally replying under another
-- block (a thread). Replaces the Chat tab's message table. Hard cutover:
-- the old tables are dropped, rows are not migrated.

DROP TABLE IF EXISTS agent_chat_reactions;
DROP TABLE IF EXISTS agent_chat_messages;

CREATE TABLE IF NOT EXISTS blocks (
  id uuid PRIMARY KEY,
  -- The root agent whose stream this is. No FK, matching agent_events: rows
  -- survive agent deletion so history stays readable.
  stream_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'user')),
  author_agent_id text,
  -- The agent that receives this block as a prompt; NULL = for people.
  to_agent_id text,
  kind text NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'question', 'form', 'file', 'link', 'review', 'tasks')),
  -- The top-level block this replies under, and the block replied to.
  thread_id uuid,
  reply_to uuid,
  text text NOT NULL DEFAULT '',
  data jsonb,
  state jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  origin text CHECK (origin IS NULL OR origin IN ('launch')),
  launched_by_agent_id text,
  -- Blocks with to_agent_id: whether the prompt reached the agent; NULL while
  -- pending.
  delivered boolean,
  -- Agent blocks for people: when the user saw it.
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (author_kind <> 'agent' OR author_agent_id IS NOT NULL),
  CHECK (thread_id IS NULL OR reply_to IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS blocks_stream_created_idx
  ON blocks (stream_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS blocks_thread_created_idx
  ON blocks (thread_id, created_at, id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS blocks_stream_unread_idx
  ON blocks (stream_id)
  WHERE author_kind = 'agent' AND to_agent_id IS NULL AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS blocks_pending_delivery_idx
  ON blocks (stream_id, to_agent_id)
  WHERE to_agent_id IS NOT NULL AND delivered IS NULL;

-- Open input blocks addressed to people: what "Waiting" means.
CREATE INDEX IF NOT EXISTS blocks_open_input_idx
  ON blocks (stream_id, author_agent_id)
  WHERE kind IN ('question', 'form')
    AND to_agent_id IS NULL
    AND thread_id IS NULL
    AND (state IS NULL OR (state->'answer' IS NULL AND state->'submission' IS NULL));

CREATE INDEX IF NOT EXISTS blocks_attachments_gin
  ON blocks USING gin (attachments jsonb_path_ops);

-- One row per (block, author, emoji): each party reacts once per emoji.
CREATE TABLE IF NOT EXISTS block_reactions (
  id uuid PRIMARY KEY,
  block_id uuid NOT NULL REFERENCES blocks (id) ON DELETE CASCADE,
  stream_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'user')),
  author_agent_id text,
  emoji text NOT NULL,
  -- User reactions on an agent's block: delivery outcome; NULL while pending.
  delivered boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (block_id, author_kind, author_agent_id, emoji)
);

CREATE INDEX IF NOT EXISTS block_reactions_pending_idx
  ON block_reactions (stream_id)
  WHERE author_kind = 'user' AND delivered IS NULL;
