# Agent Lifecycle Model

## States

`AgentStatus` (in `apps/server/src/agents/types.ts`):

- `creating` — row inserted, setup script running, tmux session not yet ready
- `running` — tmux session is up; agent CLI may still be initializing
- `stopping` — soft-stop in progress
- `stopped` — tmux session is gone, agent row preserved (resumable via `start`)
- `archiving` — async cleanup during deletion (worktree check, cleanup, finalization)
- `error` — unrecoverable failure during launch / start / stop / archive
- `unknown` — reserved/transitional. The `AgentStatus` type permits it but no code path currently sets it; the assisted-update queries treat it as a possible "in-flight" status defensively.

## Roles

`AgentRole` (column added in migration `0018_agents-role.sql`):

- `standard` — every agent created via the normal Create dialog or a job launch.
- `review` — persona review agents launched via `dispatch_launch_persona` (see [Review Agent Lifecycle](#review-agent-lifecycle)).
- `assisted_update` — created exclusively by `POST /api/v1/release/assisted/launch`. Runs the assisted-update prompt and is wired to the assisted-update phase machine (see [Assisted-Update Phase Axis](#assisted-update-phase-axis)).

Role is orthogonal to `AgentType` (`claude` / `codex` / `opencode` / `cursor` / `terminal`).

## Setup Phases

`SetupPhase` is a sub-state of `creating`/`running`, surfaced to the UI while the in-tmux setup script runs:

- `worktree` — creating the git worktree
- `env` — copying local config files / sourcing `~/.dispatch/env`
- `deps` — installing dependencies (lockfile-driven)
- `session` — starting the agent CLI inside tmux
- `null` — setup is complete (or never used; agents that don't create a worktree start here)

The setup script reports phase via `POST /api/v1/agents/:id/setup/phase`. On completion it calls `POST /api/v1/agents/:id/setup/complete`. On unrecoverable failure (e.g. `git worktree add` fails) it calls `POST /api/v1/agents/:id/setup/error`, which routes to `markSetupFailed` and transitions the agent to `stopped` with `last_error` set and a `blocked` latest_event so the UI can surface the reason.

## Archive Phases

`ArchivePhase` (sub-state while `status = archiving`):

- `stopping` → `worktree-check` → `worktree-cleanup` → `finalizing` → `null` (soft-deleted)

Worktree cleanup mode is one of `auto` | `keep` | `force`, passed as the `cleanupWorktree` query param on `DELETE /api/v1/agents/:id`. `auto` preserves a worktree that has unmerged commits or uncommitted changes; `keep` always preserves; `force` always deletes.

Whenever the worktree is removed, `cleanupGitWorktree` also runs `git branch -D` on the branch — but only when Dispatch created it (`worktree_branch` is set and differs from `base_branch`). A worktree checked out on an existing branch loses only its directory. Cleanup failures are logged and swallowed; the worktree is left on disk and archival still completes.

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

5. **Reconciliation (on startup, then every 30s)**

For each agent with status in (`running`, `stopping`, `creating`, `archiving`):

- **session present, status `running`**: leave as-is.
- **session missing, status `creating`**: → `error` with a launch-failure message and the tail of the setup log.
- **session missing, status `running`** with non-zero exit code: → `error`.
- **session missing, status `running`** with exit 0 (or no exit recorded): → `stopped`.
- **status `stopping`** for >60s: → `running` (revert; user can retry stop). Surfaces an "agent reverted" latest_event.
- **status `archiving`** for >30s: archive is resumed.

Missing-session transitions also write a system-tagged latest_event (`metadata.source: "system"`): `blocked` with the setup-log tail on launch failure, `idle` ("Session ended normally.") on a clean exit.

Cleanup of orphaned tmux sessions (sessions with the `<prefix>_agt_` prefix whose matching agent row is in a terminal state — `stopped` or `error`) runs only in the startup pass (`reconcileAgents()`), not on the periodic tick — the tick calls the status-only `reconcileAgentStatuses()`. Cleanup is a no-op when the runtime doesn't track sessions (inert mode). Sessions with no matching DB record are left alone — they may belong to another server instance sharing the tmux namespace.

## Activity Monitor

`apps/server/src/agents/activity-monitor.ts` runs at the end of each reconcile tick (wired in `server/agent-lifecycle-runtime.ts`) but is a separate concern: the reconciler handles session lifecycle, the activity monitor handles status accuracy — it compares each running agent's self-reported status against observed tmux pane activity.

Each pass it captures the last 100 pane lines of every `running` agent with a tmux session and digests them. Comparing digests across passes yields "pane changed" / "pane silent", which drives two corrections:

- **Pane active + latest event is anything but `working`** → rewrite to `working` with the message "Activity detected".
- **Pane silent for ≥3 minutes + latest event is `working`** → rewrite to `idle` with the message "No recent activity detected". The window is deliberately conservative — agent CLIs can think for a while without visible output.

Corrections are conditional writes: `upsertLatestEventIfCurrent` only applies if the agent's latest event still has the `updated_at` the monitor read, so a concurrent agent-reported event always wins over the monitor's stale snapshot. Corrected events carry `metadata.source: "activity-monitor"`; these are the sidebar events users see as "Activity detected" / "No recent activity detected". Per-agent digest state is held in memory and pruned when an agent leaves `running`.

## tmux Session Contract

- Session name: `<prefix>_<agentId>_<sanitizedName>` where `prefix` defaults to `dispatch` (configurable via `DISPATCH_SESSION_PREFIX`), `agentId` already starts with `agt_`, and `sanitizedName` is the lowercased agent name with non-alphanumeric chars collapsed to hyphens, edge hyphens trimmed, truncated to 30 chars (omitted entirely if sanitization strips everything).
- Agent process starts in the agent's `cwd` (or worktree path once setup completes).
- Closing a browser terminal must only detach the WebSocket bridge, not terminate tmux.

`agentManager.getTerminalAccess(id)` returns either `{ mode: "tmux", sessionName }` or `{ mode: "inert", message }`. The `inert` mode is used in test/CI environments where the runtime is configured not to spawn tmux. The web terminal endpoint uses the tmux mode result to bridge a browser WebSocket to `tmux attach`.

## Launch Contract

```bash
tmux new-session -d -s <sessionName> -c "<cwd>" \
  "bash -c 'exec 2> >(tee <setupLogPath> >&2); bash <setupScriptPath>; echo \"EXIT:$?\" > <exitFilePath>'"
```

The wrapper tees stderr to `/tmp/dispatch_setup_<agentId>.log` and captures the exit code to `/tmp/dispatch_<sessionName>.exit` — these are what the reconciler reads via `readSetupLogTail` / `readExitInfo` when a session disappears. After `new-session`, the launcher sets `status off`, `mouse on`, `allow-passthrough on`, and the `sync` terminal feature on the session, then verifies the session survived launch (a fast-fail launch throws with the setup-log tail).

The generated setup script (`/tmp/dispatch_setup_<agentId>.sh`) does, in order:

1. `unset DATABASE_URL`, then source `~/.dispatch/env` (if it exists) so user overrides win.
2. Create the git worktree (if requested). The script doesn't post this phase — `worktree` is the initial `setup_phase` written when the agent row is inserted.
3. POST `setup/phase: env`, then copy the source repo's gitignored local config files (see below) into the worktree.
4. POST `setup/phase: deps`, then install dependencies based on detected lockfile (pnpm/yarn/npm/bun). Skipped for `terminal` agent type.
5. POST `setup/phase: session`, then `exec` into the agent CLI command.

Worktree creation is the only unrecoverable step: on failure the script POSTs `setup/error` with the git output, removes the partial worktree (and the branch it was creating), and exits rather than falling back to the primary checkout. A missing lockfile, a failed dependency install, or a missing local config file are all non-fatal. If the working directory turns out not to be a git repo, the worktree is skipped and the script proceeds straight to the session phase.

## Local Config Files

`git worktree add` only materializes _tracked_ files, so a developer's
gitignored secrets and local overrides never reach a new worktree. Both launch
paths copy a shared list of conventionally-gitignored filenames from the source
repo into the worktree — `apps/server/src/agents/worktree-local-config.ts` owns
the list (`WORKTREE_LOCAL_CONFIG_PATTERNS`) and the inert-mode copy; the
tmux-mode bash in `apps/server/src/agents/tmux/setup-script.ts` is generated
from the same constant so the two cannot drift.

Covered today: `.env`, `.env.local`, `.env.*.local`, `.dev.vars` (Wrangler),
`.envrc` (direnv), `.npmrc`, `local.settings.json` (Azure Functions),
`terraform.tfvars[.json]`, `*.auto.tfvars[.json]`, `config/master.key` and
`config/credentials/*.key` (Rails), `.streamlit/secrets.toml`, and
`.claude/settings.local.json`.

Rules the list follows:

- Only names that are conventionally _gitignored_. Committed templates like
  `.env.example` are already in the worktree via the checkout.
- `*` is allowed in the final path segment only and never crosses a `/`. Globs
  stay narrow — `.env*` would sweep up committed templates, and `*.tfvars`
  would sweep up committed per-environment values.
- An existing destination is never overwritten. A fresh worktree contains
  exactly the tracked files, so a destination that already exists means the
  repo commits that name, and the checked-out revision's copy is the correct
  one — not the source checkout's possibly-dirty, possibly-different-branch
  version.
- A nested destination directory that resolves outside the worktree (via a
  tracked symlink) is skipped rather than written through.
- Everything is best-effort: a missing source file is a no-op and an individual
  copy failure is logged, not thrown.

Copying happens before the dependency install, so a gitignored `.npmrc` with a
private-registry token is in place by the time `pnpm install` runs.

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

The assisted-update agent (role `assisted_update`) drives a separate state machine stored in `~/.dispatch/assisted-update.json` and managed by `apps/server/src/assisted-update-store.ts`. Phase order is:

`inspect → prepare → apply → restarting → validate → done`

Terminal phases: `done`, `rollback`, `blocked`, `failed`. The forward-only guard rejects backward transitions except into a terminal phase, which is reachable from any earlier phase.

On server startup, `rehydrateActiveAssistedJob` reads the on-disk state and resumes tracking the active job if the persisted phase is non-terminal — this lets the in-app Updates pane keep showing progress across a Dispatch restart that the assisted update itself triggered.

## Review Agent Lifecycle

Review agents are ordinary child agents with role `review`. Launching one does not create a review record. The review agent completes its initial pass by calling `dispatch_review_submit`; a review with no feedback items records a clean approval, while a review with items remains open until the parent resolves or dismisses each item.

Questions and follow-up discussion use each feedback item's tracked thread. Review status is derived from the item states rather than a separate reviewer state machine.
