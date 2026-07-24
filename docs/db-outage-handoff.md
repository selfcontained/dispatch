# Database outage self-healing handoff

## Implemented

- `StartupStateStore` models `initializing`, `database_unavailable`, and `ready`.
- Server startup now binds HTTP before database initialization and retries database setup in-process instead of exiting.
- `/api/v1/health` returns structured `503` status while the database is unavailable.
- Other API routes return a structured, retryable `503` response while unavailable; runtime Postgres connection failures also transition into recovery.
- The existing React app globally renders `StartupOutage` for health/API unavailability, including deep links. It returns to the original route once health is ready again.
- Tests cover state transitions, system health/API 503 handling, and React API availability handling.

## Important unresolved issue

The E2E server exits before binding. The blocker is the attempt to register
`@fastify/cookie` before the database-derived cookie secret is available:
`deferredCookieSigner` is an object, but Fastify expects its `secret` option to
be a string or string array. Do not replace it with a generated placeholder:
that would invalidate persisted session signing across restarts.

Resolve this by separating the DB-independent HTTP shell from the cookie/auth
route registration, or by adding a supported lazy cookie-secret integration.
The service must keep serving the existing React index while DB-backed APIs
remain gated with 503 responses.

## Validation completed

- `pnpm run check` passed.
- `pnpm run finalize:web` passed.
- `pnpm run test` passed.
- Focused server outage tests passed (69 tests).
- `pnpm run test:e2e` currently fails at web-server startup for the cookie
  registration issue above.

## Relevant files

- `apps/server/src/server.ts`
- `apps/server/src/server/startup-state.ts`
- `apps/server/src/routes/system.ts`
- `apps/web/src/router-layouts.tsx`
- `apps/web/src/hooks/use-health.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/components/app/startup-outage.tsx`
