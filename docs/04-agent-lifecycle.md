# Agent Lifecycle Model

## States

`AgentStatus` (in `apps/server/src/agents/manager.ts`):

- `creating` — row inserted, setup script running, tmux session not yet ready
- `running` — tmux session is up; agent CLI may still be initializing
- `stopping` — soft-stop in progress
- `stopped` — tmux session is gone, agent row preserved (resumable via `start`)
- `archiving` — async cleanup during deletion (worktree check, cleanup, finalization)
- `error` — unrecoverable failure during launch / start / stop / archive
- `unknown` — reserved/transitional. The `AgentStatus` type permits it but no code path currently sets it; the assisted-update queries treat it as a possible "in-flight" status defensively.

## Roles

`AgentRole` (column added in migration `0018_agents-role.sql`):

- `standard` — every agent created via the normal Create dialog or job/persona launch.
- `assisted_update` — created exclusively by `POST /api/v1/release/assisted/launch`. Runs the assisted-update prompt and is wired to the assisted-update phase machine (see [Assisted-Update Phase Axis](#assisted-update-phase-axis)).

Role is orthogonal to `AgentType` (`claude` / `codex` / `opencode` / `terminal`).

## Setup Phases

`SetupPhase` is a sub-state of `creating`/`running`, surfaced to the UI while the in-tmux setup script runs:

- `worktree` — creating the git worktree
- `env` — copying `.env` / sourcing `~/.dispatch/env`
- `deps` — installing dependencies (lockfile-driven)
- `session` — starting the agent CLI inside tmux
- `null` — setup is complete (or never used; agents that don't create a worktree start here)

The setup script reports phase via `POST /api/v1/agents/:id/setup/phase`. On completion it calls `POST /api/v1/agents/:id/setup/complete`. On unrecoverable failure (e.g. `git worktree add` fails) it calls `POST /api/v1/agents/:id/setup/error`, which routes to `markSetupFailed` and transitions the agent to `stopped` with `last_error` set and a `blocked` latest_event so the UI can surface the reason.

## Archive Phases

`ArchivePhase` (sub-state while `status = archiving`):

- `stopping` → `worktree-check` → `worktree-cleanup` → `finalizing` → `null` (soft-deleted)

Worktree cleanup mode is one of `auto` | `keep` | `force`, passed as the `cleanupWorktree` query param on `DELETE /api/v1/agents/:id`. `auto` preserves a worktree that has unmerged commits or uncommitted changes; `keep` always preserves; `force` always deletes.

## State Transitions

1. **Create**

- `creating → running` once the tmux session is up
- `creating → error` on launch failure (e.g. tmux session exited immediately)
- `creating → stopped` if the in-tmux setup script POSTs to `setup/error` (e.g. worktree creation failed) — surfaces a `blocked` latest_event with the reason

2. **Start** (resume after stop)

- `stopped → creating → running` via the same setup path
- If a tmux session for the agent already exists, returns the agent at `running` directly
- `running → error` if the underlying session command fails

3. **Stop**

- `running → stopping → stopped`
- `running → error` if the stop command fails and the process state is inconsistent
- `stop` on a `stopped` agent is a no-op (returns the current record with HTTP 200)

4. **Delete (archive)**

- `running | stopped → archiving → (soft-deleted)` via archive phases (`stopping` → `worktree-check` → `worktree-cleanup` → `finalizing`)
- Returns HTTP `202 { status: "archiving" }` immediately; cleanup runs in the background. Phase changes are broadcast on the agent SSE stream.
- Concurrent delete on an already-archiving agent returns `409`.
- `archiving → error` if cleanup throws.

5. **Reconciliation (on startup or scheduled tick)**

For each agent with status in (`running`, `stopping`, `creating`, `archiving`):

- **session present, status `running`**: leave as-is.
- **session missing, status `creating`**: → `error` with a launch-failure message and the tail of the setup log.
- **session missing, status `running`** with non-zero exit code: → `error`.
- **session missing, status `running`** with exit 0 (or no exit recorded): → `stopped`.
- **status `stopping`** for >60s: → `running` (revert; user can retry stop). Surfaces an "agent reverted" latest_event.
- **status `archiving`** for >30s: archive is resumed.

Cleanup of orphaned tmux sessions (sessions with the `<prefix>_agt_` prefix that no longer have a matching agent row) runs alongside reconciliation when `agentRuntime === "tmux"`.

## tmux Session Contract

- Session name: `<prefix>_<agentId>_<sanitizedName>` where `prefix` defaults to `dispatch` (configurable via `DISPATCH_SESSION_PREFIX`), `agentId` already starts with `agt_`, and `sanitizedName` is the lowercased agent name with non-alphanumeric chars collapsed to hyphens and truncated to 30 chars.
- Window name: `main`
- Agent process starts in the agent's `cwd` (or worktree path once setup completes).
- Closing a browser terminal must only detach the WebSocket bridge, not terminate tmux.

`agentManager.getTerminalAccess(id)` returns either `{ mode: "tmux", sessionName }` or `{ mode: "inert", message }`. The `inert` mode is used in test/CI environments where the runtime is configured not to spawn tmux. The web terminal endpoint uses the tmux mode result to bridge a browser WebSocket to `tmux attach`.

## Launch Contract

```bash
tmux new-session -d -s <sessionName> -c "<cwd>" "bash <setupScriptPath>"
```

The generated setup script (`/tmp/dispatch_setup_<agentId>.sh`) does, in order:

1. Source `~/.dispatch/env` (if it exists).
2. POST `setup/phase: worktree`, then create the git worktree (if requested).
3. POST `setup/phase: env`, then copy `.env` if present.
4. POST `setup/phase: deps`, then install dependencies based on detected lockfile (npm/pnpm/yarn/bun/uv/poetry).
5. POST `setup/phase: session`, then `exec` into the agent CLI command.

If any step fails non-recoverably, the script POSTs `setup/error` with a message before exiting.

## Agent Environment

Agent sessions run inside tmux, which is non-login and non-interactive. Tools like `nvm`, `pyenv`, `conda`, `GH_TOKEN`, etc. won't be available unless explicitly configured.

Dispatch sources `~/.dispatch/env` (if it exists) at the start of every setup script. Use this file to export any environment variables or run setup commands that agents need:

```bash
# ~/.dispatch/env
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export GH_TOKEN="ghp_..."
```

Standard shell profiles (`~/.bashrc`, `~/.zshrc`, etc.) are **not** sourced — they are not safe to run under `set -e` and frequently contain commands (e.g. `conda init`) that cause the setup script to exit.

**Important:** Do not use `exit` in `~/.dispatch/env` — it runs in the setup script's shell, so `exit` will kill the agent session.

## Stop Contract

Soft stop (default):

```bash
tmux send-keys -t <sessionName> C-c
# wait 1200ms
tmux kill-session -t <sessionName>   # only if the session is still present
```

Force stop (`force: true` on `POST /agents/:id/stop`) skips the `Ctrl+C` step and goes straight to `kill-session`.

The repo's `stop` lifecycle hook (configured under `.dispatch/tools.json`) runs best-effort before the tmux teardown.

## Idempotency Rules

- `start` on a `running` agent is a no-op (returns the agent at `running` with HTTP 200). The handler attaches to the existing tmux session if one is found instead of spawning a new one.
- `stop` on a `stopped` agent is a no-op (returns the current record with HTTP 200).
- `delete` on an already-archiving agent returns `409`. Worktree retention is controlled by `?cleanupWorktree=auto|keep|force` rather than a `force` flag on the delete itself.

## Phase Axes — Don't Confuse Them

There are three independent state axes attached to an agent. Code that talks about "phase" should always name the axis:

| Axis                  | Values                                                                                                   | Set by                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `setup_phase`         | `worktree` / `env` / `deps` / `session` / `null`                                                         | in-tmux setup script                                         |
| `archive_phase`       | `stopping` / `worktree-check` / `worktree-cleanup` / `finalizing` / `null`                               | `executeArchive` in agent manager                            |
| Assisted-update phase | `inspect` / `prepare` / `apply` / `restarting` / `validate` / `done` / `rollback` / `blocked` / `failed` | the assisted-update agent via `POST /release/assisted/phase` |

## Assisted-Update Phase Axis

The assisted-update agent (role `assisted_update`) drives a separate state machine stored in `~/.dispatch/release/assisted-update.json` and managed by `apps/server/src/assisted-update-store.ts`. Phase order is:

`inspect → prepare → apply → restarting → validate → done`

Terminal phases: `done`, `rollback`, `blocked`, `failed`. The forward-only guard rejects backward transitions except into a terminal phase, which is reachable from any earlier phase.

On server startup, `rehydrateActiveAssistedJob` reads the on-disk state and resumes tracking the active job if the persisted phase is non-terminal — this lets the in-app Updates pane keep showing progress across a Dispatch restart that the assisted update itself triggered.

## Persona Review State Machine

Persona-review agents (created via `POST /agents/:id/launch-review` or `POST /agents/:id/persona-reviews`) carry a `review` sub-state independent of `AgentStatus`:

- `reviewing` → `complete` (single-round review)
- `reviewing` → `awaiting_recheck` → `reviewing` → `complete` (round-trip review with `dispatch_submit_resolution` from the parent and `dispatch_get_recheck_context` from the reviewer)
- `cancelled` is a terminal state reachable from any non-terminal review state.

State columns and the round-trip flow were added in migration `0017_persona-review-round-trip.sql`.
