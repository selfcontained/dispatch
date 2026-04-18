---
job: docs-audit
updated_at: 2026-04-18
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`ecf3cffc084d0477e5e62a70fa74444f528cfe5c` — HEAD at the start of the 2026-04-18 Reviewers run. The PR that lands this file will advance the SHA once merged; the next run should diff from wherever HEAD is when it reads the file.

## next_focus

**Audit the `docs-pane.tsx` "Worktrees" section against `apps/server/src/shared/git/worktree.ts`, the create-agent worktree flow in `create-agent-dialog.tsx`, and the archive/cleanup phases in `apps/server/src/agents/manager.ts` (`worktree-check` / `worktree-cleanup`).**

Concrete pointers for the next run:

- `apps/web/src/components/app/docs-pane.tsx` — the "Worktrees" section (search for `id: "worktrees"`).
- Cross-check against:
  - `apps/server/src/shared/git/worktree.ts` — worktree creation, branch selection, location (sibling vs nested).
  - `apps/web/src/components/app/create-agent-dialog.tsx` — the UI the docs describe: base-branch picker, custom branch name, worktree location setting.
  - `apps/server/src/agents/manager.ts` — search for `worktree-check` and `worktree-cleanup` (archive phases). The docs should describe what happens when an agent finishes: uncommitted/unpushed work detection, archive vs. delete.
  - Settings page for the sibling/nested toggle — confirm the copy in docs still matches what the UI shows.
- Also worth a sentence on how `baseBranch` is surfaced (recent migration `0014_base-branch.sql`).

Scope the PR to this one section plus whatever the git diff since `last_audited_sha` demands.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs-pane "Status Events" section** — event types are in sync today (`AGENT_LATEST_EVENT_TYPES` in `apps/server/src/server.ts`: working/blocked/waiting_user/done/idle). Re-check when new event types are added.
- **docs-pane "Media & Sharing" section** — `dispatch_share` supports `content`, `name`, `update`, and `simulatorUdid` params (see `registerShareTool` in `apps/server/src/shared/mcp/server.ts`). Docs currently only describe `source: "simulator"`. Worth a "Sharing text snippets" or "Updating shared media" bullet.
- **docs-pane "Notifications" section** — verify Slack event toggles and focus-aware suppression match `apps/server/src/notifications/slack.ts` and `apps/server/src/focus-tracker.ts`. Also: `dispatch_notify` (built-in tool agents can call directly) is rate-limited to 5/min and supports a `respectFocus` flag — the Notifications docs should mention this path, not just agent-event-driven notifications.
- **New in-app section: Jobs** — jobs are a major feature with no in-app docs page. The Repo Tools pass added a mention of the job-only built-in tools (`job_complete`, `job_failed`, `job_needs_input`, `job_log`) but there's still no page explaining how jobs differ from manually-launched agents, how they're scheduled, or how `.dispatch/job-state/*.md` handoff files work. Consider adding a "Jobs" section.
- **docs-pane Reviewers section — Autonomous Review flow** — the Agents pass documented the "Autonomous Review" checkbox on create-agent-dialog.tsx, but the Reviewers section never explains how auto-review actually works end-to-end (which persona is launched, when, what the parent agent sees, how addressing feedback works). Worth a "Autonomous review" subsection that ties the two features together.
- **`docs/03-api-spec.md`** — spot-check for new routes added in the last 30 days. Recent migrations (0012 auto-review, 0013 review agent type, 0014 base branch) imply the agents POST body schema has grown.
- **`docs/04-agent-lifecycle.md`** — verify it still matches `AgentStatus` / `SetupPhase` / `ArchivePhase` in `apps/server/src/agents/manager.ts`. The values are: status ∈ {creating, running, stopping, stopped, archiving, error, unknown}; setupPhase ∈ {worktree, env, deps, session, null}; archivePhase ∈ {stopping, worktree-check, worktree-cleanup, finalizing, null}.
- **`docs/10-operations-runbook.md`** — verify service management commands match current `bin/dispatch-server` / `bin/dispatch-deploy` flags.
- **README.md MCP tools summary** — the README likely lists built-in MCP tools and may be out of date for the same reasons the docs-pane was. Worth a spot check after the next `next_focus` is done.

## drift_patterns

Observations about where docs tend to go stale. Each run should add new observations and prune ones that no longer apply.

