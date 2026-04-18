---
job: docs-audit
updated_at: 2026-04-17
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`01f477963d868123df7d412ff8dd0b33b7a45a82` — this is the HEAD that _preceded_ the PR which introduced this stateful flow. The PR that lands this file will advance the SHA; the next run should diff from wherever HEAD is when it reads the file, not from this literal value.

## next_focus

**Audit the `docs-pane.tsx` "Agents" section against the current agent-create + lifecycle code.**

Start here because agents are the central concept of Dispatch and the section is the most likely to be out of sync with reality. Specifically:

- `apps/web/src/components/app/docs-pane.tsx` — the "Agents" section (search for `id: "agents"`).
- Cross-check against:
  - `apps/server/src/agents/manager.ts` — agent states, setup phases, archive phases.
  - `apps/server/src/server.ts` — `POST /api/v1/agents`, start/stop/delete routes.
  - `apps/web/src/App.tsx` — create-agent dialog flow.
  - `docs/04-agent-lifecycle.md` — developer-facing lifecycle spec (not user-facing, but a useful source of truth).

Keep the PR to this one section plus anything the git diff since `last_audited_sha` demands.

## backlog

Items noticed during the bootstrap pass but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs-pane "Repo Tools" section** — verify the examples match `.dispatch/tools.json` schema in `packages/shared/src/mcp/repo-tools.ts`. The `scope` field (job-only tools) is a recent addition.
- **docs-pane "Worktrees" section** — cross-check against `packages/shared/src/git/worktree.ts` and the worktree cleanup flow in `apps/server/src/agents/manager.ts` (`worktree-check` / `worktree-cleanup` archive phases).
- **docs-pane "Reviewers" section** — verify persona launch flow (`dispatch_launch_persona` in `packages/shared/src/mcp/server.ts`) and feedback status values (`open`, `dismissed`, `forwarded`, `fixed`, `ignored`).
- **docs-pane "Status Events" section** — confirm event types match `AGENT_LATEST_EVENT_TYPES` in the server and the guidance in `CLAUDE.md`.
- **docs-pane "Media & Sharing" section** — cross-check the `dispatch_share` input schema including the `content` / `source` / `update` params.
- **docs-pane "Notifications" section** — verify Slack event toggles and focus-aware suppression match `apps/server/src/notifications/slack.ts` and `apps/server/src/focus-tracker.ts`.
- **New in-app section: Jobs** — jobs are a major feature with no in-app docs page. Evaluate whether to add one.
- **`docs/03-api-spec.md`** — spot-check for new routes added in the last 30 days (the file is developer-facing, not visible in-app).
- **`docs/10-operations-runbook.md`** — verify service management commands match current `bin/dispatch-server` / `bin/dispatch-deploy` flags.

## drift_patterns

Observations about where docs tend to go stale. Each run should add new observations and prune ones that no longer apply.

- **User-facing docs drift fastest.** When the app's behavior changes, the in-app docs-pane content is the first thing to notice. It's also the easiest to update in the same PR as the code change (a reviewer can flag stale copy), but in practice it often isn't — so this audit is where it catches up.
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists in `packages/shared/src/mcp/server.ts` evolve independently. Any doc that enumerates tools for one role is at risk of drifting from the other two. Prefer linking to the source of truth over re-listing.
- **Job configuration semantics have changed.** Jobs were once file-based (`.dispatch/jobs/*.md`) and are now DB-backed (migration `0011_drop-jobs-file-path-column.sql`). Older docs and comments may still reference the file-based model.
- **Agent lifecycle has two axes: status and phase.** `status` (`creating`/`running`/…/`archiving`) and `setup_phase` / `archive_phase` are distinct. Docs that mention "phase" without qualifying which one are a drift risk.

## Notes for the next run

- This is the first run using the stateful flow. If anything in this file is confusing or structurally wrong, feel free to reshape it — the format is deliberately loose and should evolve.
- Treat each run as one focused slice. If `next_focus` feels too big for one night, split it and push half back into `backlog` with a concrete description.
- If you notice something that isn't drift but is genuinely missing (e.g. a new feature with no docs anywhere), add it to `backlog` with enough detail that a future run can act on it without re-discovering the context.
