# Pull request CI

`.github/workflows/ci.yml` runs one job, `ci`, on every pull request to `main`
(and `acp-runtime`). The `checks pass` ruleset on the default branch requires
that one status check, so `ci` is the only merge signal.

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

## Branch protection and merge policy

`ci` stays one job: GitHub reports a skipped _job_ as success for a required
check, which would let a misrouted run pass. Skipped _steps_ leave `ci` as the
single result, which is green only when every step that applied passed and red
or pending otherwise.

Runs are grouped per pull request with `cancel-in-progress`, so a new push or
description edit cancels the run it supersedes. The cancelled run's `ci` result
belongs to the old head (or is replaced by the new run on the same head), so
the current head always waits for its own run.

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

The docs fast path is verified by a PR that changes only this file.
