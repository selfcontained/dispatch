# Agent Lifecycle Model

Every agent is an Agent Client Protocol (ACP) session owned by a
`dispatch-agent-host` process. The design and the host protocol are in
[design/acp-runtime.md](design/acp-runtime.md); this document is the
lifecycle contract the server implements on top of it.

## States

`AgentStatus` (in `apps/server/src/agents/types.ts`):

- `creating` — row inserted; the workspace is being prepared or the host is starting
- `running` — the host is up and the engine has an ACP session
- `stopping` — soft-stop in progress
- `stopped` — the host is gone, agent row preserved (resumable via `start`)
- `archiving` — async cleanup during deletion (worktree check, cleanup, finalization)
- `error` — unrecoverable failure during launch / start / stop / archive, or the engine died on its own
- `unknown` — reserved/transitional. The `AgentStatus` type permits it but no code path currently sets it; the assisted-update queries treat it as a possible "in-flight" status defensively.

## Roles

`AgentRole` (column added in migration `0018_agents-role.sql`):

- `standard` — every agent created via the normal Create dialog or a job launch.
- `review` — persona review agents launched via `launch_persona` (see [Review Agent Lifecycle](#review-agent-lifecycle)).
- `assisted_update` — created exclusively by `POST /api/v1/release/assisted/launch`. Runs the assisted-update prompt and is wired to the assisted-update phase machine (see [Assisted-Update Phase Axis](#assisted-update-phase-axis)).

Role is orthogonal to `AgentType`, which names the engine: `claude` or `codex`.

## Setup Phases

`SetupPhase` is a sub-state of `creating`, surfaced to the UI while the server prepares the workspace (`apps/server/src/agents/workspace.ts`):

- `worktree` — creating the git worktree
- `env` — copying local config files
- `deps` — installing dependencies (lockfile-driven)
- `session` — starting the host and waiting for the engine's ACP handshake
- `null` — setup is complete (or never used; agents that don't create a worktree start at `session`)

Phases are written directly by the manager as it goes; there is no callback from a script. Worktree creation is the only unrecoverable step: on failure the agent goes to `stopped` with the git output in `last_error` and a `blocked` latest_event, and the partial worktree and branch are removed. A missing lockfile, a failed dependency install, or a missing local config file are non-fatal.

## Archive Phases

`ArchivePhase` (sub-state while `status = archiving`):

- `stopping` → `worktree-check` → `worktree-cleanup` → `finalizing` → `null` (soft-deleted)

Worktree cleanup mode is one of `auto` | `keep` | `force`, passed as the `cleanupWorktree` query param on `DELETE /api/v1/agents/:id`. `auto` preserves a worktree that has unmerged commits or uncommitted changes; `keep` always preserves; `force` always deletes.

Whenever the worktree is removed, `cleanupGitWorktree` also runs `git branch -D` on the branch — but only when Dispatch created it (`worktree_branch` is set and differs from `base_branch`). A worktree checked out on an existing branch loses only its directory. Cleanup failures are logged and swallowed; the worktree is left on disk and archival still completes.

## State Transitions

1. **Create**

- `creating → running` once the host reports a running engine
- `creating → error` on launch failure (the host never answered, or the engine failed its handshake); `last_error` carries the tail of the host log
- `creating → stopped` when worktree creation failed

The launch prompt (the Chat launch post, wrapped in the same envelope a typed message gets) is queued as the first turn as soon as the agent is `running`.

2. **Start** (resume after stop)

- If the agent's host is still alive (the server restarted, the host did not), the server reattaches and returns the agent at `running`
- Otherwise `stopped → creating → running`: a new host is spawned with the stored ACP session id, and the engine resumes it (`session/resume`) so the agent keeps its history
- `running → error` if the host cannot start

3. **Stop**

- `running → stopping → stopped`
- `running → error` if the host could not be stopped and its state is inconsistent
- `stop` on a `stopped` agent is a no-op (returns the current record with HTTP 200)

4. **Delete (archive)**

- `running | stopped → archiving → (soft-deleted)` via archive phases (`stopping` → `worktree-check` → `worktree-cleanup` → `finalizing`)
- Returns HTTP `202 { status: "archiving" }` immediately; cleanup runs in the background. Phase changes are broadcast on the agent SSE stream.
- Concurrent delete on an already-archiving agent returns `409`.
- `archiving → error` if cleanup throws.

5. **Restore (on startup)**

Before the first reconcile pass the server reattaches to every host that outlived the previous process: it connects to each running agent's socket, says which journal sequence it last applied, and the host replays anything after it. An agent whose host is gone is marked `stopped` ("Session ended while Dispatch was down.") and its open turn is settled as interrupted.

6. **Reconciliation (on startup, then every 30s)**

For each agent with status in (`running`, `stopping`, `creating`, `archiving`):

- **host alive, status `running`**: leave as-is.
- **host missing, status `creating`** (after a 15-minute grace for workspace preparation): → `error` with a launch-failure message and the tail of the host log.
- **host missing, status `running`**: → `stopped`, open turn settled.
- **status `stopping`** for >60s: → `running` (revert; user can retry stop). Surfaces an "agent reverted" latest_event.
- **status `archiving`** for >30s: archive is resumed.

An engine that exits on its own while the host is up is reported by the host as an `exit` event; the manager moves the agent to `error` with the exit code and the engine's stderr tail, without waiting for a reconcile tick.

Cleanup of orphaned hosts (hosts whose matching agent row is in a terminal state — `stopped` or `error`) runs only in the startup pass (`reconcileAgents()`), not on the periodic tick. Hosts with no matching DB record are left alone — they may belong to another server instance sharing the state root. Both are no-ops in inert mode.

## Host Contract

Each agent has a state directory `<agentStateRoot>/<agentId>/` (`~/.dispatch/agents/<agentId>/` in production; `DISPATCH_AGENT_STATE_ROOT` overrides it) holding `launch.json`, `host.sock`, `host.pid`, `journal.jsonl`, `session.json` and `host.log`. The server writes `launch.json` and spawns the host detached, in its own session and process group, through the user's login shell; the host owns everything else. `stop` removes the socket and pid; archive removes the directory.

`agentManager.getTerminalAccess(id)` answers `{ mode: "live" }` when the host is up or `{ mode: "inert", message }` when the runtime has no processes at all (test/CI). Every prompt to an agent — a Chat message, a review injection, a cross-agent message, a job prompt — goes through `enqueueAgentPrompt`, which queues one turn behind whatever the engine is already running. "Held" means a turn is running ahead of it.

## Local Config Files

`git worktree add` only materializes _tracked_ files, so a developer's
gitignored secrets and local overrides never reach a new worktree. The
workspace step copies a shared list of conventionally-gitignored filenames
from the source repo into the worktree — `apps/server/src/agents/worktree-local-config.ts`
owns the list (`WORKTREE_LOCAL_CONFIG_FILES`) and the copy.

Covered today: `.env`, `.env.local`, `.env.development.local`,
`.env.production.local`, `.env.test.local`, `.dev.vars` (Wrangler),
`local.settings.json` (Azure Functions), `terraform.tfvars` and
`terraform.tfvars.json`.

Rules the list follows:

- **Exact top-level filenames only** — no globs, no directory components.
  `assertTopLevelFileName` enforces this where the list is defined.
- Only names that are conventionally _gitignored_. Committed templates like
  `.env.example` are already in the worktree via the checkout.
- Only files that are _configuration_. Anything that grants the launched agent
  capabilities it wouldn't otherwise have stays off the list —
  `.claude/settings.local.json` was considered and rejected on those grounds.
- Only files that copying alone actually fixes. `.envrc` was considered and
  rejected: direnv will not load it until the new worktree is approved, and
  approving it automatically would execute repository-controlled code.
- An existing destination is never overwritten. A fresh worktree contains
  exactly the tracked files, so a destination that already exists means the
  repo commits that name, and the checked-out revision's copy is the correct
  one.
- Both sides are checked with `lstat` rather than `stat`, because a checkout
  is data and a repository may be untrusted: a symlinked source would make
  every name a read primitive pointing anywhere on disk, a symlinked
  destination a write primitive.
- Nothing in this step can abort an agent launch.

Deliberately _not_ covered, because each would require globbing or a directory
component: `*.auto.tfvars` (arbitrary prefix), Rails' `config/master.key`, and
`.streamlit/secrets.toml`.

Copying happens before the dependency install.

## Agent Environment

The host is started through the user's login shell (`$SHELL -lc`), so whatever `~/.zprofile` / `~/.bash_profile` export — `nvm`, `pyenv`, `GH_TOKEN`, an ssh agent — is available to the engine and to every command it runs. `~/.dispatch/env` is sourced after the profile, so it still wins for overrides:

```bash
# ~/.dispatch/env
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export GH_TOKEN="ghp_..."
```

The engine child additionally gets `DISPATCH_AGENT_ID`, `DISPATCH_MEDIA_DIR`, `DISPATCH_PORT`, `DISPATCH_SCHEME`, Dispatch's `bin/` and `~/.local/bin` ahead on `PATH`, and (for Claude) `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`. It does not inherit the server's `DATABASE_URL`, `DISPATCH_*` settings, TLS material or provider API keys: each engine authenticates through the host CLI's own login.

## Stop Contract

Soft stop (default): the server sends `shutdown` over the host socket; the host closes the ACP session, ends the adapter's stdin, and escalates to `SIGTERM` then `SIGKILL` on the adapter's process group if it does not exit. If the host itself has not exited within eight seconds the server signals the host's process group the same way.

Force stop (`force: true` on `POST /agents/:id/stop`) skips the graceful ACP close.

The repo's `stop` lifecycle hook (configured under `.dispatch/tools.json`) runs best-effort before the teardown.

## Idempotency Rules

- `start` on a `running` agent is a no-op (returns the agent at `running` with HTTP 200). The handler reattaches to a live host if one is found instead of spawning a new one.
- `stop` on a `stopped` agent is a no-op (returns the current record with HTTP 200).
- `delete` on an already-archiving agent returns `409`. Worktree retention is controlled by `?cleanupWorktree=auto|keep|force` rather than a `force` flag on the delete itself.

## Phase Axes — Don't Confuse Them

There are three independent state axes attached to an agent. Code that talks about "phase" should always name the axis:

| Axis                  | Values                                                                                                   | Set by                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `setup_phase`         | `worktree` / `env` / `deps` / `session` / `null`                                                         | the manager's workspace step                                 |
| `archive_phase`       | `stopping` / `worktree-check` / `worktree-cleanup` / `finalizing` / `null`                               | `executeArchive` in agent manager                            |
| Assisted-update phase | `inspect` / `prepare` / `apply` / `restarting` / `validate` / `done` / `rollback` / `blocked` / `failed` | the assisted-update agent via `POST /release/assisted/phase` |

## Assisted-Update Phase Axis

The assisted-update agent (role `assisted_update`) drives a separate state machine stored in `~/.dispatch/assisted-update.json` and managed by `apps/server/src/assisted-update-store.ts`. Phase order is:

`inspect → prepare → apply → restarting → validate → done`

Terminal phases: `done`, `rollback`, `blocked`, `failed`. The forward-only guard rejects backward transitions except into a terminal phase, which is reachable from any earlier phase.

On server startup, `rehydrateActiveAssistedJob` reads the on-disk state and resumes tracking the active job if the persisted phase is non-terminal — this lets the in-app Updates pane keep showing progress across a Dispatch restart that the assisted update itself triggered.

## Review Agent Lifecycle

Review agents are ordinary child agents with role `review`. Launching one does not create a review record. The review agent completes its initial pass by calling `review_submit`; a review with no feedback items records a clean approval, while a review with items remains open until the parent resolves or dismisses each item.

Questions and follow-up discussion use each feedback item's tracked thread. Review status is derived from the item states rather than a separate reviewer state machine.
