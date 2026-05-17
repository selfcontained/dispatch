# Tech Debt State

## last_audited_sha

e9e43bc1755434a18eae24cf47fff1d927268df1

## next_focus

**`as unknown as WebSocket` cast in `apps/server/src/stream-manager.ts:52`**

- There's an unsafe `as unknown as WebSocket` cast around line 52 in `stream-manager.ts`.
- **Action**: Investigate whether the underlying Fastify WebSocket type can be used directly or if a narrower interface type would eliminate the double cast. Check what methods/properties are actually used and define a minimal interface if the full WebSocket type doesn't align. Run `pnpm run check` and `pnpm run test:e2e` after any change.

## backlog

1. **Large file: `apps/server/src/shared/mcp/server.ts` (2101 lines)**. MCP server implementation. Check if tool handler registration can be split into separate modules.

2. **Large file: `apps/server/src/agents/manager.ts` (1733 lines)**. Agent manager — check for functions that can be extracted to dedicated files.

3. **`ide-settings.ts` and `agent-type-settings.ts` share a near-identical pattern**: type guard, sanitize function, get/set with JSON parse. Consider a generic settings-value helper if a third instance appears (monitor, don't act yet).

4. **Re-scan route files for new utility duplication**. The `resolveTilde`, `sanitizeUploadedFileName`, and `errorMessage` patterns were all found in routes. Worth a fresh grep for other copy-pasted helpers, especially in newer route files.

## patterns

- **Copy-paste between `shared/` and `routes/`**: The `sanitizeUploadedFileName` duplication (fixed in run 2), the `resolveTilde` duplication (fixed this run), and the `errorMessage` duplication (fixed in runs 4+5) confirm that utilities sometimes get re-implemented locally instead of imported from `shared/`. Watch for this pattern when auditing routes and large classes.
- **Private method duplication in large classes**: `manager.ts` had `private errorMessage()` duplicating shared logic (fixed in run 5). Large classes are prone to re-implementing utilities as private methods instead of importing shared helpers. Worth scanning other large classes for similar patterns.
- **Route files accumulate boilerplate**: Routes that use Zod validation + try/catch tend to grow identical error-handling blocks. The `errorMessage` helper (added in run 4) now exists to prevent this from recurring.
- **Large component files**: The top web components were 1100-2500 lines. The componentizer job has been extracting these (jobs-pane in PR #546, automations-pane in PR #547). Monitor whether more are needed.
- **Unused dependencies can linger**: `@formkit/auto-animate` was listed in `package.json` for an indeterminate period with zero imports. Worth periodically re-scanning with `pnpm why` or import grep.
- **Three-way duplication across route files**: `resolveTilde` appeared in jobs.ts, templates.ts, AND system.ts (under the name `resolveTildePath`). When hunting duplicates, check all route files — not just the obvious pair.

## history

- 2026-05-13: Bootstrap audit — scanned for dead code, type gaps, duplicated logic, complexity hotspots, unused dependencies, and inconsistent patterns. Created initial backlog with 8 items. No code changes.
- 2026-05-14: Removed duplicated `sanitizeUploadedFileName` from `apps/server/src/routes/agent-startup.ts` — was byte-identical to the canonical copy in `apps/server/src/shared/media.ts`. Replaced with import. PR #534.
- 2026-05-14: Removed unused `@formkit/auto-animate` dependency from `apps/web/package.json`. Zero imports existed anywhere in `apps/web/src/`. PR #535.
- 2026-05-15: Extracted shared `errorMessage()` utility to `shared/lib/error-message.ts`. Replaced 12 inline `error instanceof Error ? error.message : String(error)` expressions across `routes/jobs.ts` (8) and `routes/templates.ts` (4). PR #538.
- 2026-05-16: Consolidated duplicate `errorMessage` in `diagnostics.ts` (local arrow fn) and `agents/manager.ts` (private method) — replaced both with imports from `shared/lib/error-message.ts`. Updated 3 call sites in manager.ts and 1 in diagnostics.ts.
- 2026-05-17: Extracted `resolveTilde` to `shared/lib/resolve-tilde.ts`. Replaced 3 identical implementations: `routes/jobs.ts`, `routes/templates.ts`, and `routes/system.ts` (was named `resolveTildePath`).
