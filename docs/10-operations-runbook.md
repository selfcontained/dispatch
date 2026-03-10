# Operations Runbook

This runbook is for running Dispatch reliably across agent/session boundaries and host restarts.

## Architecture Overview

Dispatch runs as a **launchd LaunchAgent** (`com.dispatch.server`) — a macOS-native service manager that:

- Starts automatically at login
- Restarts automatically if the process crashes
- Runs as the current user with full environment access
- Cannot be accidentally stopped by agents working in the repo

The server binary lives in a **separate checkout** at `~/.dispatch/server/` (independent from your working copy at `~/dev/apps/dispatch`). This means `git checkout`, deploys, and agent activity in the main repo never interfere with the running server.

**Postgres** runs in Docker (`dispatch-postgres`, port 5432).

**Server port**: 6767 (set via `DISPATCH_PORT` in `~/.dispatch/server/.env`).

## Service Management

```bash
# Check service status
launchctl list com.dispatch.server

# View live logs
tail -f ~/.dispatch/logs/dispatch.log

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.dispatch.server.plist

# Start the service
launchctl load ~/Library/LaunchAgents/com.dispatch.server.plist

# Restart the service
launchctl unload ~/Library/LaunchAgents/com.dispatch.server.plist
launchctl load ~/Library/LaunchAgents/com.dispatch.server.plist
```

## Database

Postgres runs via Docker Compose. Start/stop with:

```bash
docker compose up -d postgres     # start
docker compose stop postgres      # stop (data preserved)
docker compose down postgres      # stop + remove container (data preserved in volume)
```

Data is persisted in the `dispatch_pgdata` Docker volume.

## Release Pipeline

Releases are handled by `bin/dispatch-release`, which:

1. Verifies `main` branch is clean and up-to-date with origin
2. Triggers the `.github/workflows/release.yml` workflow via `gh` CLI
3. Blocks until the workflow completes (`gh run watch` — zero token cost)
4. On workflow success: captures the produced tag and calls `bin/dispatch-deploy <tag>`
5. On workflow failure: fetches failed-step logs and spawns a diagnosis agent inside Dispatch

```bash
# Cut a patch release (e.g. 1.2.3 → 1.2.4)
bin/dispatch-release patch

# Cut a minor release (e.g. 1.2.3 → 1.3.0)
bin/dispatch-release minor

# Cut a major release (e.g. 1.2.3 → 2.0.0)
bin/dispatch-release major
```

The **release workflow** (GitHub Actions):
- Runs type-check, lint, and build
- Bumps version in `package.json` and `web/package.json`
- Commits, creates a git tag, pushes, and publishes a GitHub Release
- Outputs the tag for downstream use

## Deploy (Specific Tag)

```bash
# Deploy a specific tag (also used for rollback)
bin/dispatch-deploy v1.2.3
```

`bin/dispatch-deploy` operates on `~/.dispatch/server/` and:
1. Records the current tag for rollback
2. Fetches and checks out the target tag
3. Installs deps, builds, restarts the launchd service
4. Polls `/api/v1/health` until the server responds (or times out)
5. On failure: writes a detailed log to `~/.dispatch/logs/last-release-failure.log`, attempts automatic rollback to the previous tag

## Rollback

```bash
# Roll back to a previously deployed tag
bin/dispatch-deploy v1.2.2
```

If a deploy fails mid-flight, `dispatch-deploy` attempts auto-rollback automatically. Check the failure log for details:

```bash
cat ~/.dispatch/logs/last-release-failure.log
```

The failure log includes: timestamp, failed step, rollback status, last 50 lines of the server log, and manual recovery commands.

## CI Pipeline

Every PR to `main` triggers `.github/workflows/ci.yml`:
- Type-check (`npm run check`)
- Lint (`npm run lint:web`)
- Build (`npm run build`)

PRs must pass CI before merge.

## Installation (First-Time Setup)

To install Dispatch as a launchd service on a new machine:

```bash
# Install on default port (8787)
bin/install-launchd

# Install on a custom port
bin/install-launchd --port 6767
```

This script:
1. Clones the repo to `~/.dispatch/server/`
2. Copies `.env` (or `.env.example`) as `~/.dispatch/server/.env`
3. Sets `DISPATCH_PORT` in the server `.env` if `--port` was specified
4. Installs dependencies and builds
5. Writes `~/Library/LaunchAgents/com.dispatch.server.plist` and loads it

After installation, edit `~/.dispatch/server/.env` to set `DATABASE_URL` and any API keys.

## Uninstall

```bash
bin/uninstall-launchd
```

Unloads and removes the plist. Does not remove `~/.dispatch/server/` or the Docker volume.

## Configuration

Server configuration lives in `~/.dispatch/server/.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `DISPATCH_PORT` | `8787` | HTTP port the server listens on |
| `DATABASE_URL` | `postgres://dispatch:dispatch@127.0.0.1:5432/dispatch` | Postgres connection string |
| `MEDIA_ROOT` | `/tmp/dispatch-media` | File upload storage path |
| `ANTHROPIC_API_KEY` | — | Required for Claude agents |

Changes to `.env` require a service restart to take effect.

## Diagnostics

Health check:

```bash
curl -s http://127.0.0.1:6767/api/v1/health | jq
```

Git context refresh diagnostics:

```bash
curl -s http://127.0.0.1:6767/api/v1/diagnostics/git-context | jq '.queue'
curl -s http://127.0.0.1:6767/api/v1/diagnostics/git-context | jq '.counters'
curl -s http://127.0.0.1:6767/api/v1/diagnostics/git-context | jq '.durationsMs'
curl -s http://127.0.0.1:6767/api/v1/diagnostics/git-context | jq '.agents[] | select(.pending or .active or .lastResult=="failed" or .lastResult=="probe_error")'
```

What to look for:

- `queue.pending` consistently above `0` and increasing: refresh loop is falling behind
- `queue.oldestPendingAgeMs` steadily increasing: queue starvation/backlog
- `counters.timedOut` increasing quickly: git probes are timing out
- Many agents with `lastResult` of `probe_error` or `failed`: metadata may be stale

## File Locations

| Path | Description |
|---|---|
| `~/.dispatch/server/` | Server checkout (deploy target) |
| `~/.dispatch/server/.env` | Server environment config |
| `~/.dispatch/logs/dispatch.log` | Live server log |
| `~/.dispatch/logs/last-release-failure.log` | Last deploy failure details |
| `~/Library/LaunchAgents/com.dispatch.server.plist` | launchd service definition |
