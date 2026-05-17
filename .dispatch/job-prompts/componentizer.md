Identify oversized React components in the Dispatch frontend and refactor them into smaller, focused pieces. This job runs on a recurring schedule, so lean on the state file to pass context between runs and avoid re-scanning the whole app every time.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. The frontend lives in `apps/web/src/` — a Vite React app using shadcn/ui, Jotai, React Query, and TanStack Router. Codebase conventions are documented in `CLAUDE.md`.

The goal is smaller, more focused component files. Smaller files mean less context an agent needs to load when working on a feature, easier maintenance, and clearer ownership boundaries. This is pure refactoring — never change behavior, add features, or alter UI appearance.

## What qualifies as "too large"

A component file is a candidate when it exhibits one or more of:

- **Line count over ~300 lines** — a strong signal the file is doing too much.
- **Multiple distinct UI regions** — the JSX renders several logically independent sections that could each be their own component.
- **5+ useState/useEffect hooks** — suggests the component owns too much state or orchestrates too many side effects. Some of that logic likely belongs in a custom hook.
- **Deeply nested conditionals in JSX** — 3+ levels of ternaries or conditional blocks making the render tree hard to follow.
- **Mixed concerns** — data fetching, transformation, and presentation all in one file rather than separated into hooks + pure UI.

These are guidelines, not hard rules. A 350-line component that's a single cohesive form may be fine. A 250-line component with three unrelated responsibilities is a candidate.

## Refactoring strategies

Pick the strategy that best fits the component:

1. **Extract subcomponents** — when the JSX has logically independent regions (a header, a list, a detail panel), pull each into its own file in the same directory or a sibling file.
2. **Extract custom hooks** — when logic (data fetching, subscriptions, computed state, form handling) clutters the component, move it into a `use-*.ts` hook file. The component becomes a thin render shell.
3. **Extract constants/types** — when a file has large config objects, type definitions, or static data that obscure the component logic, move them to a dedicated file.
4. **Split compound components** — when a single file exports multiple components (a pattern that grows over time), give each export its own file.

Prefer the smallest extraction that makes a meaningful difference. Don't over-split — two 150-line files are better than six 50-line files if the six have tight cross-dependencies.

## Phase 0: Read the state file

Read `.dispatch/job-state/componentizer.md` before doing anything else. It contains:

- `last_audited_sha` — the HEAD SHA from the previous run
- `next_focus` — the specific component + recommended extraction the last run queued up
- `backlog` — a prioritized list of oversized components with line counts and suggested strategies
- `patterns` — observations about where components tend to bloat in this codebase
- `history` — one-line summaries of what each prior run refactored

If the state file is missing (first run) or malformed, fall through to the bootstrap scan in Phase 1.

## Phase 1: Scope the work

### Normal run (state file exists with a valid `next_focus`)

1. Read the `next_focus` entry. That is your assignment for this run.
2. Run `git diff --name-only <last_audited_sha>..HEAD` to check if someone already refactored that component. If so, skip it, pick the top item from `backlog`, and note the skip in the state file.
3. Keep the scope to **one component** per run. If you discover related bloat while working, add it to `backlog`.

### Bootstrap run (no state file or first run)

Do a scan to seed the state file. Do **not** refactor anything yet — the goal is to produce a prioritized backlog for future runs.

1. Find all `.tsx` files in `apps/web/src/` over 250 lines: `find apps/web/src -name '*.tsx' -exec wc -l {} + | sort -rn`
2. For each file over 300 lines, briefly assess which refactoring strategy would apply and how impactful the split would be.
3. Prioritize by: (a) files that agents touch most often (route components, shared UI), (b) worst offenders by line count, (c) clearest extraction path (low-risk splits first).
4. Skip files that are large by nature and don't benefit from splitting: generated code, test fixtures, single complex forms that are genuinely cohesive.
5. Write the state file with the top candidate as `next_focus` and the rest in `backlog`. Commit just the state file, open a PR with the scan summary, and merge it.

## Phase 2: Refactor the component

For normal runs (not bootstrap):

1. **Understand before touching.** Read the component, trace its imports and consumers, check if it has tests. Understand what it renders and why.
2. **Plan the split.** Decide exactly what to extract and where each piece goes. New files should follow existing naming conventions in the same directory.
3. **Execute the refactoring.** Move code, update imports, ensure all consumers still work. The refactoring must be purely structural — the rendered output and behavior must be identical.
4. **Verify no behavior change.** The app should look and function exactly the same after your change. If you're unsure whether an extraction changes behavior, don't do it.

If a refactoring turns out to be riskier than expected (component is tightly coupled to global state, used by many consumers, has subtle timing dependencies), stop and call `job_needs_input` explaining what you found.

## Phase 3: Validate

1. Run `pnpm run finalize:web` (type check + production build).
2. Run `pnpm run test:e2e` (Playwright E2E).
3. All checks must pass. Fix any failures your changes introduced.
4. If the refactored component has a clear UI path, validate it visually via Playwright (navigate to the page, confirm it renders correctly, take a screenshot).

## Phase 4: Update the state file

Before committing, rewrite `.dispatch/job-state/componentizer.md` with:

- `last_audited_sha` — current HEAD.
- `next_focus` — the specific component the next run should tackle. Be concrete: include the file path, current line count, and the recommended extraction strategy.
- `backlog` — remaining candidates, re-prioritized if needed. Remove the one you just refactored. Add any new candidates you noticed. Each entry needs: file path, line count, and a brief note on what to extract.
- `patterns` — observations about where bloat accumulates. Add new ones, prune stale ones.
- `history` — append a one-line entry: date, what was refactored, PR number.

Treat the state file as a handoff note to a colleague, not a log.

## Phase 5: Commit, PR, merge

This phase is not done until **CI is green and the PR is merged**. `job_complete` must only be called after a successful merge.

1. Run `pnpm run format:write` to fix formatting in files you touched.
2. Commit on a new branch. Include the state file update in the same commit.
3. Create a PR targeting `main` with a short body: what was split, why it was a candidate, what the new file structure looks like, and what's queued for the next run.
4. **Launch a reviewer.** After the PR is open, use `dispatch_launch_persona` to launch **one** review persona with `recheck: true`. Use `architecture-review` for structural splits or `frontend-ux-review` if the extraction touches interaction logic or layout. Provide thorough context: what was extracted, why, and that behavior should be identical. If the reviewer requests changes, address them before proceeding.
5. **Wait for CI.** Poll `get_pr_status` in a loop (~60s between polls). Do not call `job_complete` while CI is still running.
6. **Act on the CI result.**
   - **`SUCCESS`** — merge the PR via `gh pr merge <num> --squash --delete-branch`. Verify the PR state is `MERGED` before calling `job_complete`.
   - **`FAILURE`** — read the failed logs (`gh run view <id> --log-failed`). If the failure is caused by your diff, fix it, push, and re-poll. If it's a pre-existing flake, try `gh run rerun <id> --failed` and re-poll. If the retry also fails for unrelated reasons, call `job_needs_input` with the run URL and failure summary.

If CI takes longer than 30 minutes, call `job_needs_input`.

## Reporting

Use `job_log` for phase-level progress. Call `job_complete` **only after the PR is merged** (or immediately after merge of the bootstrap state file on first run). Include:

- `summary` — one paragraph: what you refactored (or scanned on bootstrap), what's next
- `files_updated` / `files_created` / `files_deleted` as applicable
- `state_file_summary` — what you wrote into `next_focus` and the top 3 backlog items
- `pr` — the merged PR URL
