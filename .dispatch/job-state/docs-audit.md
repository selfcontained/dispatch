---
job: docs-audit
updated_at: 2026-04-19
---

# docs-audit — state handoff

Each run of the docs-audit job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-inventory the whole repo every night.

## last_audited_sha

`fd68e1345965eb71b448bf9f69e76faffc4f40c1` — HEAD at the start of the 2026-04-19 Jobs-section run (before the PR that lands this file). The PR that lands this file will advance the SHA once merged; the next run should diff from whatever HEAD is when it reads the file.

## next_focus

**Audit the `docs-pane` "Media & Sharing" section against `registerShareTool` and friends.**

Media drift has been in the backlog since 2026-04-18 and is now the oldest unaudited docs-pane section. The current copy only describes file-path sharing and `source: "simulator"`, but `dispatch_share` has grown other surfaces that agents genuinely use.

Concrete pointers for the next run:

- Primary target: `apps/web/src/components/app/docs-pane.tsx` — the section with `id: "media"`.
- Cross-check against:
  - `apps/server/src/shared/mcp/server.ts` — find `registerShareTool` and the `dispatch_share` input schema. Confirm the current set of accepted parameters (path, `content`, `name`, `description`, `source`, `simulatorUdid`, `update`) and what's supported per source.
  - Supported MIME/formats list — verify against whatever validator `registerShareTool` uses (PNG/JPG/GIF/WebP/MP4/PDF and text extensions). The docs currently say "PNG, JPG, GIF, WebP images, MP4 video, and text files" — check PDF support and any newer formats.
  - `dispatch_list_media` — if the Media section should mention this built-in tool (agents can list media shared with or by them).
  - Media sidebar UX: `apps/web/src/components/app/media-sidebar.tsx` changed on 2026-04-19 — skim to confirm the "reverse chronological + badge for new items" claim is still accurate.
- New subsection the docs should probably gain: **"Sharing text snippets"** — `content` + `name` path, separate from file-path sharing. And **"Updating shared media"** — the `update` parameter that replaces a previously-shared file in place.

Scope the PR to this one section plus whatever the git diff since `last_audited_sha` demands.

## backlog

Items noticed during prior passes but left for later runs. Pick the most relevant one when `next_focus` is empty or already done.

- **docs-pane "Jobs" section — lifecycle handoff files** — the 2026-04-19 Jobs run seeded the Jobs section with the four lifecycle tools (`job_log` / `job_complete` / `job_failed` / `job_needs_input`) and basic run lifecycle, but did not document the `.dispatch/job-state/<job>.md` handoff convention. That's not a server feature — it's a pattern individual jobs adopt — but the docs could mention it under "Run lifecycle" as a recommended way for agents inside a recurring job to pass context between runs. Check the docs-audit.md and any other `.dispatch/job-state/*.md` files that exist at the time for concrete examples.
- **docs-pane "Jobs" section — notify config** — `JobNotifyConfig` on `JobRecord` (`onComplete` / `onError` / `onNeedsInput`) is currently undocumented in the new Jobs section. The config is wired through to Slack via `jobService.onRunStateChange`; a "Notifications" subsection in Jobs (or a cross-link to the Notifications docs) would be worth adding once the Notifications section itself is refreshed.
- **docs-pane "Jobs" section — timeouts** — `timeoutMs` and `needsInputTimeoutMs` are configurable per job (defaults 30 min / 24 h in `apps/server/src/jobs/service.ts`). The current copy mentions "subject to a separate needs-input timeout" but does not call out that either value is configurable. A short bullet would close this.
- **docs-pane "Status Events" section** — event types are in sync today (`AGENT_LATEST_EVENT_TYPES` in `apps/server/src/server.ts`: working/blocked/waiting_user/done/idle). Re-check when new event types are added.
- **docs-pane "Media & Sharing" section** — **assigned to the 2026-04-19+ next_focus.** See above.
- **docs-pane "Notifications" section** — verify Slack event toggles and focus-aware suppression match `apps/server/src/notifications/slack.ts` and `apps/server/src/focus-tracker.ts`. Also: `dispatch_notify` (built-in tool agents can call directly) is rate-limited to 5/min and supports a `respectFocus` flag — the Notifications docs should mention this path, not just agent-event-driven notifications.
- **docs-pane Reviewers section — Autonomous Review flow** — the Agents pass documented the "Autonomous Review" checkbox on create-agent-dialog.tsx, but the Reviewers section never explains how auto-review actually works end-to-end (which persona is launched, when, what the parent agent sees, how addressing feedback works). Worth a "Autonomous review" subsection that ties the two features together.
- **docs-pane "Worktrees" — deps auto-install** — `setupWorktree` in `apps/server/src/agents/manager.ts` (search `setupWorktree`) auto-installs deps by detecting `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` / `bun.lockb`. The Automatic-worktree-creation bullet in docs-pane only mentions `.env` copying; a one-sentence mention of the lockfile-driven install would round it out.
- **`docs/03-api-spec.md`** — spot-check for new routes added in the last 30 days. Recent migrations (0012 auto-review, 0013 review agent type, 0014 base branch, 0015 jobs base branch + auto-archive) imply the agents and jobs POST body schemas have grown. The actual on-demand run endpoint is `POST /api/v1/jobs/run` (body: `{ name, directory, wait?, triggerSource? }`) — spec may pre-date that.
- **`docs/04-agent-lifecycle.md`** — verify it still matches `AgentStatus` / `SetupPhase` / `ArchivePhase` in `apps/server/src/agents/manager.ts`. Values: status ∈ {creating, running, stopping, stopped, archiving, error, unknown}; setupPhase ∈ {worktree, env, deps, session, null}; archivePhase ∈ {stopping, worktree-check, worktree-cleanup, finalizing, null}.
- **`docs/10-operations-runbook.md`** — verify service management commands match current `bin/dispatch-server` / `bin/dispatch-deploy` flags.
- **README.md MCP tools summary** — the README likely lists built-in MCP tools and may be out of date for the same reasons the docs-pane was. Worth a spot check after the next `next_focus` is done.

