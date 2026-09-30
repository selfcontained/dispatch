-- Where an agent is working now, when it moved after launch (a worktree it
-- created, another repo). Kept apart from cwd, which the engine resumes in,
-- and worktree_path, which archive may delete.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workspace_path text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workspace_base_branch text;
