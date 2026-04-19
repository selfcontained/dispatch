---
job: docs-audit
updated_at: 2026-04-18
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`094372b470309d93177f42e7dd05fcf3e6b644f0` — HEAD at the start of the 2026-04-18 Worktrees run (before the PR that lands this file). The PR that lands this file will advance the SHA once merged; the next run should diff from whatever HEAD is when it reads the file.

## next_focus

**Add an in-app "Jobs" section to `docs-pane.tsx` and cross-check it against the recent jobs work.**

Jobs are now a major feature with zero in-app documentation, and #361 just expanded them significantly (on-demand runs, base branch picker, keep-agent / auto-archive toggle, per-run worktrees). The backlog has flagged "new in-app Jobs section" for two runs; #361 makes it overdue.

Concrete pointers for the next run:

- Add a new section to `apps/web/src/components/app/docs-pane.tsx` with `id: "jobs"`. Insert it after "Repo Tools" or near "Agents" — jobs spawn agents on a schedule.
- Update the `SectionId` union and `sections` array; also add a `Briefcase` (or similar) icon import from `lucide-react`.
- Cross-check against:
  - `apps/web/src/components/app/jobs-pane.tsx` — the UI users actually see (filters, run-now, editor fields).
  - `apps/server/src/jobs/store.ts` + `service.ts` — `Job` schema (fields include `id`, `name`, `prompt`, `schedule`, `baseBranch`, `autoArchive`, `cwd`, `enabled`, `agentType`, and `useWorktree`). Confirm which fields the UI exposes.
  - `apps/server/src/jobs/runner.ts` — how a scheduled run spawns an agent, what `.dispatch/job-state/*.md` handoff files are, how `job_log` / `job_complete` / `job_failed` / `job_needs_input` fit in.
  - `apps/server/src/db/migrations/0015_jobs-base-branch-auto-archive.sql` — the new `base_branch` and `auto_archive` columns on `jobs`.
  - `apps/server/src/server.ts` — `/api/v1/jobs/...` routes (including the on-demand run endpoint added in #361).

What the section should cover (minimum):

1. What a job is (a scheduled prompt that spawns an agent on a cron).
2. On-demand runs (the new "Run now" button from #361).
3. Base branch selection and the worktree flow (each job run gets its own worktree from the configured base).
4. Auto-archive behavior and the "keep agent after run" opt-out (from the `auto_archive` field).
5. The job-lifecycle tools an agent running inside a job can call (`job_log`, `job_complete`, `job_failed`, `job_needs_input`) and the state-file handoff pattern (`.dispatch/job-state/<job>.md`).
6. Where to find job state in the UI (run history, last run status, schedule).

Scope the PR to this one new section plus whatever the git diff since `last_audited_sha` demands. If the section feels too large, split into "Jobs (basics)" for this run and push "Job lifecycle tools + handoff files" into backlog for the next run.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs-pane "Status Events" section** — event types are in sync today (`AGENT_LATEST_EVENT_TYPES` in `apps/server/src/server.ts`: working/blocked/waiting_user/done/idle). Re-check when new event types are added.
- **docs-pane "Media & Sharing" section** — `dispatch_share` supports `content`, `name`, `update`, and `simulatorUdid` params (see `registerShareTool` in `apps/server/src/shared/mcp/server.ts`). Docs currently only describe `source: "simulator"`. Worth a "Sharing text snippets" or "Updating shared media" bullet.
- **docs-pane "Notifications" section** — verify Slack event toggles and focus-aware suppression match `apps/server/src/notifications/slack.ts` and `apps/server/src/focus-tracker.ts`. Also: `dispatch_notify` (built-in tool agents can call directly) is rate-limited to 5/min and supports a `respectFocus` flag — the Notifications docs should mention this path, not just agent-event-driven notifications.
- **docs-pane Reviewers section — Autonomous Review flow** — the Agents pass documented the "Autonomous Review" checkbox on create-agent-dialog.tsx, but the Reviewers section never explains how auto-review actually works end-to-end (which persona is launched, when, what the parent agent sees, how addressing feedback works). Worth a "Autonomous review" subsection that ties the two features together.
- **docs-pane "Worktrees" — deps auto-install** — `setupWorktree` in `apps/server/src/agents/manager.ts` (search `setupWorktree`) auto-installs deps by detecting `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` / `bun.lockb`. The Automatic-worktree-creation bullet in docs-pane only mentions `.env` copying; a one-sentence mention of the lockfile-driven install would round it out. (2026-04-18 Worktrees run: left out to keep the drift fix tight.)
- **`docs/03-api-spec.md`** — spot-check for new routes added in the last 30 days. Recent migrations (0012 auto-review, 0013 review agent type, 0014 base branch, 0015 jobs base branch + auto-archive) imply the agents and jobs POST body schemas have grown. `#361` added an on-demand job run route — likely `POST /api/v1/jobs/:id/runs` or similar.
- **`docs/04-agent-lifecycle.md`** — verify it still matches `AgentStatus` / `SetupPhase` / `ArchivePhase` in `apps/server/src/agents/manager.ts`. The values are: status ∈ {creating, running, stopping, stopped, archiving, error, unknown}; setupPhase ∈ {worktree, env, deps, session, null}; archivePhase ∈ {stopping, worktree-check, worktree-cleanup, finalizing, null}.
- **`docs/10-operations-runbook.md`** — verify service management commands match current `bin/dispatch-server` / `bin/dispatch-deploy` flags.
- **README.md MCP tools summary** — the README likely lists built-in MCP tools and may be out of date for the same reasons the docs-pane was. Worth a spot check after the next `next_focus` is done.

## drift_patterns

Observations about where docs tend to go stale. Each run should add new observations and prune ones that no longer apply.

- **User-facing docs drift fastest.** When the app's behavior changes, the in-app docs-pane content is the first thing to notice. It's also the easiest to update in the same PR as the code change (a reviewer can flag stale copy), but in practice it often isn't — so this audit is where it catches up.
- **Settings defaults flip without the docs noticing.** 2026-04-18 Worktrees run found the docs claimed the default worktree location was `.dispatch/worktrees/` (nested), but `WorktreeLocationSettings` in `apps/web/src/components/app/settings-pane.tsx` actually defaults to `"sibling"`, and so does `manager.ts` (`worktreeLocation = input.worktreeLocation ?? "sibling"`). When auditing a "default" claim in docs, trace it to the component's `useState(...)` initial value AND to the server-side fallback — the two can disagree, and the docs usually follow whichever one was true when the doc was first written.
- **The built-in MCP tool list sprawls without touching the docs.** The 2026-04-18 Repo Tools pass found the docs-pane listed 7 built-in tools; `AGENT_TOOLS` in `apps/server/src/shared/mcp/server.ts` actually has 17. Each new tool gets added to `AGENT_TOOLS` / `JOB_TOOLS` / `PERSONA_TOOLS` but almost never to `docs-pane.tsx`. Grep for `AGENT_TOOLS = new Set` and diff against the `Built-in tools` list in `docs-pane.tsx` whenever touching this area.
- **The create-agent dialog accretes options silently.** The 2026-04-18 pass found the dialog had gained an "Autonomous Review" checkbox and a two-step "Create with prompt" flow without any change to `docs-pane.tsx`. When `create-agent-dialog.tsx` gains a field, the "Creating an agent" bullet list needs a matching entry. Grep `create-agent-dialog.tsx` for `<Checkbox` and `<label` to catch new form fields quickly. **#361 just extracted the base-branch + worktree-branch UI into `apps/web/src/components/app/branch-select.tsx`; that's where new branch-related fields will appear next.**
- **Status indicator colors are theme-driven via CSS vars (`--status-working`, `--status-blocked`, `--status-waiting`, `--status-done`).** Don't trust any hard-coded color-name claim in the docs — resolve the actual hue from `apps/web/src/index.css`. 2026-04-18 found the docs had working/done backwards (they'd been copy-pasted from some earlier palette).
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists in `apps/server/src/shared/mcp/server.ts` evolve independently. Any doc that enumerates tools for one role is at risk of drifting from the other two. Keep role-specific lists rather than trying to re-list the full set.
- **Repo tool prefix is `repo_`, not `repo.`.** MCP clients don't support dots in tool names, so dots in configured names are sanitized to underscores (`repo-tools.ts`). Docs had `repo.lint` wrong for a long stretch; grep for `repo\.` in docs when reviewing tool-prefix claims.
- **Jobs are a growing feature with no in-app docs.** Flagged by every run so far. #361 added on-demand runs, base-branch selection, and keep-agent/auto-archive. Next run is assigned to seed the first Jobs section. Keep an eye on `apps/server/src/jobs/` (service/store/runner) for churn that keeps outpacing the docs.
- **Agent lifecycle has two axes: status and phase.** `status` (`creating`/`running`/…/`archiving`) and `setup_phase` / `archive_phase` are distinct. Docs that mention "phase" without qualifying which one are a drift risk.
- **Persona prompt assembly strips legacy placeholders.** `apps/server/src/personas/loader.ts` strips `{{context}}` and `{{diff}}` from persona bodies and appends its own context/diff/feedback-guidance sections. Anywhere the docs describe persona file contents, cross-check against `assemblePersonaPrompt`.

## Notes for the next run

- If `next_focus` feels too big for one night, split it and push half back into `backlog` with a concrete description.
- Treat each run as one focused slice. The Agents, Repo Tools, Reviewers, and Worktrees passes on 2026-04-18 all fit comfortably in one PR each. Aim for that size.
- If you notice something that isn't drift but is genuinely missing (e.g. a new feature with no docs anywhere), add it to `backlog` with enough detail that a future run can act on it without re-discovering the context.

## History

- **2026-04-18** (Agents) — Audited docs-pane "Agents" section. Fixed status-indicator color mapping (working/done were swapped in the docs), added Autonomous Review checkbox and Create-with-prompt flow to the "Creating an agent" bullets, clarified the auto-naming behavior of the Name field.
- **2026-04-18** (Repo Tools) — Audited docs-pane "Repo Tools" section against `repo-tools.ts` and `server.ts`. Fixed the tool prefix from `repo.` → `repo_` (and added a note about dot-to-underscore sanitization), documented the `scope` field for job/reviewer-only tools, expanded the built-in tool list from 7 → 14 entries, and added a one-paragraph note that persona and job agents see different built-in tool subsets.
- **2026-04-18** (Reviewers) — Audited docs-pane "Reviewers" section against `PERSONA_TOOLS` and the review tooling in `apps/server/src/shared/mcp/server.ts` + the loader in `apps/server/src/personas/loader.ts`. Removed the stale `{{context}}`/`{{diff}}` placeholder example (the loader now strips them and auto-appends context/diff/feedback-guidance). Added a "Review lifecycle" subsection covering `review_status` with its `reviewing`/`complete` statuses and `approve`/`request_changes` verdicts. Added a paragraph noting that persona agents also have `dispatch_pin`, `dispatch_share`, and `get_parent_context`. Split "Feedback findings" into "Submitting findings" + "Review lifecycle".
- **2026-04-18** (Worktrees) — Audited docs-pane "Worktrees" section against `apps/server/src/shared/git/worktree.ts`, `apps/server/src/agents/manager.ts` (archive flow + `setupWorktree`), `apps/web/src/components/app/settings-pane.tsx`, and `create-agent-dialog.tsx`. Flipped the reversed "Worktree location" default — code default is `sibling` (`../repo-branch-name`), not `.dispatch/worktrees/`. Automatic-creation, archive-cleanup (auto/keep/force), and parallel-agents claims all matched reality. Deps auto-install omission pushed to backlog.
