-- Templates: reusable agent launch configurations
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT,
  agent_type TEXT NOT NULL DEFAULT 'claude',
  use_worktree BOOLEAN NOT NULL DEFAULT false,
  base_branch TEXT,
  branch_name TEXT,
  full_access BOOLEAN NOT NULL DEFAULT false,
  callable BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (directory, name)
);

CREATE INDEX IF NOT EXISTS idx_templates_directory ON templates(directory);
CREATE INDEX IF NOT EXISTS idx_templates_callable ON templates(callable) WHERE callable = true;

-- Link jobs to backing templates
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS default_args JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Migrate every existing job into a backing template.
-- On-demand (no schedule) callable jobs -> callable template.
-- Scheduled jobs -> hidden backing template (callable = false).
DO $$
DECLARE
  rec RECORD;
  tmpl_id TEXT;
BEGIN
  FOR rec IN SELECT * FROM jobs WHERE template_id IS NULL LOOP
    tmpl_id := 'tmpl_' || REPLACE(rec.id::text, '-', '');

    INSERT INTO templates (id, directory, name, prompt, agent_type, use_worktree, base_branch, branch_name, full_access, callable, created_at, updated_at)
    VALUES (
      tmpl_id,
      rec.directory,
      rec.name,
      rec.prompt,
      rec.agent_type,
      rec.use_worktree,
      rec.base_branch,
      rec.branch_name,
      rec.full_access,
      CASE WHEN rec.schedule IS NULL THEN rec.callable ELSE false END,
      rec.created_at,
      rec.updated_at
    )
    ON CONFLICT (directory, name) DO NOTHING;

    UPDATE jobs SET template_id = tmpl_id WHERE id = rec.id AND template_id IS NULL;
  END LOOP;
END $$;
