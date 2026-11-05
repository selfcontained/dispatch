# Browser suite reduction

This records the implemented suite and its measurements. It is not a new
manifest, exception registry, or approval framework.

## What runs

The default `pnpm run test:e2e` runs nine journeys in seven files against an
isolated database, HTTP server, and real agent hosts using the deterministic
fake ACP engine. It does not invoke provider CLIs or paid models. Previously,
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

The full server, frontend and extension suites still run. PostgreSQL 14
compatibility coverage is unchanged. This change does not use broad path-based
skipping to obtain its savings and does not claim to fix historical flakes in
the retired browser tests.

## Commands

- `pnpm run test:e2e`: the nine core journeys; builds the frontend unless CI
  explicitly supplies its existing build.
- `pnpm run test:e2e e2e/tasks-board.spec.ts`: one changed journey locally.
- `pnpm run test:e2e:live`: compatibility alias for the agent lifecycle file;
  live fake-engine coverage is now part of the default suite too.
- `pnpm run test:unit`: Docker-free server unit subset plus frontend/extension.
- `pnpm run test`: complete existing server/frontend/extension suites.

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
