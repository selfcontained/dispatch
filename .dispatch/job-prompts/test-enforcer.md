Keep Dispatch's local test signal trustworthy.

Restore local test health first. Fix flaky tests when found. If the suite is green, spend the remaining effort on the highest-value missing coverage.

This job runs on a recurring schedule, so lean on the state file to avoid rediscovering the same failures, flakes, and coverage gaps every run.

## Important context

Dispatch is a local-first control plane for running and managing multiple AI coding agents. Treat this as a recurring maintenance job, not a one-off coding session. Use the state file to carry forward what was fixed, what was deferred, and what the next run should focus on.

## Phase 0: Read the state file

Read `.dispatch/job-state/test-enforcer.md` before doing anything else. It contains:

- `last_audited_sha` — the HEAD SHA from the previous run
- `last_coverage_summary` — the most recent useful coverage snapshot and notable deltas
- `recent_flakes` — flaky tests or local-only failures seen recently, plus what was learned
- `backlog` — worthwhile follow-up coverage or reliability work that prior runs deferred
- `next_focus` — the specific area the last run recommended you start with this time
- `history` — one-line summaries of what each prior run fixed

If the state file is missing or malformed, bootstrap it during this run and keep the scope modest.

## Success criteria

- The local suite passes consistently by the end of the run, or every remaining failure is clearly classified with the smallest safe next step.
- Flaky tests are treated as defects and fixed when reasonably possible.
- Simple real product bugs exposed by the suite are fixed directly.
- Non-trivial real product bugs result in a Linear ticket and are called out in the final report.
- When the suite is green, the highest-value missing unit or E2E coverage is added without creating noisy or brittle tests.
- If this run produces code changes, the work is not complete until the changes are committed, pushed, opened as a PR, CI is green, and the PR is merged.

## Phase 1: Scope the run

Do not treat every run as a fresh audit of the whole test surface.

1. Read `next_focus` in the state file. That is the default assignment for this run.
2. Run `git diff --name-only <last_audited_sha>..HEAD` to see what changed since the previous run.
3. If `next_focus` was already handled by newer commits, skip it, pick the top relevant item from `backlog`, and note that in the state file update.
4. If the suite is red locally, stability work overrides `next_focus`.
5. If the suite is already green, use `next_focus`, `backlog`, and recent diffs to decide where the highest-value coverage or flake-reduction work is.

## Priority order

1. Restore local test health.
2. Remove or reduce flakiness.
3. Add meaningful coverage after the suite is stable.
4. If changes were made, land them completely.

Do not spend meaningful time adding coverage while unresolved local failures still need action.

## Operating rules

- Treat local failures as real until proven otherwise.
- Do not dismiss a failing local test as pre-existing just because CI may pass.
- Investigate each failure enough to classify it as one of:
  - test bug
  - flaky or environment-sensitive test
  - real product bug
  - obsolete or incorrect test
  - infrastructure issue unrelated to product behavior
- Prefer deterministic fixes over retries, sleeps, or widened timeouts.
- Prefer fixing test design over weakening assertions.
- Keep changes scoped to test health and coverage unless a simple product bug fix is needed.
- Do not skip, quarantine, or disable a flaky test unless explicitly instructed.
- Do not end the run with a human handoff like "push this", "open a PR", or "review this" when you can complete those steps yourself.
- Do not use a specialized E2E review persona for the final review pass. Use one general review agent that inspects the actual diff from this run.

## Dispatch behavior

- Rename the session to a short stable name for the run.
- Emit `dispatch_event` status updates as work shifts.
- Use `job_log` for task-level progress during triage, fixes, reruns, coverage work, and PR/CI follow-through.
- End with exactly one terminal tool call: `job_complete`, `job_failed`, or `job_needs_input`.
- The terminal report must include a concise summary plus task entries for failures investigated, fixes made, tickets created, coverage work completed, and PR outcome.

## Required execution flow

1. Run:
   - `pnpm run check`
   - `pnpm run test`
   - `pnpm run test:e2e`
   - If any file under `apps/web/` changes during the run, also run `pnpm run finalize:web`
2. Triage every failure from the first full run.
3. Fix failures and flakiness.
4. Re-run the affected tests, then the relevant full commands again to confirm stability.
5. Once the suite is green, look for the highest-value coverage gaps.
6. Add targeted tests.
7. Re-run the affected suites and final validation commands.
8. If files changed, launch exactly one review agent to review only the diff from this run.
   - the review agent should focus on correctness issues, flaky-test risk, cleanup leakage, and over-scoped or low-value test additions
   - if it finds actionable issues, fix them and re-run the relevant validation before continuing
   - do not launch multiple reviewers
   - do not turn review into an open-ended loop; one review round is enough
9. If files changed, complete the landing flow:
   - commit the changes on the job branch
   - push the branch
   - create a PR targeting `main`
   - wait for CI to finish
   - if CI fails because of your diff, fix it, push again, and keep polling
   - if CI fails for a likely unrelated flake, retry once and re-check
   - merge the PR only after CI is green

If required tooling, credentials, or environment capabilities are missing, document that precisely and use the appropriate terminal job report.

## State file update

Before committing, rewrite `.dispatch/job-state/test-enforcer.md` with:

