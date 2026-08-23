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

## MCP Tool Names

An agent fetches `tools/list` once, at session start, and a shipped plugin skill
can name a tool from a copy installed months ago. Renaming a tool is therefore a
client-compatibility change, not a refactor.

1. Rename in place and keep `tools/list` advertising only the new name — a
   deprecated duplicate costs every agent context and splits the model's choice.
2. Add the old name to `LEGACY_TOOL_ALIASES` in
   `apps/server/src/shared/mcp/server.ts`, with its `lastVersionWithOldName` and
   a `reviewAfter` date. Inbound `tools/call` requests are rewritten, so live
   sessions and stale plugin copies keep working.
3. Update every place the name is written by hand in the same PR: the per-agent
   allowlists, `BUILTIN_TOOL_NAMES`, the injected launch guidance in
   `apps/server/src/agents/tmux/command-builder.ts`, `CLAUDE.md`/`AGENTS.md`,
   `README.md`, the web docs sections, and the shipped plugin skills.
4. Bump the plugin version in both `plugins/dispatch/.claude-plugin/plugin.json`
   and `plugins/dispatch/.codex-plugin/plugin.json` when a skill body changes —
   installed copies only update when that version moves.
5. **Rollback is not symmetric.** The alias only covers old name → new. After a
   release that advertises the new name, reverting to the previous artifact
   leaves running agents calling a name that server does not register. Restart
   affected agent sessions after a rollback so they refetch `tools/list`, or
   roll forward instead.

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
   - `node apps/server/dist/main.js`
2. Confirm tmux restart path works:
   - `bin/dispatch-server update`
3. Confirm health endpoint remains stable:
   - `curl -sS http://127.0.0.1:6767/api/v1/health`

## Review Gate (Before Merge)

1. Can current UI/client behavior continue to function without code changes?
2. Are migrations safe if the process restarts between deploy steps?
3. Is there any endpoint/field removal? If yes, has deprecation/migration been documented?
4. Has the deploy path been exercised with `bin/dispatch-server update`?
