Assess the effectiveness of persona-driven code reviews and tune the persona set over time. This job runs on a recurring schedule, so lean on the state file to pass context between runs and avoid re-evaluating every persona from scratch.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. Persona definitions live in `.dispatch/personas/` as markdown files. Each persona runs as an automated code reviewer on PRs, producing structured feedback via `dispatch_feedback`. The primary codebase conventions are documented in `CLAUDE.md`.

The goal is to keep the persona set effective: tune prompts that are producing noise, wait for data when a prompt just changed, retire personas that consistently underperform, and add new ones only when there's concrete evidence of a recurring gap.

## Phase 0: Read the state file

Read `.dispatch/job-state/persona-review.md` before doing anything else. It contains:

- `last_audited_sha` — the HEAD SHA from the previous run
- `personas` — per-persona tracking with prompt SHA, last assessment, recommendation, and sample size
- `next_focus` — the specific persona or issue the last run recommended you focus on this time
- `backlog` — a prioritized list of deferred work (prompt adjustments, coverage questions, retirement candidates)
- `patterns` — recurring observations about persona effectiveness across the set
- `history` — one-line summaries of what each prior run did

If the state file is missing (first run) or malformed, fall through to the bootstrap pass in Phase 1.

## Phase 1: Scope the work

### Normal run (state file exists with a valid `next_focus`)

1. Read the `next_focus` entry. That is your assignment for this run.
2. Run `git diff --name-only <last_audited_sha>..HEAD` to see what changed since the last run. Check whether any persona files in `.dispatch/personas/` were modified — if so, update tracking for those personas (new `prompt_sha`, reset `post_change_sample_size` to 0).
3. Keep the scope to **one or two personas** per run. If you discover issues with other personas while working, add them to `backlog`.

### Bootstrap run (no state file or first run)

Do a broad assessment to seed the state file. The goal is to produce a baseline for future runs, not to fix everything at once.

1. **Inventory personas.** List all files in `.dispatch/personas/`. For each, record the latest commit SHA touching that file (`git log -1 --format=%H -- .dispatch/personas/<file>`).
2. **Gather recent data.** Call `list_recent_persona_reviews` with `since_days: 14` and `list_recent_feedback` with `since_days: 14` to get a broader initial sample.
3. **Baseline each persona.** For each persona, determine:
   - How many reviews were run and completed
   - How many feedback items were produced
   - Severity distribution
   - Resolution vs dismiss rate
   - A brief qualitative assessment (specific and actionable, or generic/noisy?)
4. **Assess coverage.** Are there recurring classes of feedback or review gaps that no current persona covers?
5. **Write the state file** with per-persona baselines, the top issue as `next_focus`, and everything else in `backlog`. Commit just the state file, open a PR, and merge it.

## Phase 2: Gather data

For normal runs, collect the data needed to evaluate the personas in scope:

1. **Call MCP tools.** Use `list_recent_persona_reviews` and `list_recent_feedback` with `since_days: 7`. Link feedback to reviews by matching `agentId`.
2. **Check for prompt changes.** For each persona in scope, compare the current latest commit SHA on the persona file to the `prompt_sha` stored in the state file. If it changed:
   - Read the commit message and diff to understand what the change was trying to improve
   - Reset that persona's evaluation window — only score reviews produced after the new prompt
   - Note the change in your analysis
3. **Filter the evaluation set.** For each persona in scope:
   - If the prompt changed since the last run, only score reviews/feedback produced after the prompt change
   - If the prompt hasn't changed, score all reviews/feedback from the last 7 days
   - If there are fewer than 3 post-change reviews, flag the sample size as limited

## Phase 3: Analyze

For each persona in scope, assess:

### Signal quality

- Read the actual feedback messages. Are they specific and actionable, or generic/boilerplate?
- Are findings about the actual changes in the diff, or flagging pre-existing issues?
- What's the severity distribution?
- If the prompt changed recently, did the change appear to help with the specific problem it targeted?

### Resolution rate

- What percentage of feedback items got resolved vs dismissed?
- A high dismiss rate suggests noise. A high open rate may mean findings are weak or poorly phrased.

### Patterns

- Is the persona producing repeated boilerplate across different reviews?
- Is it finding meaningful issues?
- Compared with the state file's last assessment, is it improved, unchanged, or worse?

