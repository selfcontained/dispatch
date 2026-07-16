-- Scoped Chrome extension authentication and browser feedback delivery.

CREATE TABLE IF NOT EXISTS browser_extension_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  device_name text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['agents:read', 'submissions:write']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS browser_extension_tokens_active_idx
  ON browser_extension_tokens (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS browser_extension_pairings (
  id uuid PRIMARY KEY,
  pairing_secret_hash text NOT NULL,
  code_hash text NOT NULL,
  device_name text NOT NULL,
  dispatch_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  exchanged_at timestamptz,
  token_ciphertext text,
  token_iv text,
  token_auth_tag text,
  token_id uuid REFERENCES browser_extension_tokens(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS browser_extension_pairings_expires_idx
  ON browser_extension_pairings (expires_at);

CREATE TABLE IF NOT EXISTS browser_feedback_submissions (
  id uuid PRIMARY KEY,
  token_id uuid REFERENCES browser_extension_tokens(id) ON DELETE SET NULL,
  agent_id text NOT NULL,
  comment text NOT NULL,
  page_context jsonb NOT NULL,
  element_context jsonb NOT NULL,
  delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS browser_feedback_submissions_agent_created_idx
  ON browser_feedback_submissions (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS browser_feedback_submissions_created_idx
  ON browser_feedback_submissions (created_at);
