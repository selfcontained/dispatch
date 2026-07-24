# Database outage self-healing — resolved

## Implemented

- `StartupStateStore` models `initializing`, `database_unavailable`, and `ready`.
- Server startup binds HTTP before database initialization and retries database
  setup in-process (capped exponential backoff) instead of exiting.
- `/api/v1/health` returns a structured `503` while the database is unavailable;
  all other `/api/` routes return one consistent, retryable `503`. Runtime
  Postgres connection failures also transition back into recovery.
- The React app renders `StartupOutage` while the API reports the database
  unavailable and returns to the original route once health is ready again. The
  outage screen only renders on a confirmed outage, never during the initial
  health check.
- Cookie signing uses a deferred signer so the HTTP shell can register before
  the persisted cookie secret is readable; the secret is loaded during database
  initialization, preserving session signing across restarts.

## Resolution of the earlier E2E blocker

A previous handoff blamed `@fastify/cookie` rejecting the deferred signer
object. That diagnosis was wrong — `@fastify/cookie` v11 supports signer
objects. The actual failure: `registerBrowserExtensionRoutes()` awaited
`cleanupBrowserExtensionData()` (a DB sweep) at route-registration time, which
now runs before the database is available. With the DB down the rejection
propagated out of `registerRoutes()` and the process exited before binding.
Fixed by making the initial sweep fire-and-forget with a logged warning — the
recurring cleanup interval already retries.

`playwright.config.ts` keeps `webServer.url` at `/api/v1/health`: Playwright
requires a 2xx/3xx for readiness and health 503s until migrations finish, so it
doubles as a full-readiness gate for the test run.
