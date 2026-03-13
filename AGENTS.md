# AGENTS Instructions

<!-- Keep behavioral rules in sync with CLAUDE.md (used by Claude Code agents). -->

## CRITICAL: Dispatch Status Events (Mandatory)
- You MUST call `dispatch-event` for every task turn that involves analysis, tool use, or file changes.
- Required checkpoints:
  1. First action in the turn:
     `dispatch-event working "<what you are starting>"`
  2. If blocked by error/tool/env:
     `dispatch-event blocked "<concise reason>"`
  3. If waiting for user input/decision:
     `dispatch-event waiting_user "<what is needed>"`
  4. Final action before final response:
     - Success: `dispatch-event done "<what was completed>"`
     - No-op/informational turn: `dispatch-event idle "<why no actions were taken>"`
- Hard requirements:
  - Do not send a final response unless `done`, `waiting_user`, `blocked`, or `idle` has been emitted in the same turn.
  - If `dispatch-event` fails, report that failure explicitly in the response.
  - Include a `Status log` section in the final response with the exact stdout lines from each `dispatch-event` call.

## UI Validation
- For any UI/layout/style interaction change, validate behavior in Playwright before marking the task complete.
- Include at least one Playwright interaction that covers the changed UI path (for example: open/close panes, modal flow, or action button state changes).
- For pages with SSE/WebSocket activity, do not use Playwright `waitUntil: "networkidle"` for readiness checks.
- Use `waitUntil: "domcontentloaded"` (or `"load"`) and wait for concrete UI-ready signals (visible control/text/state) instead.

## Component Preference
- Prefer shadcn/ui components over hand-rolled UI when an equivalent shadcn option exists.
- Only hand-roll when there is no suitable shadcn primitive or composition path.

## Pre-Completion Checks (Mandatory)
Before marking any task as done, run the following checks and fix any failures:
1. **Type checking**: `npm run check` (runs `tsc --noEmit` for backend + web).
2. **Web finalization**: If any files under `web/` changed, run `npm run finalize:web` (type check + production build).
3. **E2E tests**: `npm run test:e2e` (Playwright). Always spins up its own isolated DB and server — safe to run alongside other agents.
4. **Unit tests**: `npm test` (Vitest) if backend logic changed.
- Do not consider a task complete until all applicable checks pass.
- If a pre-existing test is flaky (fails before your changes too), note it in your response but do not skip the rest of the suite.

## Web Finalization
- If any files under `web/` changed, run `npm run finalize:web` before marking the task complete.
- After running `npm run finalize:web`, verify the served app via an explicitly started local dev stack when the task affects UI/theme/rendering behavior.
- After UI/theme/rendering validation on an isolated dev stack, leave that stack running for the user to inspect unless they explicitly ask you to tear it down.
- In the final response, include the exact local URLs/ports for the running validation stack and the cleanup command(s) needed to stop it later.

## Temporary Files
- Never write temporary files (screenshots, test scripts, scratch files) to the repo root.
- Use `/tmp/` or `$DISPATCH_MEDIA_DIR` for ephemeral files.
- Playwright screenshots should be published via `dispatch-share`, not saved locally.

## Dev Server Management (CRITICAL)
- **NEVER use `pkill`, `killall`, or `lsof | xargs kill`** to manage dev servers — these can kill your own agent process.
- Use an isolated Postgres instance for dev work. Pick a unique suffix and ports for your agent before starting anything.
  ```bash
  export DISPATCH_DEV_SUFFIX="<unique-suffix>"
  export DISPATCH_DEV_DB_PORT="<free-db-port>"
  export DISPATCH_DEV_API_PORT="<free-api-port>"
  export DISPATCH_DEV_WEB_PORT="<free-web-port>"

  DISPATCH_DB_NAME="$DISPATCH_DEV_SUFFIX" DISPATCH_DB_PORT="$DISPATCH_DEV_DB_PORT" docker compose up -d postgres
  DATABASE_URL="postgres://dispatch:dispatch@127.0.0.1:${DISPATCH_DEV_DB_PORT}/dispatch_${DISPATCH_DEV_SUFFIX}" DISPATCH_PORT="$DISPATCH_DEV_API_PORT" npm run dev
  npm --prefix web run dev -- --port "$DISPATCH_DEV_WEB_PORT"
  ```
- If you need background services, start them deliberately and capture logs in `/tmp/`. Do not rely on wrappers to clean them up.
- If the stack was started for user-facing validation, do not stop it automatically at the end of the turn unless the user explicitly asks. Otherwise, stop services explicitly when you are done. Prefer targeted `docker compose stop/down` and tracked process IDs over broad kill commands.

## Backend Testing Safety
- Treat `127.0.0.1:6767` as production by default; do not stop or kill the existing production server for ad-hoc testing.
- When backend changes need local validation, start an isolated local stack explicitly and point validation tooling to those ports.
- Only operate on production (`:6767`) when explicitly requested by the user.

## Development Database
- Production uses the `dispatch` database. Never connect to it from dev servers.
- For dev servers, set `DISPATCH_DB_NAME` and `DISPATCH_DB_PORT` explicitly so your Postgres container and `DATABASE_URL` are isolated from other agents.
- Migrations run automatically on API server start.
