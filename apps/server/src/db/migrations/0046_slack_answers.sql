-- Slack parent messages Dispatch posted, keyed by exact channel + ts. Routing
-- uses the stored agent/stream/thread/block ids, never display names.
CREATE TABLE slack_messages (
  id uuid PRIMARY KEY,
  binding_generation text NOT NULL,
  channel_id text NOT NULL,
  message_ts text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('question', 'form', 'notify', 'link')),
  agent_id text,
  stream_id text,
  thread_id uuid,
  block_id uuid REFERENCES blocks(id) ON DELETE CASCADE,
  -- SHA-256 of the ask's text+data when posted: a changed ask is stale.
  data_hash text,
  settled_at timestamptz,
  -- Delivery state last shown in Slack; 'sending' is re-rendered once
  -- the reply's delivery settles.
  shown_delivery text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_ts)
);
CREATE INDEX slack_messages_open ON slack_messages(block_id)
  WHERE settled_at IS NULL AND block_id IS NOT NULL;

-- Slack identities allowed to answer, per installation generation. A row
-- starts pending (someone clicked a one-time link button) and only the
-- owner's Allow in Dispatch makes it effective.
CREATE TABLE slack_answerers (
  id uuid PRIMARY KEY,
  binding_generation text NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'allowed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  allowed_at timestamptz,
  UNIQUE (binding_generation, team_id, user_id)
);

-- One-time link claims; only the SHA-256 of the nonce is stored.
CREATE TABLE slack_link_claims (
  nonce_hash text PRIMARY KEY,
  binding_generation text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency for inbound Slack events/notices (Socket Mode redelivers).
CREATE TABLE slack_inbound (
  key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
