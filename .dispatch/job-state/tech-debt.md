# Tech Debt State

## last_audited_sha

a89adf2118e76d05df41c04329862cf1a6477665

## next_focus

**Consolidate `errorMessage` usage in `diagnostics.ts` and `agents/manager.ts`**

- `apps/server/src/diagnostics.ts:31` has a local `const errorMessage` arrow function that duplicates the shared `errorMessage` in `shared/lib/error-message.ts`.
- `apps/server/src/agents/manager.ts:1697` has a `private errorMessage()` method that does the same thing.
- **Action**: Import `errorMessage` from `../shared/lib/error-message.js` in both files, remove the local definitions, and update all call sites (1 in diagnostics, 3 in manager — the manager ones use `this.errorMessage()` so the call sites need the `this.` prefix removed). Run `pnpm run check` and `pnpm run test:e2e`.

## backlog

1. **Large file: `apps/web/src/components/app/jobs-pane.tsx` (2489 lines)**. Largest component file. Look for extractable sub-components (job detail panels, form sections, list items).

2. **Large file: `apps/server/src/shared/mcp/server.ts` (2101 lines)**. MCP server implementation. Check if tool handler registration can be split into separate modules.

3. **Large file: `apps/web/src/components/app/automations-pane.tsx` (2029 lines)**. Similar to jobs-pane — likely has extractable sub-components.

4. **Large file: `apps/server/src/agents/manager.ts` (1736 lines)**. Agent manager — check for functions that can be extracted to dedicated files.

5. **`as unknown as WebSocket` cast in `apps/server/src/stream-manager.ts:52`**. Investigate whether proper typing is feasible.

6. **`ide-settings.ts` and `agent-type-settings.ts` share a near-identical pattern**: type guard, sanitize function, get/set with JSON parse. Consider a generic settings-value helper if a third instance appears (monitor, don't act yet).

7. **Duplicate `resolveTilde` functions in route files**. `apps/server/src/routes/jobs.ts:46` and `apps/server/src/routes/templates.ts:61` have byte-identical `resolveTilde` implementations. Extract to `shared/lib/` or a routes helper.

## patterns

- **Copy-paste between `shared/` and `routes/`**: The `sanitizeUploadedFileName` duplication (fixed in run 2) and the `resolveTilde` duplication (discovered in run 4) confirm that utilities sometimes get re-implemented locally instead of imported from `shared/`. Watch for this pattern when auditing routes.
- **Route files accumulate boilerplate**: Routes that use Zod validation + try/catch tend to grow identical error-handling blocks. The `errorMessage` helper (added in run 4) now exists to prevent this from recurring.
- **Large component files**: The top 5 web components are all 1100-2500 lines. These are feature-dense panes (jobs, automations, docs, feedback, create-agent). Extraction is valuable but moderate-risk since they may have tightly coupled state.
- **Unused dependencies can linger**: `@formkit/auto-animate` was listed in `package.json` for an indeterminate period with zero imports. Worth periodically re-scanning with `pnpm why` or import grep.
- **Private method duplication in large classes**: `manager.ts` has `private errorMessage()` that duplicates shared logic. Large classes are prone to re-implementing utilities as private methods instead of importing shared helpers.

## history

- 2026-05-13: Bootstrap audit — scanned for dead code, type gaps, duplicated logic, complexity hotspots, unused dependencies, and inconsistent patterns. Created initial backlog with 8 items. No code changes.
- 2026-05-14: Removed duplicated `sanitizeUploadedFileName` from `apps/server/src/routes/agent-startup.ts` — was byte-identical to the canonical copy in `apps/server/src/shared/media.ts`. Replaced with import. PR #534.
- 2026-05-14: Removed unused `@formkit/auto-animate` dependency from `apps/web/package.json`. Zero imports existed anywhere in `apps/web/src/`. PR #535.
- 2026-05-15: Extracted shared `errorMessage()` utility to `shared/lib/error-message.ts`. Replaced 12 inline `error instanceof Error ? error.message : String(error)` expressions across `routes/jobs.ts` (8) and `routes/templates.ts` (4).
