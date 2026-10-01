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
- `release-candidate.json` — a just-activated release, promoted into `release.json` once it boots healthy
- `cache/release-<tag>.tar.gz` — cached pre-built release artifacts (override dir with `DISPATCH_RELEASE_CACHE_DIR`)
- `logs/dispatch.log` — service stdout/stderr (rotated by the server, see Diagnostics)
- `agents/<agentId>/` — per-agent host state: launch file, socket, pid, journal, log (see Diagnostics)

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

The **release workflow** (`.github/workflows/release.yml`) runs on that dispatch or on a pushed `vX.Y.Z` tag (which must point at `main` and match `package.json`):

- **Prepare** (dispatch only): bumps the version in every workspace manifest, the browser-extension manifest and the lockfile; generates `release-notes/current.md`; commits to `main` and tags it.
- **Verify**: type check, web lint, and unit tests against an ephemeral Postgres (the full `pnpm run ci` runs on the PRs that feed `main`).
- **Build**: Bun binaries for every platform/arch packed into `dispatch-server.tar.gz`, plus the signed, notarized Mac app (`dispatch-macos-<build>-arm64.zip`).
- **Smoke test**: boots the packed binary on Linux and macOS runners against an ephemeral Postgres.
- **Publish**: one GitHub **prerelease** for the tag with both assets, then the Mac build enters the macOS appcast on the Sparkle `preview` channel.

**Promoting** a release to stable (`.github/workflows/promote-release.yml`, or Settings → Releases → Promote, which dispatches it) removes the appcast entry's channel tag and marks the GitHub release non-prerelease and latest. Nothing is rebuilt. Linux installs and the standalone updater follow the GitHub prerelease flag; see [macOS releases](macos-releases.md) for the app side.

## Update To A Tag

```bash
# Update to a specific tag (also used for rollback)
curl -X POST http://127.0.0.1:6767/api/v1/release/update \
  -H 'Content-Type: application/json' \
  -d '{"tag":"v1.2.3"}'
```

The server update flow operates on `~/.dispatch/server/` and:

1. **Confirms** the tag exists in GitHub Releases.
2. **Checks agent survival (Linux).** Refuses to continue unless `systemctl --user show dispatch.service -p KillMode` reports `KillMode=process`, so the restart leaves agent hosts running.
3. **Deploys from the release artifact.** Downloads `dispatch-server.tar.gz` via direct HTTPS into the tarball cache (`~/.dispatch/cache/release-<tag>.tar.gz`), validates it, verifies the platform binary checksum, and atomically replaces `~/.dispatch/server/dispatch`. The previous executable is retained as `dispatch.previous`.
4. **Records a candidate** for the newly restarted process to promote into `~/.dispatch/release.json` after it is healthy.
5. **Restarts the service** by detaching `launchctl kickstart -k gui/$(id -u)/com.dispatch.server` (or `systemctl --user restart dispatch` on Linux). The new process binds the port itself; the standard update flow does not poll for health afterwards. Use `bin/dispatch-server status` (or hit `/api/v1/health`) to confirm.

If the update fails mid-flight (e.g. archive extraction error, missing binary), the job's phase is set to `failed` with the error in the SSE stream and the active job state. There is **no automatic rollback** — re-issue the update against the previous tag, or copy `dispatch.previous` back over `dispatch` and restart the service.

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

**MCP tool renames do not roll back cleanly.** Agents hold the tool list they
fetched at session start, so after rolling back past a release that renamed an
MCP tool, already-running agents call a name the older server does not register.
Stop and start those agents so they refetch `tools/list`.

## CI Pipeline

Every PR to `main` triggers `.github/workflows/ci.yml`:

- Sets up `pnpm`, `bun`, `node`, and an ephemeral Postgres 17 container
- Installs Playwright Chromium
- Runs `pnpm run ci`, which is `format && check && lint:web && build && test && test:e2e`
- Builds Bun binaries (`pnpm run build:bun`) and smoke-tests the host-platform binary

PRs must pass CI before merge.

## Configuration

Server configuration lives in `~/.dispatch/server/.env`. Key variables:

| Variable                    | Default                                                | Description                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISPATCH_HOST`             | `127.0.0.1`                                            | Interface to bind the API server to. Set `0.0.0.0` only when the machine must accept remote connections.                                                                                          |
| `DISPATCH_PORT`             | `6767`                                                 | HTTP port the server listens on                                                                                                                                                                   |
| `DATABASE_URL`              | `postgres://dispatch:dispatch@127.0.0.1:5432/dispatch` | Postgres connection string                                                                                                                                                                        |
| `DISPATCH_STATE_DIR`        | `$HOME/.dispatch`                                      | Root for one install's state: release/update stores, diagnostics, logs, and the defaults for `DISPATCH_FILES_ROOT` and `DISPATCH_AGENT_STATE_ROOT`. Point a second instance at its own directory. |
| `DISPATCH_FILES_ROOT`       | `$HOME/.dispatch/files`                                | File upload storage path. A leading `~` is expanded, but prefer an absolute path.                                                                                                                 |
| `DISPATCH_AGENT_RUNTIME`    | `acp`                                                  | Agent runtime mode (`acp`, or `inert` for dev/test with no engines)                                                                                                                               |
| `DISPATCH_AGENT_STATE_ROOT` | `$HOME/.dispatch/agents`                               | Per-agent host state directories                                                                                                                                                                  |
| `DISPATCH_COPY_DISPLAY`     | —                                                      | Virtual X display for clipboard image paste on Linux (e.g. `:99`)                                                                                                                                 |
| `TLS_CERT`                  | —                                                      | Path to TLS certificate file (enables HTTPS when both cert and key are set)                                                                                                                       |
| `TLS_KEY`                   | —                                                      | Path to TLS private key file                                                                                                                                                                      |

