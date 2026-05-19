# Tech Debt State

## last_audited_sha

df872f88146010ef9614fd95b98b31ac5e5bc5c0

## next_focus

**Extract analytics tools from `apps/server/src/shared/mcp/server.ts` (1861 lines)**

- The summary/analytics tool group (`get_activity_summary`, `get_agent_history`, `get_feedback_summary`) at lines ~1272-1482 shares a common date-range parsing pattern and callback resolution pattern. Extract into `analytics-tools.ts` following the same pattern as the job tools extraction.
- **Action**: Create `apps/server/src/shared/mcp/analytics-tools.ts`. Move the three analytics tool registrations and their shared date-range parsing logic into a `registerAnalyticsTools(server, context)` function. Import and call from `createDispatchMcpServer`. Run `pnpm run check` and `pnpm run test:e2e` after.

## backlog

1. **Extract persona/review tools from `server.ts`** (~lines 492-712, ~220 lines). The persona tools (`review_status`, `dispatch_complete_review`, `get_parent_context`, `dispatch_get_recheck_context`, `dispatch_cancel_recheck`) form a cohesive group. Extract to `persona-tools.ts` following the same pattern.

2. **Large file: `apps/server/src/agents/manager.ts` (1733 lines)**. Agent manager -- check for functions that can be extracted to dedicated files.

3. **`ide-settings.ts` and `agent-type-settings.ts` share a near-identical pattern**: type guard, sanitize function, get/set with JSON parse. Consider a generic settings-value helper if a third instance appears (monitor, don't act yet).

4. **Re-scan route files for new utility duplication**. The `resolveTilde`, `sanitizeUploadedFileName`, and `errorMessage` patterns were all found in routes. Worth a fresh grep for other copy-pasted helpers, especially in newer route files.

## patterns

- **Copy-paste between `shared/` and `routes/`**: The `sanitizeUploadedFileName` duplication (fixed in run 2), the `resolveTilde` duplication (fixed in run 6), and the `errorMessage` duplication (fixed in runs 4+5) confirm that utilities sometimes get re-implemented locally instead of imported from `shared/`. Watch for this pattern when auditing routes and large classes.
- **Private method duplication in large classes**: `manager.ts` had `private errorMessage()` duplicating shared logic (fixed in run 5). Large classes are prone to re-implementing utilities as private methods instead of importing shared helpers. Worth scanning other large classes for similar patterns.
- **Route files accumulate boilerplate**: Routes that use Zod validation + try/catch tend to grow identical error-handling blocks. The `errorMessage` helper (added in run 4) now exists to prevent this from recurring.
- **Large component files**: The top web components were 1100-2500 lines. The componentizer job has been extracting these (jobs-pane in PR #546, automations-pane in PR #547, feedback-panel in PR #551). Monitor whether more are needed.
- **Unsafe casts for deferred initialization**: `stream-manager.ts` used `null as unknown as WebSocket` to initialize a field before the real value was available (fixed run 7). This pattern can appear anywhere a struct is built incrementally -- reorder initialization to assign the real value upfront.
- **Three-way duplication across route files**: `resolveTilde` appeared in jobs.ts, templates.ts, AND system.ts (under the name `resolveTildePath`). When hunting duplicates, check all route files -- not just the obvious pair.
- **Large MCP server file accumulates tool registrations**: `server.ts` was 2101 lines with all tool handlers inline. Extracting domain-grouped tool registrations into separate modules (e.g., `job-tools.ts`) reduces the main file while keeping the registration pattern identical. Continue extracting analytics and persona tool groups.

## history

- 2026-05-13: Bootstrap audit -- scanned for dead code, type gaps, duplicated logic, complexity hotspots, unused dependencies, and inconsistent patterns. Created initial backlog with 8 items. No code changes.
- 2026-05-14: Removed duplicated `sanitizeUploadedFileName` from `apps/server/src/routes/agent-startup.ts` -- was byte-identical to the canonical copy in `apps/server/src/shared/media.ts`. Replaced with import. PR #534.
- 2026-05-14: Removed unused `@formkit/auto-animate` dependency from `apps/web/package.json`. Zero imports existed anywhere in `apps/web/src/`. PR #535.
- 2026-05-15: Extracted shared `errorMessage()` utility to `shared/lib/error-message.ts`. Replaced 12 inline `error instanceof Error ? error.message : String(error)` expressions across `routes/jobs.ts` (8) and `routes/templates.ts` (4). PR #538.
- 2026-05-16: Consolidated duplicate `errorMessage` in `diagnostics.ts` (local arrow fn) and `agents/manager.ts` (private method) -- replaced both with imports from `shared/lib/error-message.ts`. Updated 3 call sites in manager.ts and 1 in diagnostics.ts.
- 2026-05-17: Extracted `resolveTilde` to `shared/lib/resolve-tilde.ts`. Replaced 3 identical implementations: `routes/jobs.ts`, `routes/templates.ts`, and `routes/system.ts` (was named `resolveTildePath`).
- 2026-05-18: Eliminated unsafe `null as unknown as WebSocket` cast in `stream-manager.ts:52`. Reordered initialization to create the WebSocket before the session object, so the real value is assigned directly.
- 2026-05-19: Extracted job tool registrations (7 tools, ~240 lines) from `shared/mcp/server.ts` into `shared/mcp/job-tools.ts`. Reduced server.ts from 2101 to 1861 lines. Exported `toToolError` as shared helper.
