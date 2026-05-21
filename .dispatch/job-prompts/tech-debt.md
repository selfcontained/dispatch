Identify and fix tech debt in the Dispatch codebase, one focused area per run. This job runs on a recurring schedule, so lean on the Brain shared memory to pass context between runs and avoid re-auditing from scratch every time.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. It is a pnpm monorepo with a Fastify backend (`apps/server/`) and a Vite React frontend (`apps/web/`). The primary codebase conventions are documented in `CLAUDE.md`.

Tech debt here means code that works but is unnecessarily hard to maintain, extend, or understand — dead code, duplicated logic, inconsistent patterns, missing types, stale dependencies, TODO/FIXME/HACK markers, overly complex functions, and similar issues. This is housekeeping, not feature work. Do not change behavior, add features, or refactor for aesthetics.

## Phase 0: Read the state from the Brain

State is split across two Brain objects to keep writes small and fast:

1. **Core state** (collection: `job-state`, name: `tech-debt`) — read with `brain_get_object`. **Save the `revision`** for `expectedRevision` in Phase 4.
   - `last_audited_sha` — the HEAD SHA from the previous run
   - `next_focus` — the specific area/issue the last run recommended you tackle this time
   - `backlog` — a prioritized list of issues found during prior audits but deferred
   - `history` — the last 5 run summaries (older runs are in the event log: collection `job-state`, kind `run`, subject `tech-debt`)

2. **Patterns** (collection: `job-state`, name: `tech-debt-patterns`) — read with `brain_get_object`. Save its `revision` too if you plan to update it.
   - `patterns` — recurring observations about where debt accumulates in this codebase
   - Only update this object when you have a new pattern to add or a stale one to prune. Most runs won't touch it.

