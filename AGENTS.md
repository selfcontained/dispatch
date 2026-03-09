# AGENTS Instructions

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

## Web Finalization
- If any files under `web/` changed, run `npm run finalize:web` before marking the task complete.
- After running `npm run finalize:web`, verify the served app once (not only Vite dev server) when the task affects UI/theme/rendering behavior.

## Vite Dev Server
- For frontend development/validation, run the Vite dev server (`npm --prefix web run dev`) instead of the backend static server.
- Do not pin a fixed Vite port unless explicitly requested; let Vite choose an open port automatically.
- If multiple local Dispatch instances are running, always use the exact URL printed by the active Vite process for Playwright/manual checks.

## Backend Testing Safety
- Treat `127.0.0.1:8787` as production by default; do not stop or kill the existing production server for ad-hoc testing.
- When backend changes need local validation, run a separate backend instance on a different port (for example `DISPATCH_PORT=8788 npm run dev`) and point validation tooling to that port.
- Only operate on production (`:8787`) when explicitly requested by the user.