Changes to `.env` require a service restart to take effect.

## Engines

Dispatch drives Claude Code and Codex. The ACP adapter for each ships inside
the Dispatch binary and runs as a mode of it (`dispatch claude-acp`,
`dispatch codex-acp`), so there is nothing to install or configure for them.

What the machine needs is the engine CLI itself, which the person installs
and signs into:

```bash
npm i -g @anthropic-ai/claude-code   # then: claude   (sign in)
npm i -g @openai/codex               # then: codex    (sign in)
```

Dispatch finds each CLI on `PATH`, and failing that in the usual install
locations (`~/.local/bin`, `~/.bun/bin`, `~/.volta/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`), which is what a launchd or systemd service needs since its
`PATH` is minimal. `DISPATCH_CLAUDE_BIN` and `DISPATCH_CODEX_BIN` override the
lookup with an absolute path.

What is installed, and where it was found:

```bash
curl -s http://127.0.0.1:6767/api/v1/system/engines | jq
```

An engine whose CLI is missing is marked "not installed" in the create-agent
picker, and launching an agent of that type fails with the command to install
it rather than a spawn error.

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

### Agents Stopped Unexpectedly

If agents were `running` and then reconcile changed them to `stopped`, or an agent went to `error` with "The agent exited", start here.

Each agent's host keeps its own state under `~/.dispatch/agents/<agentId>/`:

- `host.log` — stderr of the host and of the engine adapter; the first place to look
- `journal.jsonl` — every ACP event the host saw, with a sequence number
- `host.pid`, `host.sock` — present while the host is alive
- `session.json` — the ACP session id the host opened or resumed

Recommended workflow:

1. Confirm what Dispatch observed.

```bash
tail -n 200 ~/.dispatch/logs/dispatch.log
```

Look for `Restored running agents` (with `attached` and `lost` lists) after a restart, `agent host is gone`, and `The agent exited`.

2. Read the host log for the affected agent.

```bash
tail -n 50 ~/.dispatch/agents/<agentId>/host.log
```

An engine that could not start says so here (a missing adapter, a login that expired: run `claude /login` as the service user). A crash mid-turn shows the adapter's last stderr lines.

3. Check whether the host is still alive.

```bash
kill -0 "$(cat ~/.dispatch/agents/<agentId>/host.pid)" && echo alive
```

A host that is alive while the agent reads `stopped` means the server could not reach its socket; a Dispatch restart reattaches. A dead host with a live agent row is what reconcile corrects on its next tick.

4. Pull macOS unified logs around the incident window if the host itself was killed.

```bash
log show --style compact --start "<start>" --end "<end>" --predicate '(process == "launchd") || (eventMessage CONTAINS[c] "com.dispatch.server") || (eventMessage CONTAINS[c] "SIGKILL") || (eventMessage CONTAINS[c] "logout")'
```

Hosts run in their own process group, so a Dispatch restart never takes them down; a user logout or a same-user automation that kills process trees will.

## Bin Scripts

| Script                    | Description                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `bin/dispatch-server`     | Service management wrapper (start, stop, restart, status, logs, build, update)                     |
| `bin/install-dispatch.sh` | First-time artifact install for macOS and Linux; writes the fixed runtime and service definition   |
| `bin/dispatch-dev`        | Dev environment manager (isolated Docker Postgres + API server + Vite frontend)                    |
| `bin/dispatch-stream`     | Agent-side CLI for managing browser streams (`start --playwright <port>` / `stop "<description>"`) |
| `bin/install-dispatch.sh` | Fresh artifact-only installer for macOS and Linux                                                  |
| `bin/pack-release`        | Packs `dispatch-server.tar.gz` from pre-built Bun binaries; used by the release workflow           |

## File Locations

| Path                                               | Description                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `~/.dispatch/server/`                              | Server checkout (deploy target)                                            |
| `~/.dispatch/server/.env`                          | Server environment config                                                  |
| `~/.dispatch/server/dist/bun/`                     | Compiled Bun binaries the wrapper execs                                    |
| `~/.dispatch/release.json`                         | Currently deployed tag + `deployedAt` timestamp                            |
| `~/.dispatch/release-candidate.json`               | Just-activated release awaiting a healthy boot                             |
| `~/.dispatch/cache/release-<tag>.tar.gz`           | Cached pre-built release artifacts keyed by tag                            |
| `~/.dispatch/logs/dispatch.log`                    | Live server log (rotated via copy-truncate at 10 MB; backups kept 14 days) |
| `~/.dispatch/agents/<agentId>/`                    | Per-agent host state: launch file, socket, pid, journal, host log          |
| `~/Library/LaunchAgents/com.dispatch.server.plist` | launchd service definition (points at the fixed runtime)                   |
