-- Preserve the directory requested at launch after cwd moves into a managed worktree.
ALTER TABLE agents ADD COLUMN launch_cwd text;
UPDATE agents
SET launch_cwd = CASE
  WHEN worktree_path IS NOT NULL AND cwd = worktree_path
    THEN COALESCE(git_context->>'repoRoot', cwd)
  ELSE cwd
END;

-- One icon lookup per directory, shared by agents and retained across restarts.
CREATE TABLE directory_icons (
  cwd text PRIMARY KEY,
  icon_path text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
