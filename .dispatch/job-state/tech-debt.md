# Tech Debt State

## last_audited_sha

47160c61539438532327e5bdac30e86814e8686d

## next_focus

**Duplicate `resolveTilde` functions in route files**

- `apps/server/src/routes/jobs.ts` and `apps/server/src/routes/templates.ts` both have byte-identical `resolveTilde` implementations that expand `~` to `os.homedir()`.
- **Action**: Extract `resolveTilde` to `apps/server/src/shared/lib/resolve-tilde.ts`, export it, and replace the local definitions in both route files with imports. Run `pnpm run check`, `pnpm run test`, and `pnpm run test:e2e`.

## backlog

1. **Large file: `apps/web/src/components/app/jobs-pane.tsx` (2489 lines)**. Largest component file. Look for extractable sub-components (job detail panels, form sections, list items).

2. **Large file: `apps/server/src/shared/mcp/server.ts` (2101 lines)**. MCP server implementation. Check if tool handler registration can be split into separate modules.

3. **Large file: `apps/web/src/components/app/automations-pane.tsx` (2029 lines)**. Similar to jobs-pane — likely has extractable sub-components.

4. **Large file: `apps/server/src/agents/manager.ts` (1733 lines)**. Agent manager — check for functions that can be extracted to dedicated files.

5. **`as unknown as WebSocket` cast in `apps/server/src/stream-manager.ts:52`**. Investigate whether proper typing is feasible.

6. **`ide-settings.ts` and `agent-type-settings.ts` share a near-identical pattern**: type guard, sanitize function, get/set with JSON parse. Consider a generic settings-value helper if a third instance appears (monitor, don't act yet).

## patterns

- **Copy-paste between `shared/` and `routes/`**: The `sanitizeUploadedFileName` duplication (fixed in run 2), the `resolveTilde` duplication (backlog), and now the `errorMessage` duplication (fixed in runs 4+5) confirm that utilities sometimes get re-implemented locally instead of imported from `shared/`. Watch for this pattern when auditing routes and large classes.
- **Private method duplication in large classes**: `manager.ts` had `private errorMessage()` duplicating shared logic (fixed this run). Large classes are prone to re-implementing utilities as private methods instead of importing shared helpers. Worth scanning other large classes for similar patterns.
- **Route files accumulate boilerplate**: Routes that use Zod validation + try/catch tend to grow identical error-handling blocks. The `errorMessage` helper (added in run 4) now exists to prevent this from recurring.
- **Large component files**: The top 5 web components are all 1100-2500 lines. These are feature-dense panes (jobs, automations, docs, feedback, create-agent). Extraction is valuable but moderate-risk since they may have tightly coupled state.
- **Unused dependencies can linger**: `@formkit/auto-animate` was listed in `package.json` for an indeterminate period with zero imports. Worth periodically re-scanning with `pnpm why` or import grep.

## history

- 2026-05-13: Bootstrap audit — scanned for dead code, type gaps, duplicated logic, complexity hotspots, unused dependencies, and inconsistent patterns. Created initial backlog with 8 items. No code changes.
- 2026-05-14: Removed duplicated `sanitizeUploadedFileName` from `apps/server/src/routes/agent-startup.ts` — was byte-identical to the canonical copy in `apps/server/src/shared/media.ts`. Replaced with import. PR #534.
- 2026-05-14: Removed unused `@formkit/auto-animate` dependency from `apps/web/package.json`. Zero imports existed anywhere in `apps/web/src/`. PR #535.
- 2026-05-15: Extracted shared `errorMessage()` utility to `shared/lib/error-message.ts`. Replaced 12 inline `error instanceof Error ? error.message : String(error)` expressions across `routes/jobs.ts` (8) and `routes/templates.ts` (4). PR #538.
- 2026-05-16: Consolidated duplicate `errorMessage` in `diagnostics.ts` (local arrow fn) and `agents/manager.ts` (private method) — replaced both with imports from `shared/lib/error-message.ts`. Updated 3 call sites in manager.ts and 1 in diagnostics.ts.
