# Pull request CI

`.github/workflows/ci.yml` emits `ci` for code/base events and the lightweight
`CI routing` job for title/body-only edits on pull requests to `main` (and
`acp-runtime`). The default-branch ruleset requires both exact checks `ci` and
`PR metadata` from GitHub Actions; together they gate merging.

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
suite. The classifier's own tests run on every code-validation run.

To add a path to the allowlist, check that nothing builds, tests, packages,
loads at runtime or publishes it, then add it to `isDocsPath` and its test.

## Branch protection and event routing

The default-branch ruleset requires both exact checks `ci` and `PR metadata`
from GitHub Actions (integration 15368). `ci` validates actual code/merge state;
`PR metadata` independently rejects session links in title/body. Hygiene is
outside code CI so correcting a description can recover its metadata check
without replacing a failed/pending code check.

Opening, pushing commits, reopening, and changing the target base still run
`ci` through the existing docs/full classifier. Unknown edited payloads also
validate. A positively identified title/body-only edit instead names the job
`CI routing`, runs on hosted Ubuntu, and executes only a routing message: no
checkout, dependencies, database, tests, builds, artifact upload or cleanup.
This path never emits a skipped or successful job called `ci`. GitHub treats
skipped required jobs as successful, so check identity is part of the guard.

Code and routing runs have separate per-PR concurrency groups; description
edits cannot cancel code validation. Code pushes still cancel superseded code
runs. The separate `pr-metadata.yml` workflow always emits `PR metadata` for
opened/synchronize/reopened/edited events on its own per-PR concurrency group.
It uses hosted Ubuntu and only the existing shell guard. Review comments,
approvals, labels and draft transitions are not subscribed events.

User-approved rollout deliberately allows older PRs without a metadata result
to remain blocked until their next legitimate update. Review is unaffected;
merge waits for both required checks. No privileged seeder or unsolicited
PR edits are used. After this cutover, a legitimate title/body correction
runs only hosted metadata/routing jobs; a push still validates actual code.
The existing `ci` requirement, source restrictions and other ruleset settings
remain in force. An old hygiene-failed code run still requires genuine code
validation (for example an owner-authorized reopen); metadata never manufactures
or restores code success.

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

## Event-policy verification

`scripts/ci-event-policy.test.mjs` exercises workflow expressions with known
metadata edits, pushes, reopenings, base edits and unknown edits; checks all
expensive steps including always-run cleanup; preserves owned-command wrappers;
and executes the existing guard against bad/corrected metadata. Its nullable
JavaScript fixtures simulate only the used expression subset. Live Actions
check-name, cancellation and required-check behavior must be verified separately.

The metadata check measured 3 seconds hosted during Stage A; passing code CI
measured 4m39s on the macOS runner. These are observations, not controlled
resource benchmarks or attribution of historical OOMs. Stage B leaves actual
code suites unchanged and removes their execution for title/body-only edits.
