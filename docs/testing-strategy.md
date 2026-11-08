# Browser suite reduction

This records the implemented suite and its measurements. It is not a new
manifest, exception registry, or approval framework.

## What runs

The default `pnpm run test:e2e` runs nine journeys in seven files against an
isolated database, HTTP server, and real agent hosts using the deterministic
fake ACP engine. Availability checks use a version-only executable stub; no
provider CLI installation or login is required. It does not invoke paid models. Previously,
the default inert runtime skipped the live agent journeys.

| File                       | Journey                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `agent-live.spec.ts`       | Create, converse, cancel, pause/resume, converse again, archive                  |
| `agent-live.spec.ts`       | Restricted approval, reload, allow/reject, cancel                                |
| `agent-live.spec.ts`       | A thread reply reaches the engine and stays in its thread                        |
| `inline-answers.spec.ts`   | Answer a question/form and reopen persisted answers                              |
| `message-sharing.spec.ts`  | Forward a verifiable approval across agent hosts without granting history access |
| `tasks-board.spec.ts`      | Create a task, move to a triggered column, open the launched agent               |
| `task-attachments.spec.ts` | Create a task with uploaded context and reopen it                                |
| `jobs-webhook-ui.spec.ts`  | Save/reload/disable/reload a webhook configuration                               |
| `worktree.spec.ts`         | Archive an agent while preserving outstanding work                               |

These are independent, scoped journeys. There is no serial-project dependency
chain, mobile/desktop duplication, or hidden extended suite moved to a nightly
schedule. Removed tests remain recoverable in Git history.

## What was removed, and what still protects it

The original suite collected 286 cases. The first migration reduced that to
263; this revision reduces it to nine. This deliberately reduces automated
browser coverage, rather than claiming every removed visual assertion has an
equivalent unit test.

| Removed browser checks                                                                | Remaining coverage / deliberate tradeoff                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-only health, focus, jobs                                                          | Real-DB route coverage strengthened in this PR; 19 Playwright cases removed                                                                                                         |
| Worktree configuration/branch variants                                                | Git origin/base integration, real-DB archive branch cleanup, local-config filesystem tests, archive logic and dialog component tests; one real browser preservation journey remains |
| Task drag, touch, header geometry, filters and modal permutations                     | Task service/transport integration and task component/hook tests remain; the short create/trigger journey replaces the 500-line mixed scenario                                      |
| Scroll/windowing, virtualization, pane geometry, responsive shell, focus permutations | Existing feed/windowing/state/component tests remain. Pixel/gesture behavior is intentionally checked during relevant implementation/review, not on every PR                        |
| Form/settings/dropdown/rendering variations                                           | Existing component tests for create-agent, tasks, jobs, templates, chat blocks and settings remain; core persistence journeys provide wiring checks                                 |
| Stream/MCP permutations, token aggregation, jobs SSE                                  | Existing stream-service/routes, MCP transport, agent-usage, jobs service/route tests remain; live thread and cross-agent handoff journeys retain end-to-end wiring                  |
| Update, notification, certificate and terminal browser checks                         | Existing release/auth/terminal/service tests remain. Browser-specific acceptance checks are no longer universal PR regression gates                                                 |

The routine server, frontend and extension suites run once, with server database tests against PostgreSQL 17. The PostgreSQL 14 CI run is removed by explicit project decision. Raising
the installer's minimum from 14 to 17 is a separate backlog task; until then,
the published minimum remains 14 without a dedicated CI compatibility run.
This change does not use broad path-based skipping to obtain its savings and
does not claim to fix historical flakes in retired browser tests.

## Commands

- `pnpm run test:e2e`: the nine core journeys; builds the frontend unless CI
  explicitly supplies its existing build.
- `pnpm run test:e2e e2e/tasks-board.spec.ts`: one changed journey locally.
- `pnpm run test:e2e:live`: compatibility alias for the agent lifecycle file;
  live fake-engine coverage is now part of the default suite too.
- `pnpm run test:unit`: Docker-free server unit subset plus frontend/extension.
- `pnpm run test`: routine server/frontend/extension regression suites.

CI retains one diagnostic retry but fails on retry-pass results, and uploads
JSON/JUnit and failure traces. A runner integration test verifies this behavior.
The prior proposed AST policy gate, counted exceptions, browser manifest and
new testing-strategy reviewer were removed rather than codifying an unproven
system.

## Measurement

Before: CI run 42072787008 at `58ef2ffa` took **10m16s** overall. Playwright
reported **235.681s**, 250 passed and 13 skipped. Backend test execution took
123.27s on PostgreSQL 17 and 110.49s on PostgreSQL 14; frontend tests took 17.07s.
Per-file test durations overlap across workers and must not be summed as elapsed
wall time.

The revised nine-journey prototype passed locally in **25.2s**, including live
agent execution. This is not a matched CI comparison. After fixing the Stop control assumption that no other agents were active,
three repetitions at the normal four-worker concurrency passed **27/27** with
retries disabled in **36.3s** (shared startup). Current-head CI is recorded in
the PR validation report before completion.

