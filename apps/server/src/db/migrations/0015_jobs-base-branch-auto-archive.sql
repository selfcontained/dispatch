-- Jobs: add base_branch (fork-from branch for worktree jobs) and auto_archive
-- (opt-out for the auto-archive-on-terminal-run behavior).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_branch TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_archive BOOLEAN NOT NULL DEFAULT TRUE;
