# Operations Runbook

This runbook is for running Dispatch reliably across agent/session boundaries and host restarts.

## Architecture Overview

Dispatch runs as a **launchd LaunchAgent** (`com.dispatch.server`) — a macOS-native service manager that:

- Starts automatically at login
- Restarts automatically if the process crashes
- Runs as the current user with full environment access
- Cannot be accidentally stopped by agents working in the repo

The server lives in an **artifact install** at `~/.dispatch/server/`, independent from any working copy. Regular installs have no checkout, build toolchain, or runtime git dependency.

The server runs as a **compiled Bun binary** at its fixed runtime path (normally `~/.dispatch/server/dispatch`). The host needs `bun` and `pnpm` only when building from source — not just to run the service.

**Postgres** runs via Homebrew (`brew services start postgresql@17`, port 5432). Docker is available for isolated dev databases via `dispatch-dev`.

**Server port**: 6767 (set via `DISPATCH_PORT` in `~/.dispatch/server/.env`).

**Per-install state** lives outside the repo checkout in `~/.dispatch/`:

- `release.json` — the currently deployed tag and `deployedAt` timestamp
- `assisted-update.json` — in-progress assisted-update state (token, phase, checks, notes)
- `applied-migrations.json` — install-update migration ids that have been applied locally (CRU-146)
- `cache/release-<tag>.tar.gz` — cached pre-built release artifacts (override dir with `DISPATCH_RELEASE_CACHE_DIR`)
- `logs/dispatch.log` — service stdout/stderr (rotated by the server, see Diagnostics)
- `diagnostics/` — periodic tmux inventory + missing-session incident bundles

## Service Management

The simplest way to manage the running service is the `bin/dispatch-server` wrapper in the production checkout. It resolves the configured port from `~/.dispatch/server/.env`, runs a TLS-aware health check, and tails the log on failure:

```bash
cd ~/.dispatch/server
bin/dispatch-server status        # launchd state + health check JSON
bin/dispatch-server start         # bootstrap (or kickstart if already loaded)
bin/dispatch-server stop          # bootout
bin/dispatch-server restart       # kickstart -k
bin/dispatch-server logs          # tail -n 200 ~/.dispatch/logs/dispatch.log
bin/dispatch-server logs -f       # follow
bin/dispatch-server build         # pnpm install + pnpm run build:bun
bin/dispatch-server update        # build + restart + health check
```

Equivalent raw `launchctl` commands for scripting:

```bash
# Service state
launchctl print "gui/$(id -u)/com.dispatch.server"

# Live logs
tail -f ~/.dispatch/logs/dispatch.log

# Load (first-time after install) / unload
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.dispatch.server.plist
launchctl bootout    "gui/$(id -u)/com.dispatch.server"

# Restart in place (preserves the bootstrap; what `restart` and the release
# flow use)
launchctl kickstart -k "gui/$(id -u)/com.dispatch.server"
```

## Database

Production uses Homebrew Postgres (native, no Docker overhead):

```bash
brew services start postgresql@17   # start (auto-starts at boot)
brew services stop postgresql@17    # stop
pg_isready                          # check status
```

For development, `dispatch-dev up` creates an isolated Docker Postgres container on a free port — no manual setup needed.

## Release Pipeline

Releases are triggered from the Dispatch UI in **Settings → Releases** (release admin only — `gh repo view --json viewerPermission` must be `ADMIN`). The server handles the job internally via `POST /api/v1/release`:

1. Verifies the GitHub CLI (`gh`) is available
2. Resolves the upstream repo from the production checkout's `origin` remote
3. Triggers the `.github/workflows/release.yml` workflow via `gh workflow run`
4. Streams `gh run watch` for the spawned run id; phase moves through `preflight` → `triggering` → `watching`
5. On workflow success: pulls the latest tag from the repo and reports `done`
6. On workflow failure: sets phase to `failed` with the run URL in the error string

