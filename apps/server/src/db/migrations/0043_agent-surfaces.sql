CREATE TABLE IF NOT EXISTS agent_surfaces (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  icon TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'frozen')),
  sort_order INTEGER NOT NULL,
  blocks JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_surfaces_agent_order_idx
  ON agent_surfaces (agent_id, sort_order, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_surface_interactions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  surface_id TEXT NOT NULL REFERENCES agent_surfaces(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  surface_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('action', 'form_submit')),
  intent TEXT NOT NULL,
  once_form_block_id TEXT,
  payload JSONB NOT NULL,
  definition_snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'notified', 'claimed', 'completed', 'rejected', 'cancelled', 'orphaned')),
  outcome_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  UNIQUE (surface_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS agent_surface_interactions_owner_status_idx
  ON agent_surface_interactions (agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS agent_surface_interactions_surface_idx
  ON agent_surface_interactions (surface_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_surface_interactions_once_form_idx
  ON agent_surface_interactions (surface_id, once_form_block_id)
  WHERE once_form_block_id IS NOT NULL
    AND status IN ('queued', 'notified', 'claimed', 'completed');
