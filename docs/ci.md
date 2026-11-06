# Pull request CI

`.github/workflows/ci.yml` runs the static required job `ci` on subscribed pull
request events to `main` (and `acp-runtime`). The default-branch ruleset requires
both exact checks `ci` and `PR metadata` from GitHub Actions.

## Local checks versus PR CI

Full automated E2E belongs in PR CI; locally run only new or updated E2E coverage included in the change, selecting specs/cases with the existing isolated runner and `--no-deps` to exclude dependent projects per AGENTS.md. Keep other applicable local checks and separate served-UI Playwright interactions/screenshots, browser cleanup, and retained previews. Require passing CI on the current PR head before merge. The existing docs-only CI classification below still applies; this policy does not change CI scope or coverage. Do not require a redundant local full E2E run in task briefs or acceptance reviews.

## Change scope

The first steps classify the pull request with `scripts/ci-change-scope.mjs`:

- **`docs`** — every changed path is an edit to, or addition of, a regular
  (mode `100644`) file that is one of:
  - `docs/**/*.md`
  - `AGENTS.md`, `CLAUDE.md`, `TODO.md` at the repository root
- **`full`** — anything else, including:
  - any other path: workflows, `package.json`, `pnpm-lock.yaml`, build and test
    config, `scripts/`, `bin/`, `apps/**` (code, migrations, generated files,
    the site's own content), `e2e/`
  - prose the product or release reads: `README.md` (shipped in the release
    package), `release-notes/` (feeds releases), `.agents/personas/` and
    `plugins/` (loaded by the server)
  - deletions, renames (diffed with `--no-renames`, so the old path counts),
    type changes, executable bits and symlinks, even under `docs/`
  - an empty diff, or a checkout that is not the expected PR merge commit
  - any error while classifying

The diff is the PR merge commit (`refs/pull/N/merge`, what GitHub checks out)
against its first parent, so it is exactly what merging would introduce against
the current base — no merge-base computation, and nothing on `main` that the PR
does not touch can make it look docs-only or code-touching. The classifier also
confirms that the merge commit's second parent is the PR head.

A `docs` run installs dependencies and runs `pnpm run format` (Prettier, the
same check the full suite starts with). It skips Postgres, Playwright, type
checks, lint, builds, unit and e2e tests, PostgreSQL 14 tests, and the Bun
binary build and smoke test. A `full` run is unchanged. Steps run unless the
scope is exactly `docs`, so a missing classification falls back to the full
suite. The classifier's own tests run on every pull request.

To add a path to the allowlist, check that nothing builds, tests, packages,
loads at runtime or publishes it, then add it to `isDocsPath` and its test.

## Branch protection and reliable check identity

Both `ci` and `PR metadata` are required from GitHub Actions integration15368.
Code CI retains its actual `ci` job on opened/synchronize/reopened/edited events,
including base retargets. It always performs the existing docs/full validation.
Runs are grouped per PR with cancellation of superseded runs. Title/body edits
therefore still replace code validation; avoiding those expensive restarts is
an unresolved optimization, not a guarantee of this reliability correction.

The attempted dynamic `CI routing` job is withdrawn. Live GitHub UI showed that
a newer routing-only CI suite left required `ci` Expected even when an older
`ci` passed and the API's visible rollup was successful. Do not infer merge
eligibility from latest-only check summaries or a successful aggregate alone.
The required context must be satisfied in the actual GitHub merge gate.

The independent metadata job checks current title/body with only
`pull-requests: read`, no checkout, PR code execution, custom check publishing,
metadata logging or write permissions. Human roles and rerun rights are unchanged.
It validates the original expected head/target/repositories/open state and
observed metadata stability; API errors and identity changes fail closed.
The duplicated event-snapshot hygiene step is removed from code CI: metadata
failures should be repaired through the separate lightweight job.

GitHub can retain a failed metadata suite after a corrected edit passes. Correct
metadata, then rerun each remaining failed `PR metadata` workflow run shown as
required (`gh run rerun RUN_ID --failed`). This uses existing maintainer access;
a PR author without rerun access needs a maintainer. The reader re-evaluates
current metadata in that same run. Correction alone is not automatic recovery.
Inspect the full required rollup and actual merge gate afterward.

This retry applies only to current-reader runs on the same head and target.
Legacy snapshot-only runs cannot acquire the reader by retrying; coordinate
current-head code validation separately instead of repeatedly rerunning them.
Changed-head/target runs also need checks appropriate to the current identity.
Two reads are not an atomic snapshot. Older PRs without a metadata check may
remain blocked until their next legitimate update, as explicitly approved;
no privileged seeder or unsolicited edits to others' PRs are used.

## Why other suites are not split

Web-only or server-only selection is not safe today: `apps/web/src` imports
about twenty server modules directly, at runtime as well as for types (for
example `server/src/shared/lib/format-bytes` and
`server/src/routes/activity/history-wire`), so a "server-only" change can break
the web type check, build and tests. In the other direction the server serves
the built web app, e2e exercises both together, and the Bun binary embeds the
web build, so a "web-only" change still needs the build, e2e and binary steps
that make up most of the run. Both apps also depend on `@dispatch/shared`.

The one candidate left is skipping the two server unit-test runs (about two
minutes each) for changes confined to `apps/web/`; roughly one merged pull
request in seven is web-only. It is not done because nothing enforces it: about
thirty server test files resolve paths from the repository root, and
`pack-release` inspects build output that embeds the web app. The skip would be right only for as long
as no server test reads web files, and a new test that did would be skipped
silently on exactly the changes it covers.

Splitting the suite into parallel jobs does not help either. There are two
self-hosted runners (`dispatch`, macOS ARM64; `ubu`, Linux X64), and almost all
of the slow tail is time spent waiting for one of them. Parallel jobs would
occupy both runners per pull request and lengthen that queue.

## Runner cost

Docs-only runs hold a runner for about a minute instead of about nine (macOS)
or thirteen (Linux). Cancelling superseded runs frees the runner as soon as a
pull request moves on. Both reduce the queue that causes the long waits; neither
changes what a code change runs.

## Bounded policy verification

`scripts/ci-event-policy.test.mjs` verifies required job identity/event coverage,
owned-command wrappers, independent metadata execution and the current-reader
predicate against mocked API success/failure/race/identity cases. These local
checks do not prove GitHub merge-gate selection: live validation remains required.

Actual code suites remain lean and unchanged. Passing CI measured4m46s on the
macOS runner; hosted metadata jobs measured approximately4–6s. These are wall-time
observations, not controlled host resource benchmarks or historical OOM attribution.
