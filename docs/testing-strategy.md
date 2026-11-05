# Testing strategy

Use the lowest test level that can reproduce the failure. A UI change does not
implicitly require a new permanent browser test. Interactive UI validation and
regression coverage serve different purposes.

## Choose the boundary

| Behavior                                                                       | Default test                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------ |
| Rules, formatting, transformations, state machines                             | Unit                                             |
| UI branching, form validation, mutation payloads, loading/error state          | React Testing Library component/hook             |
| SQL, authentication, route contracts, Git/filesystem, processes, SSE transport | Integration with real resources at that boundary |
| Geometry, touch/drag, focus, history, scroll anchoring, native browser APIs    | Focused browser regression                       |
| Critical user journey across frontend, server, persistence or runtime          | End-to-end                                       |

Do not replace SQL or filesystem integration with mocks. Do not use jsdom to
prove layout or browser behavior. Prefer real relevant component children and
mock external seams rather than asserting that mocks call other mocks.

## Commands and migration

- `pnpm run test:unit`: no Docker; explicit server pure-unit subset, web
  component/hook tests and extension tests. The initial server subset is in
  `apps/server/vitest.unit.config.ts`; move more tests into it only after checking
  transitive dependencies for database, network, subprocess or host-state access.
- `pnpm run test`: complete existing server, web and extension suites. The server
  aggregate still includes DB, process, Git and release integration coverage.
- `pnpm run check:test-policy`: admission/reliability guard plus its unit tests.
  Playwright collection does not launch a browser or server.
- `pnpm run test:e2e -- <spec>`: focused browser test through the isolated runner.
- `pnpm run test:e2e`: full existing browser/API regression suite during migration.
- `pnpm run test:e2e:runtime`: all fake-ACP runtime specs, including message
  sharing and stream-follow. This runs real hosts against the fake engine; it
  does not invoke paid external models. The default inert suite intentionally
  skips these cases; a default green run is not runtime coverage.

Keep full CI regression coverage while moving assertions in small batches.
Do not turn path-based skipping on until its coverage mapping is validated.
The Postgres 14 full compatibility suite remains required until its DB subset
has been exhaustively classified. Core journeys and browser-only regressions
are recorded separately in the manifest; legacy cases remain visible migration
work, not precedent for new E2E tests.

The first migration removes 19 request-only Playwright cases:

| Removed spec                 | Preserved coverage                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-health.spec.ts` (2)     | `system-routes.test.ts` unauthenticated real-DB health; `agents-routes.test.ts` list shape and records                                                                                    |
| `focus-tracking.spec.ts` (3) | `agents-routes.test.ts` valid, null and omitted focus; `focus-tracker.test.ts` expiry/refresh logic                                                                                       |
| `jobs-api.spec.ts` (14)      | `jobs-routes.test.ts` create/full config/list/update/enable/disable/run/history/errors; `jobs-webhook-route.test.ts` secret, unauthenticated execution, trigger source and revoked secret |

`jobs-webhook-ui.spec.ts` replaces five order-dependent checks with one real
save/reload/disable/reload journey. Toggle display and payload cases are covered
by `jobs-settings-tab.test.tsx`; HTTP persistence and secret revocation by the
server route tests. The journey creates and removes its own job and saves via
UI rather than bypassing Save with an API update.

## Browser admission gate

`e2e/test-policy.json` records each collected case, its owner, risk, layer and
reason a lower-level test is insufficient. The guard compares actual Playwright
collection, including parameterized viewports, with this manifest. New, renamed,
deleted or duplicate cases require an explicit manifest change. Empty/error
collection fails. Supporting helpers are checked too.

A test change must explain:

1. Which actual failure it catches and why this level is necessary.
2. Existing overlap, and which lower-level test could replace it.
3. Isolation, timing and resource cleanup.
4. Expected runtime and any exception to the reliability rules.

The testing strategy owner reviews manifest/guard changes and all browser specs;
subsystem owners still review their own coverage. Updating the manifest is an
approval request in the diff, not permission to bless arbitrary coverage. Run
`node scripts/test-policy.mjs --inventory` to inspect case names and risk keys;
there is deliberately no automatic accept/update command.

AST checks ratchet fixed waits, skip/fixme/slow calls, test timeout setters and
explicit timeout/retry properties. Comments and formatting do not affect keys.
A risk exception records the exact operation hash, occurrence count, reason,
owner and expiry. An increased wait or duplicate occurrence needs a new review.
Removed risks require removing their exceptions. `.only` and `networkidle` are
forbidden even with exceptions. These checks cover normal test API usage, not
arbitrary obfuscation; reviewers must inspect new helper abstractions too.

Existing risks have a time-bounded migration exception through 2027-02-01.
That baseline preserves evidence; it is not an assertion that those waits or
skips are sound. Retire exceptions when touching that behavior. New exceptions
must explain the concrete need (for example, a bounded negative observation)
and how they will be removed or re-evaluated. No blanket retry, timeout or sleep
increases. No automatic baseline regeneration.

## Reliable results

CI allows one diagnostic Playwright retry and fails if any test is flaky, even
when its retry passes. JSON/JUnit results and first-attempt traces/screenshots
are uploaded after test execution regardless of pass/fail. Use per-test output
paths and attachments, never shared `/tmp` screenshot names in new tests.

Wait for concrete state, responses or events. Scope event assertions to the
entity under test. Prefer fake clocks for time-dependent unit/component tests.
A geometry assertion should express a user-visible invariant, not accidental
pixel equality; investigate the defect before adding a tolerance.

A rerun is a diagnostic experiment, never a repair. Record the initial failure,
classification, hypothesis and changed experimental condition. Do not call a
failure unrelated just because the file was untouched. A passing rerun does not
resolve a flaky-test defect. Fix the cause or record an explicit blocker.
Quarantine requires user approval, an owner, issue and expiry; core journeys
must not disappear silently. Do not compensate by permanently serializing the
whole suite or raising global timeouts.

For a flake fix, run the focused case repeatedly with retries disabled at normal
worker concurrency; include an isolation/order check when implicated. Ten
successful repetitions are useful evidence, not proof of zero flakiness.
Measure first-attempt failures separately from final outcomes. Separate test
execution, setup/build and CI queue time. Establish p50/p95 from comparable runs
before making wall-clock budgets mandatory. Do not use a coverage percentage or
unit:E2E count ratio as the strategy.

## Next migration batches

1. Token aggregation and remaining worktree API/filesystem variations into real
   DB/Git integration tests; jobs SSE into entity-scoped transport integration.
2. Form/popover/settings variations into existing component tests; retain
   explicit browser focus/layout regressions.
3. Curate roughly 8–12 independently diagnostic core journeys, including fake
   ACP send/receive/stop/approval, task trigger, thread answer, attachment,
   template/job persistence and safe worktree archive. Keep layout/scroll/touch
   regressions separately; do not concatenate unrelated assertions to meet a
   count target.
4. After coverage and stability evidence, reduce duplicate compatibility work
   and introduce conservative path selection with an unknown-change fallback.

A green maintenance run may remove duplication, improve reliability or make no
changes. Adding tests is not an obligation or a success metric.
