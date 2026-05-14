# Tech Debt State

## last_audited_sha

aae60d5f774176d0e594956a5995f8ace5fb1ba8

## next_focus

**Repeated error-handling boilerplate in route files**

- `apps/server/src/routes/jobs.ts` repeats the pattern `const message = error instanceof Error ? error.message : String(error); return reply.code(500).send({ error: message });` 8 times across ~176 lines.
- The same pattern appears 2x in `routes/personalities.ts` and 4x in `routes/templates.ts`.
- **Action**: Extract a small `sendError(reply, error, code?)` helper local to the routes directory (e.g., `routes/helpers.ts` or inline in each file). Replace all instances. Run `pnpm run check` and `pnpm run test` to verify.

## backlog

1. **Large file: `apps/web/src/components/app/jobs-pane.tsx` (2489 lines)**. Largest component file. Look for extractable sub-components (job detail panels, form sections, list items).

2. **Large file: `apps/server/src/shared/mcp/server.ts` (2101 lines)**. MCP server implementation. Check if tool handler registration can be split into separate modules.

3. **Large file: `apps/web/src/components/app/automations-pane.tsx` (2029 lines)**. Similar to jobs-pane — likely has extractable sub-components.

4. **Large file: `apps/server/src/agents/manager.ts` (1736 lines)**. Agent manager — check for functions that can be extracted to dedicated files.

5. **`as unknown as WebSocket` cast in `apps/server/src/stream-manager.ts:52`**. Investigate whether proper typing is feasible.

6. **`ide-settings.ts` and `agent-type-settings.ts` share a near-identical pattern**: type guard, sanitize function, get/set with JSON parse. Consider a generic settings-value helper if a third instance appears (monitor, don't act yet).

7. **Flaky E2E test: `worktree.spec.ts:87` ("create dialog shows worktree checkbox defaulting to checked")**. Times out waiting for "Git repository" text after filling CWD. May need a longer timeout or a more stable selector. Observed on 2026-05-14.

## patterns

- **Copy-paste between `shared/` and `routes/`**: The `sanitizeUploadedFileName` duplication (fixed in run 2) confirmed that utilities sometimes get re-implemented locally instead of imported from `shared/`. Watch for this pattern when auditing routes.
- **Route files accumulate boilerplate**: `routes/jobs.ts` has 8 identical try/catch blocks. Routes that use Zod validation + try/catch tend to grow this way because each endpoint handler is self-contained.
- **Large component files**: The top 5 web components are all 1100-2500 lines. These are feature-dense panes (jobs, automations, docs, feedback, create-agent). Extraction is valuable but moderate-risk since they may have tightly coupled state.
- **Unused dependencies can linger**: `@formkit/auto-animate` was listed in `package.json` for an indeterminate period with zero imports. Worth periodically re-scanning with `pnpm why` or import grep.

## history

- 2026-05-13: Bootstrap audit — scanned for dead code, type gaps, duplicated logic, complexity hotspots, unused dependencies, and inconsistent patterns. Created initial backlog with 8 items. No code changes.
- 2026-05-14: Removed duplicated `sanitizeUploadedFileName` from `apps/server/src/routes/agent-startup.ts` — was byte-identical to the canonical copy in `apps/server/src/shared/media.ts`. Replaced with import. PR #534.
- 2026-05-14: Removed unused `@formkit/auto-animate` dependency from `apps/web/package.json`. Zero imports existed anywhere in `apps/web/src/`.
