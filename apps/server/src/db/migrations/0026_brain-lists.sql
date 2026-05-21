-- Brain lists: ordered mutable collections with push/remove/set semantics

CREATE TABLE IF NOT EXISTS brain_lists (
  repo_root text NOT NULL,
  collection text NOT NULL,
  name text NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_agent_id text NOT NULL,
  updated_by_agent_id text NOT NULL,
  PRIMARY KEY (repo_root, collection, name)
);

CREATE INDEX IF NOT EXISTS brain_lists_repo_collection_updated_idx
  ON brain_lists (repo_root, collection, updated_at DESC);

CREATE TABLE IF NOT EXISTS brain_list_items (
  repo_root text NOT NULL,
  collection text NOT NULL,
  name text NOT NULL,
  item_index integer NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_root, collection, name, item_index),
  FOREIGN KEY (repo_root, collection, name)
    REFERENCES brain_lists (repo_root, collection, name)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS brain_list_items_repo_collection_name_idx
  ON brain_list_items (repo_root, collection, name, item_index);
