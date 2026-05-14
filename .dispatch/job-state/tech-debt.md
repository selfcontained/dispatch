# Tech Debt State

## last_audited_sha

a045746b18c35c775745d9b1b28dcb09b450e07d

## next_focus

**Duplicated `sanitizeUploadedFileName` function**

- `apps/server/src/shared/media.ts:3` — the canonical, exported copy
- `apps/server/src/routes/agent-startup.ts:91` — a private copy with identical logic
- **Action**: Remove the duplicate in `agent-startup.ts` and import from `../shared/media.js`. Verify no behavior difference (they are byte-identical). Run `pnpm run check` and `pnpm run test` to confirm.

## backlog

1. **Unused dependency: `@formkit/auto-animate`** in `apps/web/package.json`. Zero imports anywhere in `apps/web/src/`. Remove it. Low risk.

2. **Repeated error-handling boilerplate in `apps/server/src/routes/jobs.ts`**. The pattern `const message = error instanceof Error ? error.message : String(error); return reply.code(500).send({ error: message });` appears 8 times in 176 lines. Extract a small `sendError(reply, error)` helper local to the file. Also appears 2x in `routes/personalities.ts` and 4x in `routes/templates.ts`.

3. **Large file: `apps/web/src/components/app/jobs-pane.tsx` (2489 lines)**. Largest component file. Look for extractable sub-components (job detail panels, form sections, list items).

4. **Large file: `apps/server/src/shared/mcp/server.ts` (2101 lines)**. MCP server implementation. Check if tool handler registration can be split into separate modules.

5. **Large file: `apps/web/src/components/app/automations-pane.tsx` (2029 lines)**. Similar to jobs-pane — likely has extractable sub-components.

6. **Large file: `apps/server/src/agents/manager.ts` (1736 lines)**. Agent manager — check for functions that can be extracted to dedicated files.

7. **`as unknown as WebSocket` cast in `apps/server/src/stream-manager.ts:52`**. Investigate whether proper typing is feasible.

8. **`ide-settings.ts` and `agent-type-settings.ts` share a near-identical pattern**: type guard, sanitize function, get/set with JSON parse. Consider a generic settings-value helper if a third instance appears (monitor, don't act yet).

## patterns

- **Copy-paste between `shared/` and `routes/`**: The `sanitizeUploadedFileName` duplication suggests utilities sometimes get re-implemented locally instead of imported from `shared/`. Watch for this pattern when auditing routes.
- **Route files accumulate boilerplate**: `routes/jobs.ts` has 8 identical try/catch blocks. Routes that use Zod validation + try/catch tend to grow this way because each endpoint handler is self-contained.
- **Large component files**: The top 5 web components are all 1100-2500 lines. These are feature-dense panes (jobs, automations, docs, feedback, create-agent). Extraction is valuable but moderate-risk since they may have tightly coupled state.
- **Unused shadcn scaffolding**: Several `ui/` components may have been scaffolded but never used. Worth auditing on a future run, but the grep was unreliable due to re-exports and aliasing — needs manual verification.

## history

- 2026-05-13: Bootstrap audit — scanned for dead code, type gaps, duplicated logic, complexity hotspots, unused dependencies, and inconsistent patterns. Created initial backlog with 8 items. No code changes.
