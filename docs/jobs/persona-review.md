Assess the effectiveness of persona-driven code reviews and tune the persona set over time. This job runs on a recurring schedule, so lean on the Brain shared memory to pass context between runs and avoid re-evaluating every persona from scratch.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. Persona definitions live in `.dispatch/personas/` as markdown files. Each persona runs as an automated code reviewer on PRs, producing a tracked review via `dispatch_review_submit`. The primary codebase conventions are documented in `CLAUDE.md`.

The goal is to keep the persona set effective: tune prompts that are producing noise, wait for data when a prompt just changed, retire personas that consistently underperform, and add new ones only when there's concrete evidence of a recurring gap.

## Phase 0: Read the state from the Brain

State is spread across purpose-specific brain primitives to keep writes minimal:

1. **Core state** (collection: `persona-review`, name: `state`) — read with `brain_get_object`. **Save the `revision`** for `expectedRevision` in Phase 6.
   - `last_audited_sha` — the HEAD SHA from the previous run
   - `personas` — per-persona tracking keyed by persona name. Each value stores:
     - `prompt_sha`
     - `last_assessment`
     - `recommendation`
     - `post_change_sample_size`
     - `notes`
   - `next_focus` — the specific persona or issue the last run recommended you focus on this time

2. **Backlog** (collection: `persona-review`, name: `backlog`) — read with `brain_list_get`. Prioritized deferred work items. Managed via `brain_list_push` / `brain_list_remove` — never regenerate the full array. Each item is a JSON object with a `description` field.

3. **Patterns** (collection: `persona-review`, name: `patterns`) — read with `brain_list_get`. Recurring observations about persona effectiveness. Managed via `brain_list_push` / `brain_list_remove` — most runs won't touch it. Each item is a JSON object with a `description` field.

4. **Run history** — query with `brain_query_events(collection: "persona-review", kind: "run", subject: "persona-review", limit: 5)`. Read-only context for recent decisions and PR summaries.

If the core state object is not found (first run), fall through to the bootstrap pass in Phase 1.

## Phase 1: Scope the work

### Normal run (state exists with a valid `next_focus`)

1. Read the `next_focus` entry. That is your assignment for this run.
2. Run `git diff --name-only <last_audited_sha>..HEAD` to see what changed since the last run. Check whether any persona files in `.dispatch/personas/` were modified — if so, update tracking for those personas (new `prompt_sha`, reset `post_change_sample_size` to 0).
3. Keep the scope to **one or two personas** per run. If you discover issues with other personas while working, add them to `backlog`.

### Bootstrap run (no state in Brain or first run)

Do a broad assessment to seed the Brain. The goal is to produce a baseline for future runs, not to fix everything at once.

1. **Inventory personas.** List all files in `.dispatch/personas/`. For each, record the latest commit SHA touching that file (`git log -1 --format=%H -- .dispatch/personas/<file>`).
2. **Gather recent data.** Call `get_agent_history` for the last 14 days with feedback and reviews included, paging until the sample is complete. Call `get_feedback_summary` for the same range to get aggregate patterns.
3. **Baseline each persona.** For each persona, determine:
   - How many reviews were run and completed
   - How many feedback items were produced
   - Severity distribution
   - Resolution vs dismiss rate
   - A brief qualitative assessment (specific and actionable, or generic/noisy?)
4. **Assess coverage.** Are there recurring classes of feedback or review gaps that no current persona covers?
5. **Seed the Brain** with per-persona baselines in the core state object, the top issue as `next_focus`, everything else in the backlog list, and any recurring themes in the patterns list.

## Phase 2: Gather data

For normal runs, collect the data needed to evaluate the personas in scope:

1. **Call MCP tools.** Use `get_agent_history` for the last 7 days with feedback and reviews included. Use `get_feedback_summary` for aggregate patterns.
2. **Check for prompt changes.** For each persona in scope, compare the current latest commit SHA on the persona file to the `prompt_sha` stored in the core state object. If it changed:
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
- Compared with the core state's last assessment, is it improved, unchanged, or worse?

### Coverage (when relevant to scope)