The actual deploy of that new tag is a separate operator step (the UI offers an "Update to vX.Y.Z" button on the Releases section, which calls `POST /api/v1/release/update`).

```bash
# Trigger a patch release from the API
curl -X POST http://127.0.0.1:6767/api/v1/release \
  -H 'Content-Type: application/json' \
  -d '{"versionType":"patch"}'
```

The **release workflow** (GitHub Actions):

- **Prepare**: bumps the version in the root `package.json`, every workspace package (`apps/*/package.json`), the browser-extension manifest, and the lockfile; generates `release-notes/current.md` from GitHub's auto-generated notes (embedding `release-notes/next-assisted-update.json` if present); commits and pushes to `main`. No tag is created yet.
- **Verify**: runs type check, web lint, and unit tests against an ephemeral Postgres container (the full `pnpm run ci` — format, build, e2e — runs on the PRs that feed `main`, not here)
- **Build**: builds Bun binaries for each host platform/arch (macOS binaries are Developer ID signed and notarized) and packs them into `dispatch-release.tar.gz` via `bin/pack-release`
- **Smoke test**: boots the packed binary on both Linux and macOS runners against an ephemeral Postgres (macOS also verifies the code signature)
- **Publish**: confirms `main` hasn't advanced past the release commit and the tag doesn't already exist, then runs `gh release create` — this is what creates the git tag — publishing a **pre-release** GitHub Release with the tarball attached. Releases are promoted to non-prerelease (the "stable" channel) via `POST /api/v1/release/promote` once they soak.

## Update To A Tag

```bash
# Update to a specific tag (also used for rollback)
curl -X POST http://127.0.0.1:6767/api/v1/release/update \
  -H 'Content-Type: application/json' \
  -d '{"tag":"v1.2.3"}'
```

The server update flow operates on `~/.dispatch/server/` and:

