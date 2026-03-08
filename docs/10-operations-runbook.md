# Operations Runbook

This runbook is for running Dispatch reliably across agent/session boundaries and host restarts.

## Operating Policy

Default mode for this repo is a single backend managed by launchd.

- Use `launchd` for normal app usage and backend stress testing.
- Use `tmux` mode only for short-lived interactive debugging.
- Return to `launchd` mode after debugging to keep one canonical backend instance.

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
- Do not run tmux mode and launchd mode at the same time (both will try to bind port `8787`).

## Auto-Start on Login/Reboot (launchd)

Install:

1. Build once before enabling launchd:
   - `bin/dispatch-server build`
2. Install + load launchd job:
   - `bin/install-launchd`

Notes:
- Installer captures the current `codex` binary path into `DISPATCH_CODEX_BIN` for launchd.
- Re-run `bin/install-launchd` after changing where `codex` is installed.

Uninstall:

- `bin/uninstall-launchd`

Start/stop/restart when launchd is installed:

- Start now: `launchctl kickstart -k gui/$(id -u)/local.dispatch.server`
- Stop now: `launchctl stop local.dispatch.server`
- Restart now: `launchctl kickstart -k gui/$(id -u)/local.dispatch.server`

Inspect:

- Job label: `local.dispatch.server`
- Plist path: `~/Library/LaunchAgents/local.dispatch.server.plist`
- launchd logs:
  - `/tmp/dispatch-launchd.out.log`
  - `/tmp/dispatch-launchd.err.log`
- Check launchctl state:
  - `launchctl print gui/$(id -u)/local.dispatch.server`

## Recommended Update Flow

For routine updates:

1. `git pull`
2. `npm install`
3. `bin/dispatch-deploy`

For launchd-managed hosts:

1. `git pull`
2. `npm install`
3. `bin/dispatch-deploy`

## Development Workflow with Single Backend

1. Make backend changes.
2. Deploy to the canonical backend:
   - `bin/dispatch-deploy`
3. Use the app normally against that same backend instance.
4. For debugging only (optional):
   - `launchctl stop local.dispatch.server`
   - use `bin/dispatch-server start` and `bin/dispatch-server logs|attach`
   - when done, stop tmux server and restore launchd:
     - `bin/dispatch-server stop`
     - `launchctl kickstart -k gui/$(id -u)/local.dispatch.server`
