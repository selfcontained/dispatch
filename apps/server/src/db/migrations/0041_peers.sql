-- Linked Dispatch instances: pairing, per-direction credentials, and the
-- pair-time launch policy. Generalized from the browser-extension pairing
-- shape (0035); differences: the code renders on the accepting side,
-- credentials are issued in BOTH directions, and the caller's tailnet
-- StableID is pinned alongside the token.

CREATE TABLE IF NOT EXISTS peers (
  id text PRIMARY KEY,                       -- the peer's instance_id (inst_*)
  name text NOT NULL,                        -- display name shown in pickers
  url text NOT NULL,                         -- base URL we dial (MagicDNS or public)
  tailnet_stable_id text,                    -- the peer node's durable tailscale ID
  outbound_token text NOT NULL,              -- bearer WE present to THEM
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

-- Bearer tokens THEY present to US, plus the standing pair-time policy.
CREATE TABLE IF NOT EXISTS peer_credentials (
  id uuid PRIMARY KEY,
  peer_id text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  tailnet_stable_id text,                    -- pinned caller identity; NULL only for non-tailnet pairings
  allow_launch boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS peer_credentials_active_idx
  ON peer_credentials (token_hash)
  WHERE revoked_at IS NULL;

-- Short-lived pairing offers displayed on THIS (accepting) instance.
CREATE TABLE IF NOT EXISTS peer_pairings (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL,
  allow_launch boolean NOT NULL DEFAULT true,
  require_tailnet boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  peer_id text REFERENCES peers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS peer_pairings_expires_idx
  ON peer_pairings (expires_at);

-- Shadow rows: an agent launched on a peer gets a LOCAL agents row (a local
-- id, no tmux session) so every existing consumer — sidebar, list_agents,
-- message targeting, SSE — keeps working unchanged. Only the ORIGINATING
-- instance holds the shadow; on the executing instance it is a plain agent.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS peer_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS remote_id text;

-- Deliberately no index on (peer_id, remote_id): building one at startup
-- migration write-locks a potentially large agents table, and shadow lookups
-- filter a table that stays small in practice.

-- Messages are CONTENT: losing one loses work, and a blind retry would
-- double-inject. Hence a durable sender-side outbox with backoff, and a
-- receiver-side receipt per idempotency key. Status/events are STATE and get
-- neither — the next event supersedes a dropped one.
CREATE TABLE IF NOT EXISTS peer_outbox (
  id uuid PRIMARY KEY,
  peer_id text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  path text NOT NULL,
  body jsonb NOT NULL,
  idempotency_key uuid NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS peer_outbox_due_idx
  ON peer_outbox (next_attempt_at)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS peer_message_receipts (
  peer_id text NOT NULL,
  idempotency_key uuid NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (peer_id, idempotency_key)
);