Use observed cost and regression value to decide future additions. Needing a
real browser explains a validation method; it does not by itself justify a
permanent test on every PR. Broader enforcement should follow experience with
this smaller suite, not precede it.

## Backend dev-tool boundary

Routine CI tests `dispatch-dev` orchestration through saved-state fixtures and
fail-closed doubles for Docker, pnpm and Bun. These verify duplicate-start
rejection, stale-state cleanup, status/URL/log output and environment isolation
without starting PostgreSQL, the API, Vite or agent hosts. Existing focused
cleanup/restart tests retain volume preservation, failed-start cleanup, state
retention and host-preserving recovery decisions. These are lightweight CLI
contract tests, not pure in-process unit tests.

The full-stack dev startup/restart/recovery scenarios and their dedicated
harness are deleted, not retained as a manual command or nightly suite. The
nine browser journeys cover core user-facing agent lifecycle wiring in CI.
Full-stack crash/recovery behavior is no longer a permanent regression guarantee;
neither browser journeys nor mocks are claimed to prove that removed coverage.

The previous eight-case dev test file cost 129.874s in Linux CI. An investigative
local run excluding that file passed 4,208 tests in 35.36s; the pure unit subset
passed 237 tests in 0.259s. These local times are not CI savings estimates. The
replacement and final CI timings are recorded in the PR validation report.

## Frontend Vitest resource containment

Frontend Vitest defaults to one isolated fork at a time with a 768 MiB V8
old-space limit per fork. The limit is passed through Vitest's fork `execArgv`,
so it does not cap TypeScript checks, builds, or other workspace commands.
A global 768 MiB `NODE_OPTIONS` cap caused the web type check to abort during
investigation and must not be substituted for this setting.

The initial measured selection covers task drawer, chat feed, formatting,
persisted state, and stream hooks. All selected files passed at both 512 and
768 MiB with one worker; the 157-test mixed batch peaked at about 636 MiB total
sampled process-tree RSS. The 768 MiB choice provides headroom for that selection;
it is not a measured full-suite requirement. Full regression compatibility
remains a current-head CI gate. One worker can increase full-suite elapsed time;
no unrestricted parallel comparison was run during the memory incident.

This reduces the default 13-worker multiplier on the investigation host. It does
not fix retained allocations, cap native memory or total RSS, coordinate separate
worktrees/CI jobs, or guarantee cleanup after cancellation. Worker heap failure
must remain a failing run. Host admission and lifecycle cleanup need separate
ownership-aware follow-up; do not use broad process kills or a host-wide test lock.

## PR metadata and code validation

Code CI subscribes to opened, synchronize, and reopened PR events on `main`
and `acp-runtime`. Title/body edits only run the independently required
`PR metadata` job; they cannot cancel or replace `ci`. Both required identities
remain unchanged, and the code job is unconditional.

CI records its triggering event's PR timestamp, head/repositories/target, and
actual checked-out merge parents before tests in a run-attempt-specific artifact.
Metadata uses only PR and Actions read permissions, never checks out PR code,
and checks successful code-run/job evidence. It waits up to 45 minutes for initial
or new-head CI (50-minute job timeout), polling every 20 seconds. Existing valid
same-head/target evidence returns immediately, even if the base tip advanced.
Only the first 100 same-head runs/artifacts/jobs are considered; unavailable,
invalid, expired, API-error or timed-out evidence fails closed.

A base retarget, including an automatic base change, requires fresh evidence.
Both the immutable triggering PR `updated_at` and the server artifact creation
time must be strictly later than the latest base-change timeline timestamp.
This rejects delayed old events, reruns of old events, retargets away and back,
and same-second ambiguity. The actual merge parents supply the tested base SHA;
the event's base SHA is not assumed to match the integration checkout.

After retargeting, close and reopen the PR or push a new commit in a later second
to start code validation against the new target. Normal concurrent metadata waits
for that run automatically. For bootstrap (older CI without evidence), artifact
expiry (30-day retention), or a metadata timeout, create fresh CI this way and
retry the failed metadata run after it succeeds. Rerunning an old code event
cannot repair a stale retarget snapshot. Failed/pending code CI remains independently
required; metadata does not publish synthetic code checks.

PR descriptions describe the final implementation and review context. Update
them when scope or review facts change, not merely to record a pending/passed run.
Put CI progress and results in checks, comments, or task handoffs.

API contracts: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[artifacts](https://docs.github.com/en/rest/actions/artifacts),
[base-change timeline events](https://docs.github.com/en/graphql/reference/pulls),
and [rerun event SHA/ref preservation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
Local policy fixtures exercise the embedded workflow script and bounded ZIP
parser; they are not a live GitHub event demonstration. A controlled title/body
edit demonstration must wait until the corrected workflows take effect.