## drift_patterns

Observations about where docs tend to go stale. Each run should add new observations and prune ones that no longer apply.

- **User-facing docs drift fastest.** When the app's behavior changes, the in-app docs-pane content is the first thing to notice. It's also the easiest to update in the same PR as the code change (a reviewer can flag stale copy), but in practice it often isn't — so this audit is where it catches up.
- **Settings defaults flip without the docs noticing.** 2026-04-18 Worktrees run found the docs claimed the default worktree location was `.dispatch/worktrees/` (nested), but `WorktreeLocationSettings` in `apps/web/src/components/app/settings-pane.tsx` actually defaults to `"sibling"`, and so does `manager.ts` (`worktreeLocation = input.worktreeLocation ?? "sibling"`). When auditing a "default" claim in docs, trace it to the component's `useState(...)` initial value AND to the server-side fallback — the two can disagree, and the docs usually follow whichever one was true when the doc was first written.
- **The built-in MCP tool list sprawls without touching the docs.** The 2026-04-18 Repo Tools pass found the docs-pane listed 7 built-in tools; `AGENT_TOOLS` in `apps/server/src/shared/mcp/server.ts` actually has 17. Each new tool gets added to `AGENT_TOOLS` / `JOB_TOOLS` / `PERSONA_TOOLS` but almost never to `docs-pane.tsx`. Grep for `AGENT_TOOLS = new Set` and diff against the `Built-in tools` list in `docs-pane.tsx` whenever touching this area.
- **The create-agent dialog accretes options silently.** When `create-agent-dialog.tsx` gains a field, the "Creating an agent" bullet list needs a matching entry. Grep `create-agent-dialog.tsx` for `<Checkbox` and `<label` to catch new form fields quickly. The same pattern applies to the add-job and edit-job forms in `jobs-pane.tsx` — they share branch selection via `branch-select.tsx`, so a change there can flow through to both Agent and Job docs sections.
- **Status indicator colors are theme-driven via CSS vars (`--status-working`, `--status-blocked`, `--status-waiting`, `--status-done`).** Don't trust any hard-coded color-name claim in the docs — resolve the actual hue from `apps/web/src/index.css`. 2026-04-18 found the docs had working/done backwards (they'd been copy-pasted from some earlier palette).
- **MCP tool sets change by agent type.** The AGENT / JOB / PERSONA tool lists in `apps/server/src/shared/mcp/server.ts` evolve independently. Any doc that enumerates tools for one role is at risk of drifting from the other two. Keep role-specific lists rather than trying to re-list the full set.
- **Repo tool prefix is `repo_`, not `repo.`.** MCP clients don't support dots in tool names, so dots in configured names are sanitized to underscores (`repo-tools.ts`). Docs had `repo.lint` wrong for a long stretch; grep for `repo\.` in docs when reviewing tool-prefix claims.
- **Agent lifecycle has two axes: status and phase.** `status` (`creating`/`running`/…/`archiving`) and `setup_phase` / `archive_phase` are distinct. Docs that mention "phase" without qualifying which one are a drift risk.
- **Persona prompt assembly strips legacy placeholders.** `apps/server/src/personas/loader.ts` strips `{{context}}` and `{{diff}}` from persona bodies and appends its own context/diff/feedback-guidance sections. Anywhere the docs describe persona file contents, cross-check against `assemblePersonaPrompt`.
- **Job-related state lives in multiple places.** A "Job" has fields on the DB row (`use_worktree`, `base_branch`, `auto_archive`, …), on the `JobRecord` TS type, in the add-job form state (`keepAgent` inverts to `autoArchive`), and in the `buildJobPrompt` preamble that is sent to the agent on every run. When auditing a Jobs claim, trace the field from the UI form → `AddJobConfig` / `JobConfigUpdate` → `JobStore.createJob` / `updateJob` → `JobRecord` → `buildRunConfig` / `buildJobPrompt`. The UI labels (e.g. "Keep agent") do not always match the DB column name (`auto_archive`).

