# Operations Runbook

This runbook is for running Dispatch reliably across agent/session boundaries and host restarts.

## Operating Policy

Default mode for this repo is a single backend managed by `tmux`.

- Use `bin/dispatch-server` for normal app usage and release updates.
- launchd support is removed from this repo.

## Prerequisites

1. From project root: `/Users/bharris/dev/apps/dispatch`
2. Ensure dependencies are installed:
   - `npm install`
3. Ensure Postgres is running:
   - `docker compose up -d postgres`

## Standard Agent Operations

Use the helper script:

- Start server (production mode in tmux): `bin/dispatch-server start`
- Stop server: `bin/dispatch-server stop`
- Restart server: `bin/dispatch-server restart`
- Check status and health: `bin/dispatch-server status`
- Tail recent logs from tmux session: `bin/dispatch-server logs`
- Attach to running tmux session: `bin/dispatch-server attach`
- Fresh build only: `bin/dispatch-server build`
- Fresh build + restart + health check: `bin/dispatch-server update`

Notes:
- Session name is fixed to `dispatch-server`.
- `start` runs `npm run start` with Node resolved via `.nvmrc`.
- Health endpoint checked by helpers: `http://127.0.0.1:8787/api/v1/health`

## Recommended Update Flow

For routine updates:

1. `git pull`
2. `npm install`
3. `bin/dispatch-server update`

## Development Workflow with Single Backend

1. Make backend changes.
2. Deploy to the canonical backend:
   - `bin/dispatch-server update`
3. Use the app normally against that same backend instance.

## Git Context Refresh Diagnostics

Dispatch now serves git metadata from DB cache and refreshes it in a background worker.

- Diagnostics endpoint: `GET /api/v1/diagnostics/git-context`
- Local URL: `http://127.0.0.1:8787/api/v1/diagnostics/git-context`

Quick checks:

1. `curl -s http://127.0.0.1:8787/api/v1/diagnostics/git-context | jq '.queue'`
2. `curl -s http://127.0.0.1:8787/api/v1/diagnostics/git-context | jq '.counters'`
3. `curl -s http://127.0.0.1:8787/api/v1/diagnostics/git-context | jq '.durationsMs'`
4. `curl -s http://127.0.0.1:8787/api/v1/diagnostics/git-context | jq '.agents[] | select(.pending or .active or .lastResult==\"failed\" or .lastResult==\"probe_error\")'`

What to look for:

- `queue.pending` consistently above `0` and increasing: refresh loop is falling behind.
- `queue.oldestPendingAgeMs` steadily increasing: queue starvation/backlog.
- `counters.timedOut` increasing quickly: git/tmux probes are timing out.
- many agents with `lastResult` of `probe_error` or `failed`: metadata may be stale.