1. **Gates the request.** If the target release has pending update-migrations (CRU-146) or its body declares `mode: required` in a `dispatch-update` block (and the install isn't already past `appliesFrom`), responds `409` with `ASSISTED_UPDATE_REQUIRED` — caller must use `/release/assisted/launch` instead, or pass `force: true` to override. Returns `503` `MIGRATION_EVALUATION_UNAVAILABLE` if the migration evaluator can't reach the tarball (transient — retry, or pass `force: true` to skip the migration check).
2. **Confirms** the tag exists in GitHub Releases.
3. **Deploys from the release artifact.** Downloads `dispatch-release.tar.gz` via direct HTTPS into the tarball cache (`~/.dispatch/cache/release-<tag>.tar.gz`), validates it, verifies the platform binary checksum, and atomically replaces `~/.dispatch/server/dispatch`. The previous executable is retained as `dispatch.previous`.
4. **Records a candidate** for the newly restarted process to promote into `~/.dispatch/release.json` after it is healthy.
5. **Restarts the service** by detaching `launchctl kickstart -k gui/$(id -u)/com.dispatch.server` (or `systemctl --user restart dispatch` on Linux). The new process binds the port itself; the standard update flow does not poll for health afterwards. Use `bin/dispatch-server status` (or hit `/api/v1/health`) to confirm.

If the update fails mid-flight (e.g. archive extraction error, missing binary), the job's phase is set to `failed` with the error in the SSE stream and the active job state. There is **no automatic rollback** in the standard flow — re-issue the update against the previous tag manually, or use the assisted-update flow which can drive rollback.

## Rollback

```bash
# Roll back to a previously deployed tag
curl -X POST http://127.0.0.1:6767/api/v1/release/update \
  -H 'Content-Type: application/json' \
  -d '{"tag":"v1.2.2"}'
```

Rollback is just an `update` to an older tag. The currently deployed tag is whatever was last written to `~/.dispatch/release.json`:

```bash
cat ~/.dispatch/release.json
```

If the failed update went through the assisted-update flow, the launched agent can drive rollback explicitly (it has the bearer token and follows the recovery guidance in its initial prompt). The state lands in `~/.dispatch/assisted-update.json` with `phase: "rollback"` if it goes that route.

## Assisted Update

For releases that have pending install-update migrations (CRU-146) or carry an assisted-update block in the release body, updates run via a dedicated flow that spawns a full-access agent on the production checkout to perform the work step-by-step.

```bash
# Launch the assisted-update flow for a tag
curl -X POST http://127.0.0.1:6767/api/v1/release/assisted/launch \
  -H 'Content-Type: application/json' \
  -d '{"tag":"v1.2.3"}'

# Inspect persisted state
curl -s http://127.0.0.1:6767/api/v1/release/assisted/state | jq

# Clear stuck state
curl -X DELETE http://127.0.0.1:6767/api/v1/release/assisted/state
```

What the launch endpoint does:

- Picks the first enabled CLI agent type (`claude` / `codex` / `cursor` / `opencode`) — terminal-type agents can't drive assisted updates.
- Snapshots pending update-migrations from `update-migrations/*.yaml` in the target tarball, or falls back to the `dispatch-update` block in the release body.
- Creates an `assisted_update` agent rooted at `~/.dispatch/server/` with `fullAccess: true`, no worktree, and an initial prompt that includes recovery instructions plus a bearer token (`DISPATCH_RELEASE_UPDATE_TOKEN`).
- Persists `~/.dispatch/assisted-update.json` with the token, target tag, snapshotted manifests, and the required-checks list.

The agent reports progress by `POST /api/v1/release/assisted/phase` with its bearer token. The phase axis is:

```
inspect → prepare → apply → restarting → validate → done
                                          ↓
                          rollback / blocked / failed (terminal)
```

When the agent moves to `validate`, the server runs `runAndRecordChecks`, which evaluates the required checks listed in the manifests/metadata. The known check names (defined in `apps/server/src/release-metadata.ts`):

- `expected_runtime_artifact` — the fixed runtime executable exists after deploy
- `service_entrypoint` — `apps/server/package.json` has a `scripts.start` entry
- `service_restarted` — `~/.dispatch/release.json` is present (lenient proxy for restart; the deeper check is `health_endpoint`)
- `version_converged` — `~/.dispatch/release.json` tag matches the target tag
- `health_endpoint` — the new process is serving HTTP/HTTPS with `status: "ok"`

When the agent succeeds, the server writes the manifest ids into `~/.dispatch/applied-migrations.json` so the gate stops firing for them on the next update.

Authoring assisted-update metadata in release notes is documented in `release-notes/AUTHORING.md`. Migration manifests use the schema in `apps/server/src/update-migrations.ts`; existing examples live in `update-migrations/`.

## CI Pipeline

Every PR to `main` triggers `.github/workflows/ci.yml`:

- Sets up `pnpm`, `bun`, `node`, and an ephemeral Postgres 17 container
- Installs Playwright Chromium
- Validates `release-notes/next-assisted-update.json` (when present) via `bin/embed-assisted-update.ts --check-only`
- Runs `pnpm run ci`, which is `format && check && lint:web && build && test && test:e2e`
- Builds Bun binaries (`pnpm run build:bun`) and smoke-tests the host-platform binary

PRs must pass CI before merge.

## Configuration

Server configuration lives in `~/.dispatch/server/.env`. Key variables:

| Variable                 | Default                                                | Description                                                                                              |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `DISPATCH_HOST`          | `127.0.0.1`                                            | Interface to bind the API server to. Set `0.0.0.0` only when the machine must accept remote connections. |
| `DISPATCH_PORT`          | `6767`                                                 | HTTP port the server listens on                                                                          |
| `DATABASE_URL`           | `postgres://dispatch:dispatch@127.0.0.1:5432/dispatch` | Postgres connection string                                                                               |
| `MEDIA_ROOT`             | `~/.dispatch/media`                                    | File upload storage path                                                                                 |
| `DISPATCH_AGENT_RUNTIME` | `tmux`                                                 | Agent runtime mode (`tmux` or `inert` for dev/test)                                                      |
| `DISPATCH_COPY_DISPLAY`  | —                                                      | Virtual X display for clipboard image paste on Linux (e.g. `:99`)                                        |
| `TLS_CERT`               | —                                                      | Path to TLS certificate file (enables HTTPS when both cert and key are set)                              |
| `TLS_KEY`                | —                                                      | Path to TLS private key file                                                                             |

Changes to `.env` require a service restart to take effect.

## Diagnostics

Health check:

```bash
curl -s http://127.0.0.1:6767/api/v1/health | jq
```

Git context troubleshooting:

`gitContext` is populated synchronously at agent creation, setup-complete, and every restart, then pushed to clients via SSE. There is no periodic refresh loop or diagnostics endpoint — to inspect what the server has stored, query the agents table directly:

```bash
psql "$DATABASE_URL" -c "SELECT id, name, git_context, git_context_stale, git_context_updated_at FROM agents WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 20;"
```

What to look for:

- `git_context_stale = true`: the most recent probe errored (worktree missing, repo permissions, etc.); the prior `git_context` value is preserved for display
- `git_context IS NULL` for a worktree-backed agent: a probe error happened before any successful probe, or the agent predates inline-populate and has not been restarted since the upgrade
- `git_context_updated_at` far older than `updated_at`: the agent has not gone through a lifecycle event that re-probes — restart the agent to refresh

### Sessions Disappeared

If agents were `running` and then suddenly reconcile changed them to `stopped`, start here.

Dispatch now writes host-side tmux diagnostics to:

```bash
~/.dispatch/diagnostics/tmux-inventory.jsonl
~/.dispatch/diagnostics/*-missing-session-<agentId>.json
```

What these files mean:

- `tmux-inventory.jsonl`: periodic snapshots taken during reconcile
- `*-missing-session-<agentId>.json`: incident bundle written when reconcile expects a tmux session but `tmux has-session` fails

Recommended incident workflow:

1. Confirm what Dispatch observed.

```bash
tail -n 200 ~/.dispatch/logs/dispatch.log
```

Look for lines like:

- `status corrected to stopped`
- `Agent process exited with code ...`
- repeated reconcile corrections across multiple agents in the same minute

2. Inspect the most recent missing-session incident bundle.

```bash
ls -1t ~/.dispatch/diagnostics/*-missing-session-*.json | head
jq . ~/.dispatch/diagnostics/<timestamp>-missing-session-<agentId>.json
```

Important fields:

- `agent`: which agent was affected, what status it had, and whether an exit code file existed
- `tmux.serverPid`: whether Dispatch could still find a tmux server process
- `tmux.sessions` and `tmux.panes`: whether `tmux list-sessions` / `list-panes` still worked at incident time
- `processes.stdout`: point-in-time process list
- `launchctl.stdout`: current `com.dispatch.server` launchd state

3. Check whether the tmux server disappeared entirely or just Dispatch sessions.

```bash
tail -n 20 ~/.dispatch/diagnostics/tmux-inventory.jsonl | jq .
```

What to look for:

- `serverPid` changed or became `null`: tmux server likely exited or was killed
- `sessions.exitCode` changed from `0` to `1`: tmux had no reachable server/socket
- non-Dispatch sessions still present but Dispatch sessions gone: cleanup bug or targeted session removal
- all sessions gone at once: host/session-level event is more likely than app logic

4. Check launchd state for the server itself.

```bash
launchctl print gui/$(id -u)/com.dispatch.server
```

What to look for:

- `last exit code`
- `last terminating signal`
- recent restart timing that lines up with the incident

5. Pull macOS unified logs around the incident window.

Use a tight window around when the sessions disappeared.

```bash
log show --style compact --start "2026-03-13 12:57:30" --end "2026-03-13 12:59:30" --predicate '(process == "tmux") || (process == "launchd") || (eventMessage CONTAINS[c] "com.dispatch.server") || (eventMessage CONTAINS[c] "logout") || (eventMessage CONTAINS[c] "Aqua")'
```

If needed, run narrower follow-ups:

```bash
log show --style compact --start "<start>" --end "<end>" --predicate '(process == "kernel") || (eventMessage CONTAINS[c] "SIGKILL") || (eventMessage CONTAINS[c] "killed") || (eventMessage CONTAINS[c] "jetsam")'
log show --style compact --start "<start>" --end "<end>" --predicate '(process == "loginwindow") || (eventMessage CONTAINS[c] "logout") || (eventMessage CONTAINS[c] "user session")'
```

Interpretation:

- Dispatch restarted but tmux stayed up: app restart only, agent sessions should have survived
- Dispatch and tmux both disappeared: something outside Dispatch likely killed a broader user-scoped context
- logout / Aqua / loginwindow activity: user session event likely killed tmux
- `SIGKILL` or kernel kill messages near the same time: external kill or resource pressure

6. Check for same-user interference.

If self-hosted GitHub Actions runners or other automation run under the same macOS user, treat that as a suspect until proven otherwise. `tmux` and `launchd` state are user-scoped, so same-user automation has a much larger blast radius than automation running under a separate account.

Known limits:

- Dispatch can now tell you much more about what the host looked like when sessions vanished
- Dispatch still cannot prove the killer if macOS did not log it or if the evidence aged out before inspection
- If the host logged out, rebooted, or aggressively reaped processes, unified logs are still the source of truth

## Bin Scripts

| Script                         | Description                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `bin/dispatch-server`          | Service management wrapper (start, stop, restart, status, logs, build, update)                     |
| `bin/install-dispatch.sh`      | First-time artifact install for macOS and Linux; writes the fixed runtime and service definition   |
| `bin/dispatch-dev`             | Dev environment manager (isolated Docker Postgres + API server + Vite frontend)                    |
| `bin/dispatch-stream`          | Agent-side CLI for managing browser streams (`start --playwright <port>` / `stop "<description>"`) |
| `bin/install-dispatch.sh`      | Fresh artifact-only installer for macOS and Linux                                                  |
| `bin/pack-release`             | Packs `dispatch-release.tar.gz` from pre-built Bun binaries; used by the release workflow          |
| `bin/embed-assisted-update.ts` | Validates assisted-update metadata in `release-notes/next-assisted-update.json`                    |

## File Locations

| Path                                                       | Description                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `~/.dispatch/server/`                                      | Server checkout (deploy target)                                             |
| `~/.dispatch/server/.env`                                  | Server environment config                                                   |
| `~/.dispatch/server/dist/bun/`                             | Compiled Bun binaries the wrapper execs                                     |
| `~/.dispatch/release.json`                                 | Currently deployed tag + `deployedAt` timestamp                             |
| `~/.dispatch/assisted-update.json`                         | In-progress assisted-update state (token, phase, checks, notes)             |
| `~/.dispatch/applied-migrations.json`                      | Install-update migration ids that have been applied locally (CRU-146)       |
| `~/.dispatch/cache/release-<tag>.tar.gz`                   | Cached pre-built release artifacts keyed by tag                             |
| `~/.dispatch/logs/dispatch.log`                            | Live server log (rotated via copy-truncate at 10 MB; backups kept 14 days)  |
| `~/.dispatch/diagnostics/tmux-inventory.jsonl`             | Periodic tmux inventory snapshots from reconcile (rotated at 10 MB; 7 days) |
| `~/.dispatch/diagnostics/*-missing-session-<agentId>.json` | Incident bundle for missing tmux sessions (pruned after 7 days)             |
| `~/Library/LaunchAgents/com.dispatch.server.plist`         | launchd service definition (points at the fixed runtime)                    |
