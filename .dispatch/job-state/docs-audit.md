---
job: docs-audit
updated_at: 2026-04-18
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`8d7e3fb97069eccda7ac9bc3de920832177cae23` — HEAD at the start of the 2026-04-18 run. The PR that lands this file will advance the SHA once merged; the next run should diff from wherever HEAD is when it reads the file.

## next_focus

**Audit the `docs-pane.tsx` "Repo Tools" section against `apps/server/src/shared/mcp/repo-tools.ts` and the `.dispatch/tools.json` schema.**

This was the top backlog item after the Agents pass. Focus points:

- `apps/web/src/components/app/docs-pane.tsx` — the "Repo Tools" section (search for `id: "tools"`).
- Cross-check against:
  - `apps/server/src/shared/mcp/repo-tools.ts` — schema for `.dispatch/tools.json`, including any `scope` field (job-only tools) that the docs don't currently mention.
  - `apps/server/src/shared/mcp/server.ts` — the built-in tools list the docs enumerate (`create_pr`, `get_pr_status`, `dispatch_event`, `dispatch_share`, `dispatch_feedback`, `dispatch_get_feedback`, `dispatch_launch_persona`). Verify the list is complete and the short descriptions are accurate. In particular, the docs list `dispatch_pin` in `CLAUDE.md` but not in the docs-pane — worth checking whether it belongs under Built-in tools.
  - `apps/server/test/repo-tools.test.ts` — captures the supported param shapes.

Scope the PR to this one section plus whatever the git diff since `last_audited_sha` demands.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs-pane "Worktrees" section** — cross-check against `apps/server/src/shared/git/worktree.ts` and the worktree cleanup flow in `apps/server/src/agents/manager.ts` (`worktree-check` / `worktree-cleanup` archive phases). Confirm the "sibling vs nested" Settings toggle copy still matches the UI.
- **docs-pane "Reviewers" section** — verify persona launch flow (`dispatch_launch_persona` in `apps/server/src/shared/mcp/server.ts`) and feedback status values. The docs describe severity but not verdict/status values; see `review_status` / `verdict` fields on `AgentRecord.review` in `apps/server/src/agents/manager.ts`.
- **docs-pane "Status Events" section** — event types are in sync today (`AGENT_LATEST_EVENT_TYPES` in `apps/server/src/server.ts:243`: working/blocked/waiting_user/done/idle). Re-check when new event types are added.
- **docs-pane "Media & Sharing" section** — cross-check the `dispatch_share` input schema including the `content` / `source` / `update` params. Docs mention `source: "simulator"` but not the `content` / `update` parameters.
- **docs-pane "Notifications" section** — verify Slack event toggles and focus-aware suppression match `apps/server/src/notifications/slack.ts` and `apps/server/src/focus-tracker.ts`.
- **New in-app section: Jobs** — jobs are a major feature with no in-app docs page. The 2026-04-18 Agents pass noticed an `isJobAgent` badge in `agent-card.tsx` but there's no user-facing doc that explains how jobs differ from manually-launched agents. Consider adding a "Jobs" section.
- **`docs/03-api-spec.md`** — spot-check for new routes added in the last 30 days. Recent migrations (0012 auto-review, 0013 review agent type, 0014 base branch) imply the agents POST body schema has grown.
- **`docs/04-agent-lifecycle.md`** — verify it still matches `AgentStatus` / `SetupPhase` / `ArchivePhase` in `apps/server/src/agents/manager.ts`. The values are: status ∈ {creating, running, stopping, stopped, archiving, error, unknown}; setupPhase ∈ {worktree, env, deps, session, null}; archivePhase ∈ {stopping, worktree-check, worktree-cleanup, finalizing, null}.
- **`docs/10-operations-runbook.md`** — verify service management commands match current `bin/dispatch-server` / `bin/dispatch-deploy` flags.

## drift_patterns

Observations about where docs tend to go stale. Each run should add new observations and prune ones that no longer apply.

- **User-facing docs drift fastest.** When the app's behavior changes, the in-app docs-pane content is the first thing to notice. It's also the easiest to update in the same PR as the code change (a reviewer can flag stale copy), but in practice it often isn't — so this audit is where it catches up.
- **The create-agent dialog accretes options silently.** The 2026-04-18 pass found that the dialog had gained an "Autonomous Review" checkbox and a two-step "Create with prompt" flow (initial prompt textarea) without any change to `docs-pane.tsx`. When `create-agent-dialog.tsx` gains a field, the "Creating an agent" bullet list needs a matching entry. Grep `create-agent-dialog.tsx` for `<Checkbox` and `<label` to catch new form fields quickly.
- **Status indicator colors are theme-driven via CSS vars (`--status-working`, `--status-blocked`, `--status-waiting`, `--status-done`).** Don't trust any hard-coded color-name claim in the docs — resolve the actual hue from `apps/web/src/index.css` (search for `--status-working`). 2026-04-18 found the docs had working/done backwards (they'd been copy-pasted from some earlier palette).
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists in `apps/server/src/shared/mcp/server.ts` evolve independently. Any doc that enumerates tools for one role is at risk of drifting from the other two. Prefer linking to the source of truth over re-listing.
- **Job configuration semantics have changed.** Jobs were once file-based (`.dispatch/jobs/*.md`) and are now DB-backed (migration `0011_drop-jobs-file-path-column.sql`). Older docs and comments may still reference the file-based model.
- **Agent lifecycle has two axes: status and phase.** `status` (`creating`/`running`/…/`archiving`) and `setup_phase` / `archive_phase` are distinct. Docs that mention "phase" without qualifying which one are a drift risk.

## Notes for the next run

- If `next_focus` feels too big for one night, split it and push half back into `backlog` with a concrete description.
- Treat each run as one focused slice. The Agents pass on 2026-04-18 fit comfortably in one PR; aim for that size.
- If you notice something that isn't drift but is genuinely missing (e.g. a new feature with no docs anywhere), add it to `backlog` with enough detail that a future run can act on it without re-discovering the context.

## History

- **2026-04-18** — Audited docs-pane "Agents" section. Fixed status-indicator color mapping (working/done were swapped in the docs), added Autonomous Review checkbox and Create-with-prompt flow to the "Creating an agent" bullets, clarified the auto-naming behavior of the Name field. Did not touch any secondary docs.