- `last_audited_sha` — current HEAD
- `last_coverage_summary` — concise snapshot of overall coverage and any meaningful movement observed this run
- `recent_flakes` — current list of flaky tests or local-only failure patterns worth remembering, with brief notes on fixes or hypotheses
- `backlog` — worthwhile reliability or coverage work intentionally deferred; remove completed items and re-prioritize the rest
- `next_focus` — the specific area the next run should start with; be concrete about file paths, tests, or workflows
- `history` — append a one-line entry for this run: date, what was fixed, what coverage was added, and PR number if applicable

Treat the state file as a handoff note to a colleague, not a log dump.

## Flaky test policy

If you find a flaky test, fix the source of nondeterminism.

Check for:

- state leakage between tests
- incomplete teardown or cleanup
- race conditions
- seeded-data drift
- implicit timing assumptions
- stale or fragile selectors
- fixture coupling
- unscoped shared resources

Prefer:

- stronger setup and teardown
- explicit readiness signals
- better fixtures or seeded data
- isolated state boundaries
- cleanup verification
- sharper assertions tied to real behavior

Avoid:

- retries without cause
- broad timeout increases without specific justification
- generic sleeps

## Unit test guidance

Be liberal with unit coverage when it increases confidence cheaply.

Prioritize unit tests for:

- pure logic
- reducers and state transitions
- validation and error handling
- data shaping
- bug fixes made during the run
- branch and edge-case behavior likely to regress

Avoid redundant tests that only restate implementation details without protecting behavior.

## E2E test guidance

Be conservative with E2E coverage. Add an E2E test only when it validates a valuable scenario that unit tests would not cover well enough.

Strong reasons to add E2E coverage:

- multi-step user workflows
- integration boundaries across layers
- persistence or reload behavior
- cleanup behavior
- historically regressed behavior
- scenarios where unit coverage would miss wiring or orchestration failures

Weak reasons to add E2E coverage:

- trivial UI toggles
- isolated presentational checks
- simple on-off assertions for one control

When adding E2E coverage:

- use seeded or mocked data whenever possible
- do not spawn live agents
- avoid unnecessary real background work or nondeterministic flows
- clean up any worktrees or persistent artifacts created during the test
- choose the correct suite:
  - parallel suite for isolated tests that can run concurrently
  - sequential suite for tests that require serialized resources or shared mutable state
- explain briefly in the report why unit coverage alone was not sufficient

## Bug fix vs Linear ticket rubric

Fix the product bug directly only when all of the following are true:

- the fix is small and local
- the expected behavior is already clear
- the risk of regression is low
- the change does not require meaningful refactoring
- the fix can be validated within this run

Create a Linear ticket instead when any of the following are true:

- the fix requires broader refactoring
- the expected behavior is unclear or needs product judgment
- the issue spans multiple subsystems
- the state model or persistence behavior is risky to change quickly
- the problem is real but cannot be closed confidently inside this run

When creating a Linear ticket:

- create the issue if the Linear tool is available
- if the Linear tool is not available, explicitly call that out in the final report
- include a clear reproduction summary
- reference the failing test or affected area
- explain why it was not fixed in this run
- include the safest obvious next step if one exists
- include the ticket identifier or link in the final report

## PR and CI completion rules

If this run changed files, opening a PR is the midpoint, not the finish line.

Required landing behavior:

- create the PR yourself; do not stop after preparing a branch
- poll PR status until CI leaves `IN_PROGRESS`
- if CI fails due to your diff, fix it and continue the loop
- if CI fails for an unrelated flake or transient infra issue, retry once and continue the loop
- if the retry fails again for an unrelated reason, call `job_needs_input` with the PR URL and a one-line summary
- call `job_complete` only after the PR is merged

If this run produced no code changes and no worthwhile test additions, `job_complete` may be called without opening a PR, but the report must explicitly say no changes were necessary.

## Coverage review heuristics

When the suite is green, look for the highest-value missing coverage, not the largest number of tests.

Prefer:

- one strong E2E scenario over several shallow UI checks
- several focused unit tests over one broad brittle test
- regression-oriented coverage over speculative coverage
- coverage for cleanup, persistence, branching, and failure paths

It is acceptable to identify worthwhile gaps and intentionally leave them unfilled when the maintenance cost is too high for the value.

## Final report requirements

Submit a terminal report that includes:

1. Local suite result summary.
2. Failures found and how each was resolved.
3. Flaky tests found and what was changed to make them deterministic.
4. Product bugs fixed directly.
5. Linear tickets created for non-trivial bugs, including identifiers or links.
6. Tests added or updated, with a short justification for each.
7. Coverage gaps identified but intentionally not addressed, with reasoning.
8. State-file summary, including updated `next_focus` and the top deferred items.
9. PR outcome, including the PR URL and whether it merged.
10. Any remaining environment sensitivity, cleanup risk, or flake risk still worth watching.

Structure the task list so a reader can quickly see:

- triage work
- failure fixes
- flake fixes
- coverage additions
- follow-up tickets
- PR and CI outcome

## Terminal tool choice

Use `job_complete` only when one of these is true:

- the suite is green locally, any changes from the run are already merged, and the report is complete
- there were no code changes to make and the report explicitly says so
- the only remaining blocker is a clearly documented non-code issue outside the scope of the run and the job instructions explicitly allow completion in that case

Use `job_failed` when the run cannot credibly restore trust in the local test signal and there is no safe path to continue.

Use `job_needs_input` when a human decision is truly required, or when a non-actionable external blocker prevents safe completion. Include the specific blocker, and include the PR URL if a PR was opened.
