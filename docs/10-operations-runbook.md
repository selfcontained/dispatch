# Operations Runbook

This runbook is for running Dispatch reliably across agent/session boundaries and host restarts.

`<state>` below is the install's state directory (`DISPATCH_STATE_DIR`): `~/.local/share/dispatch` for an installer-managed server, `~/.dispatch-mac` for the Mac app. Service names are the 1.x ones the installer writes (`dispatch-server` on Linux, `dev.dispatch.server` on macOS, via `DISPATCH_SERVICE_NAME`). A Dispatch 0.x install keeps `~/.dispatch`, `dispatch.service` and `com.dispatch.server`; 1.x never touches them.

## Architecture Overview

Dispatch runs as a user service — a systemd user unit (`dispatch-server`) on Linux, a launchd LaunchAgent (`dev.dispatch.server`) for a standalone macOS server — that:

- Starts automatically at login
- Restarts automatically if the process crashes
- Runs as the current user with full environment access
- Cannot be accidentally stopped by agents working in the repo

The server lives in an **artifact install** at `<state>/server/`, independent from any working copy. Regular installs have no checkout, build toolchain, or runtime git dependency.

The server runs as a **compiled Bun binary** at its fixed runtime path (normally `<state>/server/dispatch`). The host needs `bun` and `pnpm` only when building from source — not just to run the service.

**Postgres** runs via Homebrew (`brew services start postgresql@17`, port 5432). Docker is available for isolated dev databases via `dispatch-dev`.

**Server port**: 6767, or the next free port the installer found (set via `DISPATCH_PORT` in `<state>/server/.env`).

**Per-install state** lives outside the repo checkout in `<state>/`:

- `release.json` — the currently deployed tag and `deployedAt` timestamp
- `release-candidate.json` — a just-activated release, promoted into `release.json` once it boots healthy
- `cache/release-<tag>.tar.gz` — cached pre-built release artifacts (override dir with `DISPATCH_RELEASE_CACHE_DIR`)
- `logs/dispatch.log` — service stdout/stderr (rotated by the server, see Diagnostics)
- `agents/<agentId>/` — per-agent host state: launch file, socket, pid, journal, log (see Diagnostics)

## Service Management

Linux (systemd user unit):

```bash
systemctl --user status dispatch-server
systemctl --user restart dispatch-server     # what the update flow runs
systemctl --user stop dispatch-server
journalctl --user -u dispatch-server -f
curl http://127.0.0.1:<port>/api/v1/health    # port is DISPATCH_PORT in <state>/server/.env
```

Standalone macOS server (LaunchAgent):

```bash
launchctl print "gui/$(id -u)/dev.dispatch.server"
tail -f <state>/logs/dispatch.log
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.dispatch.server.plist
launchctl bootout    "gui/$(id -u)/dev.dispatch.server"
launchctl kickstart -k "gui/$(id -u)/dev.dispatch.server"   # what the update flow runs
```

The Mac app manages its own server from the menu bar.

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

Release from `main` only, through Settings → Releases or GitHub Actions →
Release → Run workflow. Equivalently:

```bash
gh workflow run release.yml --repo selfcontained/dispatch --ref main -f version=patch
```

Every release publishes to Preview. Promotion to Stable is a separate action
after the published build updates successfully on the designated hosts.

The **release workflow** (`.github/workflows/release.yml`) runs on that dispatch or on a pushed `vX.Y.Z` tag (which must point at `main` and match `package.json`):

- **Prepare** (dispatch only): bumps the version in every workspace manifest, the browser-extension manifest and the lockfile; generates `release-notes/current.md`; commits to `main` and tags it.
- **Verify**: type check, web lint, and unit tests against an ephemeral Postgres (the full `pnpm run ci` runs on the PRs that feed `main`).
- **Build**: Bun binaries for every platform/arch packed into `dispatch-server.tar.gz`, plus the signed, notarized Mac app (`dispatch-macos-<build>-arm64.zip`).
- **Smoke test**: boots the packed binary on Linux and macOS runners against an ephemeral Postgres.
- **Publish**: one GitHub **prerelease** for the tag with both assets, then the Mac build enters the macOS appcast on the Sparkle `preview` channel.

**Promoting** a release to stable (`.github/workflows/promote-release.yml`, or Settings → Releases → Promote, which dispatches it) removes the appcast entry's channel tag and marks the GitHub release non-prerelease and latest. Nothing is rebuilt. Linux installs and the standalone updater follow the GitHub prerelease flag; see [macOS releases](macos-releases.md) for the app side.

## Updates and recovery

Dispatch 1.x requires a fresh install and a new database. Updating an existing
1.x installation is supported; migrating a 0.x database is not.

The installer records `DISPATCH_SERVICE_NAME` in the private configuration.
Standalone macOS service updates refuse missing or blank service names before
downloading or replacing the executable; repair the installation configuration
instead of guessing a service name. Normal startup does not require this setting.

Use **Settings → Updates** to follow the install's Stable or Preview channel.
For a standalone server, an operator can request a specific compatible tag:

