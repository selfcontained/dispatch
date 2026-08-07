Audit Dispatch's documentation against the actual codebase and fix anything that has drifted. This job runs on a recurring schedule, so lean on the Brain shared memory to pass context between runs and avoid re-auditing from scratch every time.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. Only check docs against the Dispatch codebase and its actual behavior. The primary user-facing documentation lives **in the app** at `apps/web/src/components/app/docs-pane.tsx` — that's the most important surface to keep accurate. Top-level files (`README.md`, `CLAUDE.md`, `AGENTS.md`) and the `docs/` folder are secondary.

## Phase 0: Read the state from the Brain

State is spread across purpose-specific brain primitives to keep writes minimal:

1. **Core state** (collection: `docs-audit`, name: `state`) — read with `brain_get_object`. **Save the `revision`** for `expectedRevision` in Phase 4.
   - `last_audited_sha` — the HEAD SHA from the previous run
   - `next_focus` — the specific area the last run recommended you focus on this time

2. **Backlog** (collection: `docs-audit`, name: `backlog`) — read with `brain_list_get`. Items noticed during prior passes but left for later runs. Managed via `brain_list_push` / `brain_list_remove` — never regenerate the full array.

3. **Patterns** (collection: `docs-audit`, name: `patterns`) — read with `brain_list_get`. Recurring observations about where docs tend to go stale. Managed via `brain_list_push` / `brain_list_remove` — most runs won't touch it.

4. **Run history** — query with `brain_query_events(collection: "docs-audit", kind: "run", subject: "docs-audit", limit: 5)`. Read-only context — useful for PR descriptions and avoiding duplicate work.

If the core state object is not found (first run), fall through to a bootstrap full pass (see Phase 5 fallback), log what you found, and seed the Brain at the end.

## Phase 1: Scope the work

Do **not** inventory the whole codebase from scratch. Scope each run to a small, focused slice:

1. Run `git diff --name-only <last_audited_sha>..HEAD` to find what's actually changed since the last audit. Map those file paths to the docs that describe them.
2. Pick **one** deep-dive area from `next_focus` in the core state (or the top item in the backlog list if `next_focus` is empty).
3. If `last_audited_sha` is missing, invalid, or older than 30 days, also spot-check the sections flagged in `patterns` — those are the ones that keep rotting.

Keep the run's scope deliberately narrow. A small, correct PR every night beats a sprawling one once a week.

- If `next_focus` feels too big for one night, split it and push half back into the backlog list with a concrete description.
- Treat each run as one focused slice. Recent passes all fit comfortably in one PR each. Aim for that size.
- If you notice something that isn't drift but is genuinely missing, add it to the backlog list with enough detail that a future run can act on it without re-discovering the context.
- When the diff since `last_audited_sha` includes a meaningful UI change, it's reasonable to pivot away from `next_focus` to handle the diff-driven update first.

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

## Phase 2b: Check ambient tips for gaps

Dispatch has a guided tips system that surfaces feature discovery hints in the UI. Tips are defined in `apps/web/src/lib/tips/tips.ts`. Each tip has an `id`, `title`, `body`, optional `docsSection` link, `since` version, and `surfaces` array.

When your Phase 1 diff or deep-dive area touches a feature that has no corresponding ambient tip, consider whether adding one would genuinely help an end user discover or understand that feature. Not every feature needs a tip — only add one if:

