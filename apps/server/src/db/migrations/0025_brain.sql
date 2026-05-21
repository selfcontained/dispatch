-- Brain: repo-scoped shared memory for agents (objects + events)

CREATE TABLE IF NOT EXISTS brain_objects (
  repo_root text NOT NULL,
  collection text NOT NULL,
  name text NOT NULL,
  value jsonb NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_agent_id text NOT NULL,
  updated_by_agent_id text NOT NULL,
  PRIMARY KEY (repo_root, collection, name)
);

CREATE INDEX IF NOT EXISTS brain_objects_repo_collection_updated_idx
  ON brain_objects (repo_root, collection, updated_at DESC);

CREATE TABLE IF NOT EXISTS brain_events (
  id uuid PRIMARY KEY,
  repo_root text NOT NULL,
  collection text NOT NULL,
  kind text NOT NULL,
  subject text,
  tags text[] NOT NULL DEFAULT '{}',
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  agent_id text NOT NULL
);

CREATE INDEX IF NOT EXISTS brain_events_repo_collection_created_idx
  ON brain_events (repo_root, collection, created_at DESC);

CREATE INDEX IF NOT EXISTS brain_events_repo_collection_kind_created_idx
  ON brain_events (repo_root, collection, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS brain_events_repo_collection_subject_created_idx
  ON brain_events (repo_root, collection, subject, created_at DESC);

CREATE INDEX IF NOT EXISTS brain_events_tags_gin_idx
  ON brain_events USING GIN (tags);
