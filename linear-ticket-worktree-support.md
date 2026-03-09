# Implement Git Worktree Support for Agent Sessions

## Summary

When creating a new agent session, optionally create a git worktree and launch the agent inside it. This isolates the agent's changes from the main checkout and gives it a dedicated branch to work on.

## Background

Currently, all agents launch in the main repo checkout regardless of worktree mode configuration. The `worktreeMode` setting exists in `.dispatch/config.json` but is never acted upon at agent launch time. Git context detection (branch, worktree path) attempts to probe the tmux pane's cwd, which never changes since agents run commands in subshells — making detection unreliable.

## Changes

### 1. Simplify `WorktreeMode`

Remove `auto` — just `"ask" | "off"`. Auto-generation has no good naming source yet and can be added later (e.g. via a Linear integration).

**Files:** `src/repo-config.ts`, `src/server.ts`, `web/src/components/app/create-agent-dialog.tsx`, `web/src/components/app/edit-worktree-mode-dialog.tsx`, `web/src/App.tsx`, `web/src/components/app/types.ts`

### 2. DB migration — add worktree fields to `agents`

```sql
ALTER TABLE agents ADD COLUMN worktree_path TEXT;
ALTER TABLE agents ADD COLUMN worktree_branch TEXT;
```

**File:** `src/db/migrate.ts`

### 3. Update agent creation API

`POST /api/v1/agents` accepts optional `branchName`. If provided:
- Run `git worktree add <path> <branchName>` before launching tmux
- Worktree path convention: sibling of repo root, branch slashes replaced with dashes (e.g. `feat/add-auth` → `<reporoot>/../dispatch-<reponame>-feat-add-auth`)
- Use worktree path as the tmux session `cwd`
- Store `worktree_path` and `worktree_branch` on the agent record

**Files:** `src/server.ts`, `src/agents/manager.ts`

### 4. Fix git context detection

If agent has a stored `worktree_path`, use it directly instead of probing the tmux pane. Git context is accurate from launch with no refresh needed for path/branch.

**File:** `src/server.ts`

### 5. Worktree cleanup on agent deletion

When an agent with a `worktree_path` is stopped/deleted, run `git worktree remove <path>`.

**File:** `src/agents/manager.ts`

### 6. UI — branch name input in create dialog

When worktree mode is `ask`, show a "Branch name" text field in the create agent dialog. Leaving it blank runs the agent in the main checkout. Pass `branchName` in the create payload.

**File:** `web/src/components/app/create-agent-dialog.tsx`

## Acceptance Criteria

- [ ] `WorktreeMode` only has `ask` and `off` values
- [ ] Creating an agent with a branch name creates a git worktree and launches the agent inside it
- [ ] Agent's git context (branch, worktree path/name, `isWorktree`) is correct immediately on launch — no refresh needed
- [ ] Deleting an agent cleans up its worktree
- [ ] Creating an agent without a branch name (or with mode `off`) behaves exactly as before
- [ ] UI shows branch name input when worktree mode is `ask`