## Notes for the next run

- If `next_focus` feels too big for one night, split it and push half back into `backlog` with a concrete description.
- Treat each run as one focused slice. Recent passes (Agents, Repo Tools, Reviewers, Worktrees, Jobs) all fit comfortably in one PR each. Aim for that size.
- If you notice something that isn't drift but is genuinely missing (e.g. a new feature with no docs anywhere), add it to `backlog` with enough detail that a future run can act on it without re-discovering the context.

## History

- **2026-04-18** (Agents) — Audited docs-pane "Agents" section. Fixed status-indicator color mapping (working/done were swapped in the docs), added Autonomous Review checkbox and Create-with-prompt flow to the "Creating an agent" bullets, clarified the auto-naming behavior of the Name field.
- **2026-04-18** (Repo Tools) — Audited docs-pane "Repo Tools" section against `repo-tools.ts` and `server.ts`. Fixed the tool prefix from `repo.` → `repo_` (and added a note about dot-to-underscore sanitization), documented the `scope` field for job/reviewer-only tools, expanded the built-in tool list from 7 → 14 entries, and added a one-paragraph note that persona and job agents see different built-in tool subsets.
- **2026-04-18** (Reviewers) — Audited docs-pane "Reviewers" section against `PERSONA_TOOLS` and the review tooling in `apps/server/src/shared/mcp/server.ts` + the loader in `apps/server/src/personas/loader.ts`. Removed the stale `{{context}}`/`{{diff}}` placeholder example (the loader now strips them and auto-appends context/diff/feedback-guidance). Added a "Review lifecycle" subsection covering `review_status` with its `reviewing`/`complete` statuses and `approve`/`request_changes` verdicts. Added a paragraph noting that persona agents also have `dispatch_pin`, `dispatch_share`, and `get_parent_context`. Split "Feedback findings" into "Submitting findings" + "Review lifecycle".
- **2026-04-18** (Worktrees) — Audited docs-pane "Worktrees" section against `apps/server/src/shared/git/worktree.ts`, `apps/server/src/agents/manager.ts` (archive flow + `setupWorktree`), `apps/web/src/components/app/settings-pane.tsx`, and `create-agent-dialog.tsx`. Flipped the reversed "Worktree location" default — code default is `sibling` (`../repo-branch-name`), not `.dispatch/worktrees/`. Automatic-creation, archive-cleanup (auto/keep/force), and parallel-agents claims all matched reality. Deps auto-install omission pushed to backlog.
- **2026-04-19** (Jobs) — Seeded a new docs-pane "Jobs" section between "Repo Tools" and "Worktrees". Covers creating a job (all form fields including Name / Working directory / Prompt / Schedule / Agent type / Full access / Use worktree + base branch / Keep agent after run completes / Enable on schedule), on-demand runs (Run now + `triggerSource: "manual"`), run lifecycle (`job_log` / `job_complete` / `job_failed` / `job_needs_input` plus the seven run statuses), and history/status. Used `Briefcase` icon, added `"jobs"` to the `DocsSection` union. Lifecycle handoff-file convention and `JobNotifyConfig` / configurable timeouts deferred to backlog.