- Are there recurring review gaps that no current persona covers?
- Are any personas producing findings that heavily overlap with another persona?
- Only recommend a new persona when there is concrete evidence of a recurring unmet need — not because a category sounds plausible.

## Phase 4: Decide and act

Use the core state's prior assessment as context, not as the current verdict. Let new data override old conclusions.

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

## Phase 6: Update the state in the Brain

Before committing, update Brain state instead of writing a file:

**Core state** — use `brain_store_object` (collection: `persona-review`, name: `state`) with the `expectedRevision` from Phase 0. Updated every run. Store:

- `last_audited_sha` — current HEAD.
- `personas` — for each persona, update:
  - `prompt_sha` — latest commit SHA touching the persona file
  - `last_assessment` — 1-2 sentence qualitative judgment from this run's evidence (or carried forward if not in scope this run)
  - `recommendation` — keep as-is, adjust prompt, wait for more data, consider removing
  - `post_change_sample_size` — cumulative post-change reviews evaluated across runs. Reset to 0 when `prompt_sha` changes.
  - `notes` — anything the next run should know (limited sample, recently changed, overlaps with another persona)
- `next_focus` — the specific persona or issue the next run should tackle. Be concrete: name the persona, describe what to evaluate, and why.

**Backlog** — use list operations (collection: `persona-review`, name: `backlog`). Do not rewrite the full list — use surgical mutations:

- `brain_list_remove` — remove items you addressed or that are no longer relevant.
- `brain_list_push` — add new deferred items as `{"description": "..."}` with enough context for a future run to act on them. Set `maxItems: 30` so the oldest items roll off automatically.

**Patterns** — use list operations (collection: `persona-review`, name: `patterns`).

- `brain_list_remove` — prune stale observations when needed.
- `brain_list_push` — add new observations as `{"description": "..."}`. Set `maxItems: 50` so the oldest items roll off automatically.

**Run event** — log this run using `brain_append_event`:

- collection: `persona-review`
- kind: `run`
- subject: `persona-review`
- value: `{ "date": "<today>", "summary": "<one-line summary of what was assessed or changed>", "pr": "<PR number or null>" }`

Treat the Brain state as a handoff note to a colleague, not a log.

## Phase 7: Commit, PR, merge

If no persona files were changed (analysis-only run), do **not** open a repo PR just to persist Brain state. Call `job_complete` after the Brain update and explain what was assessed and what the next run should do.

If persona files were changed:

1. Run `pnpm run format:write` to fix formatting.
2. Commit on a new branch. The PR should only contain persona prompt changes — Brain state is stored externally, not in git.
3. Create a PR targeting `main` with a short body: what was assessed, what changed, what post-change evidence justified the adjustment, and what's queued for the next run.
4. **Launch a reviewer.** Use `dispatch_launch_persona` to launch `architecture-review`. Provide context about what persona changes were made and why. If the reviewer submits feedback, address each tracked item before proceeding.
5. **Wait for CI.** Poll `get_pr_status` in a loop (~60s between polls). Do not call `job_complete` while CI is still running.
6. **Act on the CI result.**
   - **`SUCCESS`** — merge via `gh pr merge <num> --squash --delete-branch`. Verify the PR state is `MERGED` before calling `job_complete`.
   - **`FAILURE`** — read the failed logs (`gh run view <id> --log-failed`). If caused by your diff, fix and push. If a pre-existing flake, try `gh run rerun <id> --failed`. If the retry also fails for unrelated reasons, call `job_needs_input`.

If CI takes longer than 30 minutes, call `job_needs_input`.

## Reporting

Use `job_log` for phase-level progress. Call `job_complete` after the Brain state is updated and any required PR is merged. Include:

- `summary` — one paragraph: what you assessed or changed, what's next
- `per_persona_assessed` — for each persona in scope: review count, signal quality, resolution rate, recommendation
- `coverage_notes` — any gaps identified or retirement candidates, or "no changes needed"
- `state_summary` — what you wrote into `next_focus` and top backlog items
- `pr` — the merged PR URL, or `null` for analysis-only runs with no repo changes

If no persona reviews exist in the last 7 days, call `job_complete` with a note that no analysis is possible.
