Audit Dispatch's documentation against the actual codebase and fix anything that has drifted. This job runs on a recurring schedule, so lean on the state file to avoid re-doing work every run.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. Only check docs against the Dispatch codebase and its actual behavior. The primary user-facing documentation lives **in the app** at `apps/web/src/components/app/docs-pane.tsx` — that's the most important surface to keep accurate. Top-level files (`README.md`, `CLAUDE.md`, `AGENTS.md`) and the `docs/` folder are secondary.

## Phase 0: Read the state file

Read `.dispatch/job-state/docs-audit.md` before doing anything else. It contains:

- `last_audited_sha` — the HEAD SHA from the previous run
- `backlog` — items the last run deferred or flagged for next time
- `drift_patterns` — recurring observations about where docs tend to go stale
- `next_focus` — the specific area the last run recommended you focus on this time

If the state file is missing or malformed, fall through to a bootstrap full pass (see Phase 5 fallback), log what you found, and write a fresh state file at the end.

## Phase 1: Scope the work

Do **not** inventory the whole codebase from scratch. Scope each run to a small, focused slice:

1. Run `git diff --name-only <last_audited_sha>..HEAD` to find what's actually changed since the last audit. Map those file paths to the docs that describe them.
2. Pick **one** deep-dive area from `next_focus` in the state file (or the top item in `backlog` if `next_focus` is empty).
3. If `last_audited_sha` is missing, invalid, or older than 30 days, also spot-check the sections flagged in `drift_patterns` — those are the ones that keep rotting.

Keep the run's scope deliberately narrow. A small, correct PR every night beats a sprawling one once a week.

## Phase 2: Audit the in-app docs (primary)

`apps/web/src/components/app/docs-pane.tsx` defines the user-facing docs as inline React content. Current sections (check for additions/removals):

- Agents
- Repo Tools
- Worktrees
- Reviewers (personas)
- Status Events
- Media & Sharing
- Notifications

For each section in scope, verify:

- Feature claims match what the code actually does (API routes, MCP tool sets, agent lifecycle, file paths referenced).
- Code snippets, flag names, env vars, and CLI examples are current.
- Screenshots/examples (if any) still reflect the UI.

When the app's behavior has changed, update the JSX content in `docs-pane.tsx`. Keep the copy tight — match the existing tone.

## Phase 3: Audit secondary docs (only as needed)

Only touch these if the Phase 1 diff points to them or they're explicitly in `next_focus`:

- `README.md` — features list, setup commands, MCP tools summary, docs index, Quick Install prompt.
- `CLAUDE.md` / `AGENTS.md` — project structure tree, scripts, paths. Keep these in sync with each other.
- `docs/03-api-spec.md` — API endpoint reference (developer-facing, not duplicated in app).
- `docs/04-agent-lifecycle.md` — state machine, tmux contract, reconciliation (developer-facing).
- `docs/10-operations-runbook.md` — service management, releases, diagnostics.
- `docs/11-backend-compatibility-checklist.md` — dev checklist.
- `docs/12-new-machine-setup.md` — first-time machine setup.
- `docs/14-theming.md` — theme authoring guide.

Do not rewrite docs for style. Fix factual drift only.

## Phase 4: Update the state file

Before committing, rewrite `.dispatch/job-state/docs-audit.md` with:

- `last_audited_sha` — current `HEAD` (the commit you're about to create will supersede this when it lands).
- `backlog` — anything you noticed but deferred (e.g. "docs-pane Reviewers section should add the new `review_status` verdict values").
- `drift_patterns` — running list of areas that keep needing updates. Add new observations, prune stale ones. These signal where to invest.
- `next_focus` — the specific area the next run should start with. Be concrete ("audit docs-pane Worktrees section against `packages/shared/src/git/worktree.ts`") rather than vague ("check worktrees").

Treat the state file as a handoff note to a colleague, not a log.

## Phase 5: Validate, commit, PR

1. If `apps/web/` changed, run `pnpm run check` (docs-only changes generally don't need it).
2. Verify any `docs/` links in `README.md` still resolve.
3. Commit on a new branch. Include the state file update in the same commit.
4. Create a PR targeting `main` with a short body: what was audited, what changed, and what's deferred to next run.

### Bootstrap fallback

If the state file is missing (first run) or clearly out of sync, do a shallow pass: skim each in-app docs section and each top-level README/CLAUDE section, note observations in the new state file, and fix only the most obviously broken claims. Leave the rest for subsequent runs. Do not attempt a full rewrite in a single night.

## Reporting

Use `job_log` for phase-level progress. On completion, call `job_complete` with:

- `files_updated` — paths + brief change notes
- `files_created` / `files_deleted`
- `state_file_summary` — what you wrote into `backlog` / `next_focus`
- `pr` — PR URL
- `summary` — one paragraph: what slice you audited, what you found, where you pointed the next run

If you get stuck (state file unreadable, no clear next focus, conflicting diff), call `job_needs_input` with the specific question.
