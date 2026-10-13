CREATE TABLE projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  repo_root text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT '#9575ed',
  icon_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agents ADD COLUMN project_id text REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN project_id text REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX agents_project_idx ON agents(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX templates_project_idx ON templates(project_id) WHERE project_id IS NOT NULL;
