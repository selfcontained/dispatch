-- Linked Dispatch instances: pairing, per-direction credentials, and the
-- pair-time launch policy. Generalized from the browser-extension pairing
-- shape (0035); differences: the code renders on the accepting side,
-- credentials are issued in BOTH directions, and the caller's tailnet
-- StableID is pinned alongside the token.

CREATE TABLE IF NOT EXISTS peers (
  id text PRIMARY KEY,                       -- the peer's instance_id (inst_*)
  -- Two names, because they answer different questions. `reported_name` is what
  -- the peer calls itself (its own instance_name, or hostname); `name` is what
  -- THIS instance calls it, seeded from reported_name and editable here. The
  -- local label is the one agents type as `location`, so "Cloud" can mean
  -- different machines on different laptops without renaming anything remote.
  name text NOT NULL,
  reported_name text,
  url text NOT NULL,                         -- base URL we dial (MagicDNS or public)
  tailnet_stable_id text,                    -- the peer node's durable tailscale ID
  outbound_token text NOT NULL,              -- bearer WE present to THEM
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

-- One peer per local label, so `location: "Cloud"` is never ambiguous. Partial
-- so a revoked peer's label is free for reuse.
CREATE UNIQUE INDEX IF NOT EXISTS peers_active_name_idx
  ON peers (lower(name))
  WHERE revoked_at IS NULL;

-- Bearer tokens THEY present to US, plus the standing pair-time policy.
--
-- Capabilities are a SET, not a flag. Pairing grants separable things — run
-- code here, inject prompts into agents here, do either with the sandbox off,
-- and see what agents here are doing — and a single boolean cannot describe
-- them. Each route gates on its own column, so a launch-only CI box or a
-- message-only observer is a policy row rather than a protocol version.
CREATE TABLE IF NOT EXISTS peer_credentials (
  id uuid PRIMARY KEY,
  peer_id text NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  tailnet_stable_id text,                    -- pinned caller identity; NULL only for non-tailnet pairings
  allow_launch boolean NOT NULL DEFAULT true,
  allow_message boolean NOT NULL DEFAULT true,
  -- Off by default even when launching is allowed: fullAccess disables the
  -- sandbox, and "may launch here" should not silently mean "may launch
  -- unsandboxed here". Opt in per pairing.
  allow_full_access boolean NOT NULL DEFAULT false,
  -- Gates the LATEST-EVENT payload on the peer event feed, not the feed itself.
  -- Id/name/type/status always cross — without them a shadow row could never
  -- track its remote agent at all. What this grant adds is the event text an
  -- agent writes about itself ("Refactoring auth middleware"), which says far
  -- more about what this machine is doing than a status enum does. On by
  -- default: a shadow whose progress never moves is the thing it exists to fix.
  allow_events boolean NOT NULL DEFAULT true,
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
  allow_message boolean NOT NULL DEFAULT true,
  allow_full_access boolean NOT NULL DEFAULT false,
  allow_events boolean NOT NULL DEFAULT true,
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
  delivered_at timestamptz,
  -- Retry is not forever. A peer that is merely gone — a machine nobody
  -- explicitly unlinked — would otherwise accumulate rows that are re-attempted
  -- until the end of time, and each attempt costs a 30s connect timeout. Past
  -- the cap the row is dead-lettered: kept for inspection, never sent again.
  dead_lettered_at timestamptz
);

CREATE INDEX IF NOT EXISTS peer_outbox_due_idx
  ON peer_outbox (peer_id, next_attempt_at)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;

CREATE TABLE IF NOT EXISTS peer_message_receipts (
  peer_id text NOT NULL,
  idempotency_key uuid NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (peer_id, idempotency_key)
);
