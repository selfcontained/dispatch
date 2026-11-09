-- Dormant foundation: no runtime caller or writer activation is registered.
CREATE TABLE context_transfers (
  transfer_id uuid PRIMARY KEY,
  predecessor_id text NOT NULL,
  boundary bigint NOT NULL CHECK (boundary >= 0),
  chain_id text NOT NULL UNIQUE,
  workspace_key text NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND request @> '{"version":1}'::jsonb),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN
    ('prepared', 'launch_reserved', 'receipt_recorded', 'pickup_verified', 'cancelled', 'failed')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  launch_key text NOT NULL UNIQUE,
  successor_agent_id text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (predecessor_id, boundary),
  CHECK (state NOT IN ('receipt_recorded', 'pickup_verified') OR successor_agent_id IS NOT NULL)
);
-- This prevents competing intents; it is NOT a native/MCP filesystem lease.
CREATE UNIQUE INDEX context_transfers_open_workspace ON context_transfers (workspace_key)
  WHERE state NOT IN ('cancelled', 'failed');
