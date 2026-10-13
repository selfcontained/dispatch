CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  repo_root text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT '#9575ed',
  icon_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agents_project_idx ON agents(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS templates_project_idx ON templates(project_id) WHERE project_id IS NOT NULL;