```bash
curl -X POST http://127.0.0.1:6767/api/v1/release/update \
  -H 'Content-Type: application/json' \
  -d '{"tag":"v1.2.3"}'
```

Linux protected updates require an enrolled, dedicated local database and the
independent recovery startup gate. The updater verifies the published artifact
and target recovery capability, fences new work, and defers while work is busy.
It verifies a database/state recovery point before activation. The independent
helper trials the new process, confirms readiness, and commits only after
successful probation. A failed trial restores the verified prior executable,
database and state; unresolved recovery remains fenced with evidence retained.
Existing services without enrollment, external databases and unsupported state
paths require an explicit operator procedure; they are not silently treated as
protected installations.

The native Mac app owns its updates through Sparkle. It uses an independent
signed recovery helper and a verified snapshot of the app and private managed
database/state, retaining the intended running/stopped state. External database
configurations fail closed rather than claiming automatic recovery.

See [the recovery implementation](update-backup-recovery-spec.md#recovery-implementation)
and [native Mac recovery](macos-native-recovery.md) for supported prerequisites,
recovery evidence and troubleshooting. Preserve recovery journals and snapshots
when recovery is incomplete. Do not manually replace an executable or install an
old tag against a database whose schema has changed; that is not a coordinated
rollback.

A GitHub release promotion is separate from an installation's recovery commit:
promotion makes the same tested assets available to Stable, whereas the helper
commits a particular host's healthy update transaction.

## CI Pipeline

Every PR to `main` triggers `.github/workflows/ci.yml`:

- Sets up `pnpm`, `bun`, `node`, and an ephemeral Postgres 17 container
- Installs Playwright Chromium
- Runs `pnpm run ci`, which is `format && check && lint:web && build && test && test:e2e`
- Builds Bun binaries (`pnpm run build:bun`) and smoke-tests the host-platform binary

PRs must pass CI before merge.

## Configuration

Server configuration lives in `<state>/server/.env`. Key variables:

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

Each agent's host keeps its own state under `<state>/agents/<agentId>/`:

- `host.log` — stderr of the host and of the engine adapter; the first place to look
- `journal.jsonl` — every ACP event the host saw, with a sequence number
- `host.pid`, `host.sock` — present while the host is alive
- `session.json` — the ACP session id the host opened or resumed

Recommended workflow:

1. Confirm what Dispatch observed.

```bash
tail -n 200 <state>/logs/dispatch.log
```

Look for `Restored running agents` (with `attached` and `lost` lists) after a restart, `agent host is gone`, and `The agent exited`.

2. Read the host log for the affected agent.

```bash
tail -n 50 <state>/agents/<agentId>/host.log
```

An engine that could not start says so here (a missing adapter, a login that expired: run `claude /login` as the service user). A crash mid-turn shows the adapter's last stderr lines.

3. Check whether the host is still alive.

```bash
kill -0 "$(cat <state>/agents/<agentId>/host.pid)" && echo alive
```

A host that is alive while the agent reads `stopped` means the server could not reach its socket; a Dispatch restart reattaches. A dead host with a live agent row is what reconcile corrects on its next tick.

4. Pull macOS unified logs around the incident window if the host itself was killed.

```bash
log show --style compact --start "<start>" --end "<end>" --predicate '(process == "launchd") || (eventMessage CONTAINS[c] "dev.dispatch.server") || (eventMessage CONTAINS[c] "SIGKILL") || (eventMessage CONTAINS[c] "logout")'
```

Hosts run in their own process group, so a Dispatch restart never takes them down; a user logout or a same-user automation that kills process trees will.

## Bin Scripts

| Script                    | Description                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `bin/install-dispatch.sh` | First-time artifact install for macOS and Linux; writes the fixed runtime and service definition   |
| `bin/dispatch-dev`        | Dev environment manager (isolated Docker Postgres + API server + Vite frontend)                    |
| `bin/dispatch-stream`     | Agent-side CLI for managing browser streams (`start --playwright <port>` / `stop "<description>"`) |
| `bin/install-dispatch.sh` | Fresh artifact-only installer for macOS and Linux                                                  |
| `bin/pack-release`        | Packs `dispatch-server.tar.gz` from pre-built Bun binaries; used by the release workflow           |

## File Locations

| Path                                               | Description                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `<state>/server/`                                  | Server checkout (deploy target)                                            |
| `<state>/server/.env`                              | Server environment config                                                  |
| `<state>/server/dist/bun/`                         | Compiled Bun binaries the wrapper execs                                    |
| `<state>/release.json`                             | Currently deployed tag + `deployedAt` timestamp                            |
| `<state>/release-candidate.json`                   | Just-activated release awaiting a healthy boot                             |
| `<state>/cache/release-<tag>.tar.gz`               | Cached pre-built release artifacts keyed by tag                            |
| `<state>/logs/dispatch.log`                        | Live server log (rotated via copy-truncate at 10 MB; backups kept 14 days) |
| `<state>/agents/<agentId>/`                        | Per-agent host state: launch file, socket, pid, journal, host log          |
| `~/Library/LaunchAgents/dev.dispatch.server.plist` | launchd service definition (points at the fixed runtime)                   |