- The feature is non-obvious or easy to miss (e.g. a keyboard shortcut, a settings toggle, a capability that isn't surfaced in the main UI chrome).
- A short sentence or two would meaningfully help someone who doesn't know the feature exists.
- There isn't already a tip that covers the same ground.

Do **not** add tips for internal implementation details, developer-facing APIs, or features that are self-evident from the UI. The bar is "would an end user benefit from being told about this?" — if the answer is marginal, skip it.

When you do add a tip, follow the existing format in `tips.ts`. Set `since` to the current release version (check `package.json`). Use `surfaces: ["ambient"]` unless you're also wiring up an inline `TipSpot` placement (which is a separate code change). Keep the `body` concise — it renders in a small footer bar. Link `docsSection` to the matching in-app docs section if one exists.

## Phase 3: Audit secondary docs (only as needed)

Only touch these if the Phase 1 diff points to them or they're explicitly in `next_focus`:

- `README.md` — features list, setup commands, MCP tools summary, docs index, Quick Install prompt.
- `CLAUDE.md` / `AGENTS.md` — project structure tree, scripts, paths. Keep these in sync with each other.
- `docs/03-api-spec.md` — API endpoint reference (developer-facing, not duplicated in app).
- `docs/04-agent-lifecycle.md` — state machine, tmux contract, reconciliation (developer-facing).
- `docs/10-operations-runbook.md` — service management, releases, diagnostics.
- `docs/11-backend-compatibility-checklist.md` — dev checklist.
- `docs/14-theming.md` — theme authoring guide.

Do not rewrite docs for style. Fix factual drift only.

## Phase 4: Update the state in the Brain

**Core state** — use `brain_store_object` (collection: `docs-audit`, name: `state`) with the `expectedRevision` from Phase 0. Updated every run. Only two fields:

- `last_audited_sha` — current HEAD (the commit you're about to create will supersede this when it lands).
- `next_focus` — the specific area the next run should start with. Be concrete ("audit docs-pane Worktrees section against `packages/shared/src/git/worktree.ts`") rather than vague ("check worktrees").

**Backlog** — use list operations (collection: `docs-audit`, name: `backlog`). Do not rewrite the full list — use surgical mutations:

- `brain_list_remove` — remove items you addressed or that are no longer relevant.
- `brain_list_push` — add any new issues you noticed but deferred. Each item is a JSON object with a `description` field (e.g., `{"description": "..."}`). Each entry should have enough context that a future run can act on it without re-discovering the problem. Set `maxItems: 30` so the oldest items roll off if the list grows too large.

**Patterns** — use list operations (collection: `docs-audit`, name: `patterns`). Each item is a JSON object with a `description` field. Use `brain_list_push` to add new observations (with `maxItems: 50` so the oldest roll off) and `brain_list_remove` to prune stale ones. Skip if patterns didn't change.

**Run event** — log this run using `brain_append_event`:

- collection: `docs-audit`
- kind: `run`
- subject: `docs-audit`
- value: `{ "date": "<today>", "summary": "<one-line summary of what was audited and fixed>", "pr": "<PR number>" }`

This keeps writes minimal — the core object is just two fields of new content, backlog mutations are surgical, and full history lives in the append-only event log.

## Phase 5: Validate, commit, PR, merge

This phase is not done until **CI is green and the PR is merged**. Opening a PR is the halfway point, not the finish line. `job_complete` must only be called after a successful merge (or after `job_needs_input` if you are legitimately blocked).

1. Run `pnpm run format:write` to fix any prettier drift in files you touched (`pnpm run format` only checks — it won't rewrite). CI enforces `prettier --check` and will fail the PR otherwise.
2. If `apps/web/` changed, run `pnpm run check` (docs-only changes generally don't need it).
3. Verify any `docs/` links in `README.md` still resolve.
4. Commit on a new branch. The PR should only contain code changes — Brain state is stored externally, not in git.
5. Create a PR targeting `main` with a short body: what was audited, what changed, and what's deferred to next run.
6. **Wait for CI.** Poll `get_pr_status` for this PR in a loop. Each check costs almost nothing; keep polling until the `ci` check's `status` leaves `IN_PROGRESS` and a `conclusion` appears. A typical CI run is 3-5 minutes — sleep ~60s between polls. Do not call `job_complete` while CI is still running.
7. **Act on the CI result.**
   - **`SUCCESS`** — merge the PR. Use the `create_pr` tool's companion merge path or shell out to `gh pr merge <num> --squash --delete-branch`. After merge, verify the PR's state is `MERGED` via `get_pr_status` before calling `job_complete`.
   - **`FAILURE`** — read the failed job logs (`gh run view <id> --log-failed`). Classify the failure:
     - **Caused by your diff** (e.g. prettier drift you missed, broken markdown link, type error in a file you edited): fix it, push, and return to step 6. Stay in the loop — don't give up.
     - **Pre-existing flake or environmental problem** (failing tests in files you never touched; infra errors like a runner going offline; a known-flaky test that retries cleanly): first try `gh run rerun <id> --failed` and re-poll. If the retry also fails for the same unrelated reason, stop here and call `job_needs_input` with the run URL and a one-line summary of what failed. Do not merge a red PR. Do not silently abandon the PR either.

If CI takes longer than 30 minutes without completing, call `job_needs_input` — something upstream is wrong.

### Bootstrap fallback

If the core state object is missing (first run) or clearly out of sync, do a shallow pass: skim each in-app docs section and each top-level README/CLAUDE section, note observations in the new Brain state, and fix only the most obviously broken claims. Leave the rest for subsequent runs. Do not attempt a full rewrite in a single night.

## Reporting

Use `job_log` for phase-level progress. Call `job_complete` **only after the PR is merged** (or immediately if Phase 1 scoping found genuinely nothing to change and no PR was opened). `job_complete` with:

- `files_updated` — paths + brief change notes
- `files_created` / `files_deleted`
- `state_summary` — what you wrote into `next_focus` and the top 3 backlog items
- `pr` — PR URL (the merged PR)
- `summary` — one paragraph: what slice you audited, what you found, where you pointed the next run

If you get stuck (state unreadable, no clear next focus, conflicting diff, CI failing for reasons outside this diff), call `job_needs_input` with the specific question and any relevant URLs — never call `job_complete` on a PR that's still open or red.
