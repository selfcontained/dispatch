# AGENTS Instructions

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
