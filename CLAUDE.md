# Claude Code Instructions

<!-- Keep behavioral rules in sync with AGENTS.md (used by Codex agents). -->

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
- For any UI/layout/style/feature change, validate behavior in Playwright before marking the task complete.
- Include at least one Playwright interaction that covers the changed UI path (for example: open/close panes, modal flow, or action button state changes).
- Capture at least one screenshot per validation flow and publish it with `dispatch-share <image-path> "description"`. Never leave screenshots local-only.
- For pages with SSE/WebSocket activity, do not use Playwright `waitUntil: "networkidle"` for readiness checks.
- Use `waitUntil: "domcontentloaded"` (or `"load"`) and wait for concrete UI-ready signals (visible control/text/state) instead.

## Component Preference
- Prefer shadcn/ui components over hand-rolled UI when an equivalent shadcn option exists.
- Only hand-roll when there is no suitable shadcn primitive or composition path.

## Pre-Completion Checks (Mandatory)
Before marking any task as done, run the following checks and fix any failures:
1. **Type checking**: `npm run check` (runs `tsc --noEmit` for backend + web).
2. **Web finalization**: If any files under `web/` changed, run `npm run finalize:web` (type check + production build).
3. **E2E tests**: `npm run test:e2e` (Playwright). If a dev server is running via `dispatch-dev`, pass its port: `E2E_PORT=<port> npm run test:e2e`.
4. **Unit tests**: `npm test` (Vitest) if backend logic changed.
- Do not consider a task complete until all applicable checks pass.
- If a pre-existing test is flaky (fails before your changes too), note it in your response but do not skip the rest of the suite.

## Web Finalization
- If any files under `web/` changed, run `npm run finalize:web` before marking the task complete.
- After running `npm run finalize:web`, verify the served app via `dispatch-dev` when the task affects UI/theme/rendering behavior.

## Temporary Files
- Never write temporary files (screenshots, test scripts, scratch files) to the repo root.
- Use `/tmp/` or `$DISPATCH_MEDIA_DIR` for ephemeral files.
- Playwright screenshots should be published via `dispatch-share`, not saved locally.

## Dev Server Management (CRITICAL)
- **NEVER run `npm run dev` directly** in your terminal — it will block your session and killing it can kill your agent process.
- **NEVER use `pkill`, `killall`, or `lsof | xargs kill`** to manage dev servers — these can kill your own agent process.
- Use `dispatch-dev` to manage dev environments. It spins up an isolated DB, API server, and optionally Vite, all tied to your agent session. Everything is automatically cleaned up when your session ends.
  ```bash
  dispatch-dev up                             # start isolated DB + API server
  dispatch-dev up --vite                      # also start Vite frontend
  dispatch-dev up --cwd /path/to/worktree     # start from a specific directory
  dispatch-dev up --no-db                     # skip DB (use existing DATABASE_URL)
  dispatch-dev down                           # tear down everything
  dispatch-dev restart                        # restart the environment
  dispatch-dev status                         # check what's running
  dispatch-dev logs                           # API server logs
  dispatch-dev logs --vite                    # Vite server logs
  dispatch-dev url                            # print the API server URL
  ```
- `dispatch-dev up` auto-selects free ports and prints the URLs — just use the printed URLs.

## Backend Testing Safety
- Treat `127.0.0.1:6767` as production by default; do not stop or kill the existing production server for ad-hoc testing.
- When backend changes need local validation, use `dispatch-dev up` and point validation tooling to the printed URL.
- Only operate on production (`:6767`) when explicitly requested by the user.

## Development Database
- Production uses the `dispatch` database. Never connect to it from dev servers.
- `dispatch-dev up` creates an isolated Postgres container per agent with its own port — no manual DATABASE_URL setup needed.
- Migrations run automatically on API server start.