### Coverage (when relevant to scope)

- Are there recurring review gaps that no current persona covers?
- Are any personas producing findings that heavily overlap with another persona?
- Only recommend a new persona when there is concrete evidence of a recurring unmet need — not because a category sounds plausible.

## Phase 4: Decide and act

Use the state file's prior assessment as context, not as the current verdict. Let new data override old conclusions.

- **Keep as-is** if post-change findings are specific, relevant, and frequently resolved.
- **Adjust prompt** if findings are still noisy, generic, badly scoped, or poorly calibrated. Implement the edit directly in `.dispatch/personas/`.
- **Wait for more data** if the persona changed recently and there aren't enough post-change reviews to judge fairly.
- **Consider removing** only if there is enough evidence that the persona consistently produces low-value output across multiple runs. Prefer documenting the rationale first; only delete when the evidence is strong.
- **Consider adding a persona** only if review history shows a recurring gap. Include what gap it covers, what evidence supports it, and whether an existing persona could be widened instead.

If this run's scope and evidence don't support changes, do not churn the persona set. Say so in the report and move on.

## Phase 5: Validate

If persona files were changed:

1. Run `pnpm run check` (TypeScript type checking).
2. Run `pnpm run test:e2e` (Playwright E2E).
3. All checks must pass before proceeding.

## Phase 6: Update the state file

Before committing, rewrite `.dispatch/job-state/persona-review.md` with:

- `last_audited_sha` — current HEAD.
- `personas` — for each persona, update:
  - `prompt_sha` — latest commit SHA touching the persona file
  - `last_assessment` — 1-2 sentence qualitative judgment from this run's evidence (or carried forward if not in scope this run)
  - `recommendation` — keep as-is, adjust prompt, wait for more data, consider removing
  - `post_change_sample_size` — cumulative post-change reviews evaluated across runs. Reset to 0 when `prompt_sha` changes.
  - `notes` — anything the next run should know (limited sample, recently changed, overlaps with another persona)
- `next_focus` — the specific persona or issue the next run should tackle. Be concrete: name the persona, describe what to evaluate, and why.
- `backlog` — remaining items, re-prioritized. Remove completed items. Add new observations. Each entry needs enough context that a future run can act on it.
- `patterns` — observations about persona effectiveness. Add new ones, prune stale ones.
- `history` — append a one-line entry: date, what was assessed or changed, PR number if applicable.

Treat the state file as a handoff note to a colleague, not a log.

## Phase 7: Commit, PR, merge

If no changes were made to persona files (analysis-only run with only a state file update), commit and merge the state file update with a brief PR.

If persona files were changed:

1. Run `pnpm run format:write` to fix formatting.
2. Commit on a new branch. Include the state file update in the same commit.
3. Create a PR targeting `main` with a short body: what was assessed, what changed, what post-change evidence justified the adjustment, and what's queued for the next run.
4. **Launch a reviewer.** Use `dispatch_launch_persona` to launch `architecture-review` with `recheck: true`. Provide context about what persona changes were made and why. If the reviewer requests changes, address them before proceeding.
5. **Wait for CI.** Poll `get_pr_status` in a loop (~60s between polls). Do not call `job_complete` while CI is still running.
6. **Act on the CI result.**
   - **`SUCCESS`** — merge via `gh pr merge <num> --squash --delete-branch`. Verify the PR state is `MERGED` before calling `job_complete`.
   - **`FAILURE`** — read the failed logs (`gh run view <id> --log-failed`). If caused by your diff, fix and push. If a pre-existing flake, try `gh run rerun <id> --failed`. If the retry also fails for unrelated reasons, call `job_needs_input`.

If CI takes longer than 30 minutes, call `job_needs_input`.

## Reporting

Use `job_log` for phase-level progress. Call `job_complete` **only after the PR is merged** (or immediately after merge of the bootstrap state file on first run). Include:

- `summary` — one paragraph: what you assessed or changed, what's next
- `per_persona_assessed` — for each persona in scope: review count, signal quality, resolution rate, recommendation
- `coverage_notes` — any gaps identified or retirement candidates, or "no changes needed"
- `state_file_summary` — what you wrote into `next_focus` and top backlog items
- `pr` — the merged PR URL

If no persona reviews exist in the last 7 days, call `job_complete` with a note that no analysis is possible.