If the object is not found (first run or Brain migration hasn't happened), fall through to the bootstrap audit in Phase 1.

> **Deprecated fallback:** The old filesystem state file `.dispatch/job-state/tech-debt.md` still exists but is no longer the source of truth. It will be removed after the Brain path is validated in a real run.

## Phase 1: Scope the work

### Normal run (state exists with a valid `next_focus`)

1. Read the `next_focus` entry. That is your assignment for this run — fix that one issue or area.
2. Run `git diff --name-only <last_audited_sha>..HEAD` to see what changed since the last run. If the `next_focus` area was already addressed by another commit, skip it, pick the top item from `backlog`, and note that in the state update.
3. Keep the scope to **one focused fix**. If you discover related issues while working, add them to `backlog` — do not fix them in the same PR.

### Bootstrap run (no state in Brain or first run)

Do a broad audit to seed the state. Do **not** fix anything yet — the goal is to produce a prioritized backlog for future runs.

1. **Dead code scan.** Look for unused exports, unreferenced files, commented-out blocks, and unused dependencies. Focus on `apps/server/src/` and `apps/web/src/`.
2. **TODO/FIXME/HACK markers.** Grep for `TODO`, `FIXME`, `HACK`, `XXX`, `TEMP`, and `WORKAROUND` across the codebase. Record each with file, line, and the marker text.
3. **Type gaps.** Look for `any` casts, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, and untyped function parameters in core modules (not test files).
4. **Duplication.** Identify obviously duplicated logic — functions that do the same thing in different files, copy-pasted blocks, near-identical utility helpers.
5. **Complexity hotspots.** Note files over ~400 lines or functions over ~80 lines that could benefit from extraction. Don't count generated files, migrations, or test fixtures.
6. **Stale dependencies.** Check `package.json` files for dependencies that appear unused (not imported anywhere).
7. **Inconsistent patterns.** Note places where the same concept is handled differently across the codebase (e.g., error handling, logging, config access).

Organize findings into a prioritized backlog (highest-impact / lowest-risk items first). Store the state in the Brain using `brain_store_object` (collection: `job-state`, name: `tech-debt`) with the top item as `next_focus` and everything else in `backlog`. Open a PR with the audit summary and merge it.

## Phase 2: Fix the issue

For normal runs (not bootstrap), implement the fix:

1. Understand the issue fully before changing anything. Read the relevant code, trace callers and consumers, check tests.
2. Make the minimal change that addresses the issue. Do not refactor surrounding code or "improve" things you happen to notice.
3. If the fix turns out to be risky (touches a hot path, changes a public interface, could break other agents), stop and call `job_needs_input` explaining what you found and asking whether to proceed.
4. If the fix is trivial but the issue was mis-categorized (it's actually a feature gap, not debt), skip it, move it out of backlog, and pick the next item. Note the skip in the state update.

## Phase 3: Validate

1. Run `pnpm run check` (TypeScript type checking).
2. If `apps/web/` files changed, run `pnpm run finalize:web`.
3. Run `pnpm run test:e2e` (Playwright E2E).
4. Run `pnpm run test` (Vitest) if backend files changed.
5. All checks must pass before proceeding. Fix any failures your changes introduced.

## Phase 4: Update the state in the Brain

**Core state** — use `brain_store_object` (collection: `job-state`, name: `tech-debt`) with the `expectedRevision` from Phase 0. Updated every run.

- `last_audited_sha` — current HEAD.
- `next_focus` — the specific issue the next run should tackle. Be concrete: include file paths, line numbers, and a brief description of what to do. If the backlog is empty, describe what area to re-audit next.
- `backlog` — remaining items, re-prioritized if needed. Remove the item you just fixed. Add any new issues you discovered. Each entry should have enough context that a future run can act on it without re-discovering the problem.
- `history` — keep only the **last 5 entries**. Drop older ones — they live in the event log (see below).

**Patterns** — use `brain_store_object` (collection: `job-state`, name: `tech-debt-patterns`) with its own `expectedRevision`. Only update when you have a new pattern to add or a stale one to prune. Skip this write if patterns didn't change.

**Run event** — log this run using `brain_append_event`:

- collection: `job-state`
- kind: `run`
- subject: `tech-debt`
- value: `{ "date": "<today>", "summary": "<one-line summary of what was fixed>", "pr": "<PR number>" }`

This keeps the core write small and fast while preserving full history in the append-only event log. To review older runs, query `brain_query_events` with collection `job-state`, kind `run`, subject `tech-debt`.

## Phase 5: Commit, PR, merge

This phase is not done until **CI is green and the PR is merged**. `job_complete` must only be called after a successful merge.

1. Run `pnpm run format:write` to fix formatting in files you touched.
2. Commit on a new branch. The PR should only contain code changes — Brain state is stored externally, not in git.
3. Create a PR targeting `main` with a short body: what was fixed, why it qualifies as tech debt, and what's queued for the next run.
4. **Launch a reviewer.** After the PR is open, use `dispatch_launch_persona` to launch **one** review persona with `recheck: true`. Pick the best fit based on what you changed:
   - `architecture-review` — structural refactors, module boundaries, dependency changes
   - `backend-security-review` — anything touching auth, API routes, data handling, or env vars
   - `frontend-ux-review` — UI component changes, style updates, accessibility
   - `infra-review` — build config, CI, deployment, dev tooling
     Provide thorough context in the `context` parameter: what was changed, why, and what is NOT in scope (pre-existing issues). If the reviewer requests changes, address them and push before proceeding.
5. **Wait for CI.** Poll `get_pr_status` in a loop (~60s between polls). Do not call `job_complete` while CI is still running.
6. **Act on the CI result.**
   - **`SUCCESS`** — merge the PR via `gh pr merge <num> --squash --delete-branch`. Verify the PR state is `MERGED` before calling `job_complete`.
   - **`FAILURE`** — read the failed logs (`gh run view <id> --log-failed`). If the failure is caused by your diff, fix it, push, and re-poll. If it's a pre-existing flake, try `gh run rerun <id> --failed` and re-poll. If the retry also fails for unrelated reasons, call `job_needs_input` with the run URL and failure summary.

If CI takes longer than 30 minutes, call `job_needs_input`.

## Reporting

Use `job_log` for phase-level progress. Call `job_complete` **only after the PR is merged** (or immediately after storing the bootstrap state in the Brain on first run). Include:

- `summary` — one paragraph: what you fixed (or audited on bootstrap), what's next
- `tasks` — one task per phase completed, with status and summary
- `files_updated` / `files_created` / `files_deleted` as applicable
- `state_summary` — what you wrote into `next_focus` and the top 3 backlog items
- `pr` — the merged PR URL
