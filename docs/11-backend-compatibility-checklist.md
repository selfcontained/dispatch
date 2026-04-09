# Backend Compatibility Checklist

Use this checklist for backend changes when running a single always-on tmux backend.

## API Compatibility

1. Prefer additive changes:
   - add new response fields instead of renaming/removing existing fields
   - add new endpoints before deprecating old endpoints
2. Keep existing endpoint shapes stable:
   - preserve field names and meaning
   - preserve status code behavior unless versioned/migrated
3. If a breaking change is unavoidable:
   - gate with a feature flag or compatibility branch path
   - document migration steps in the same PR

## Database Migrations

1. Use expand-contract sequence:
   - expand: add nullable columns/tables/indexes first
   - deploy app reading old + new schema
   - contract: remove old fields in a later change
2. Ensure migrations are restart-safe and idempotent where possible.
3. Validate startup migration path on a non-empty database.

## Runtime and Ops

1. Confirm boot path works in production mode:
   - `pnpm run build`
   - `node apps/server/dist/server.js`
2. Confirm tmux restart path works:
   - `bin/dispatch-server update`
3. Confirm health endpoint remains stable:
   - `curl -sS http://127.0.0.1:6767/api/v1/health`

## Review Gate (Before Merge)

1. Can current UI/client behavior continue to function without code changes?
2. Are migrations safe if the process restarts between deploy steps?
3. Is there any endpoint/field removal? If yes, has deprecation/migration been documented?
4. Has the deploy path been exercised with `bin/dispatch-server update`?