- **User-facing docs drift fastest.** When the app's behavior changes, the in-app docs-pane content is the first thing to notice. It's also the easiest to update in the same PR as the code change (a reviewer can flag stale copy), but in practice it often isn't — so this audit is where it catches up.
- **The built-in MCP tool list sprawls without touching the docs.** The 2026-04-18 Repo Tools pass found the docs-pane listed 7 built-in tools; `AGENT_TOOLS` in `apps/server/src/shared/mcp/server.ts` actually has 17. Each new tool gets added to `AGENT_TOOLS` / `JOB_TOOLS` / `PERSONA_TOOLS` but almost never to `docs-pane.tsx`. Grep for `AGENT_TOOLS = new Set` and diff against the `Built-in tools` list in `docs-pane.tsx` whenever touching this area.
- **The create-agent dialog accretes options silently.** The 2026-04-18 pass found that the dialog had gained an "Autonomous Review" checkbox and a two-step "Create with prompt" flow (initial prompt textarea) without any change to `docs-pane.tsx`. When `create-agent-dialog.tsx` gains a field, the "Creating an agent" bullet list needs a matching entry. Grep `create-agent-dialog.tsx` for `<Checkbox` and `<label` to catch new form fields quickly.
- **Status indicator colors are theme-driven via CSS vars (`--status-working`, `--status-blocked`, `--status-waiting`, `--status-done`).** Don't trust any hard-coded color-name claim in the docs — resolve the actual hue from `apps/web/src/index.css`. 2026-04-18 found the docs had working/done backwards (they'd been copy-pasted from some earlier palette).
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists in `apps/server/src/shared/mcp/server.ts` evolve independently. Any doc that enumerates tools for one role is at risk of drifting from the other two. The Reviewers pass enumerated the persona-only tools (`review_status`, `get_parent_context`) directly; keep that specific-to-role pattern rather than re-listing the full set.
- **Repo tool prefix is `repo_`, not `repo.`.** MCP clients don't support dots in tool names, so dots in configured names are sanitized to underscores (`repo-tools.ts`). Docs had `repo.lint` wrong for a long stretch; grep for `repo\.` in docs when reviewing tool-prefix claims.
- **Job configuration semantics have changed.** Jobs were once file-based (`.dispatch/jobs/*.md`) and are now DB-backed (migration `0011_drop-jobs-file-path-column.sql`). Older docs and comments may still reference the file-based model.
- **Agent lifecycle has two axes: status and phase.** `status` (`creating`/`running`/…/`archiving`) and `setup_phase` / `archive_phase` are distinct. Docs that mention "phase" without qualifying which one are a drift risk.
- **Persona prompt assembly strips legacy placeholders.** `apps/server/src/personas/loader.ts` strips `{{context}}` and `{{diff}}` from persona bodies and appends its own context/diff/feedback-guidance sections. The Reviewers pass on 2026-04-18 found the docs were still telling users to add those placeholders. Anywhere the docs describe persona file contents, cross-check against `assemblePersonaPrompt`.

## Notes for the next run

- If `next_focus` feels too big for one night, split it and push half back into `backlog` with a concrete description.
- Treat each run as one focused slice. The Agents, Repo Tools, and Reviewers passes on 2026-04-18 all fit comfortably in one PR each. Aim for that size.
- If you notice something that isn't drift but is genuinely missing (e.g. a new feature with no docs anywhere), add it to `backlog` with enough detail that a future run can act on it without re-discovering the context.

## History

- **2026-04-18** (Agents) — Audited docs-pane "Agents" section. Fixed status-indicator color mapping (working/done were swapped in the docs), added Autonomous Review checkbox and Create-with-prompt flow to the "Creating an agent" bullets, clarified the auto-naming behavior of the Name field.
- **2026-04-18** (Repo Tools) — Audited docs-pane "Repo Tools" section against `repo-tools.ts` and `server.ts`. Fixed the tool prefix from `repo.` → `repo_` (and added a note about dot-to-underscore sanitization), documented the `scope` field for job/reviewer-only tools, expanded the built-in tool list from 7 → 14 entries, and added a one-paragraph note that persona and job agents see different built-in tool subsets.
- **2026-04-18** (Reviewers) — Audited docs-pane "Reviewers" section against `PERSONA_TOOLS` and the review tooling in `apps/server/src/shared/mcp/server.ts` + the loader in `apps/server/src/personas/loader.ts`. Removed the stale `{{context}}`/`{{diff}}` placeholder example (the loader now strips them and auto-appends context/diff/feedback-guidance). Added a "Review lifecycle" subsection covering `review_status` with its `reviewing`/`complete` statuses and `approve`/`request_changes` verdicts. Added a paragraph noting that persona agents also have `dispatch_pin`, `dispatch_share`, and `get_parent_context`. Split "Feedback findings" into "Submitting findings" + "Review lifecycle".
