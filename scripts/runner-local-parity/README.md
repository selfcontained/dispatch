# Local parity oracle

Local users must see no change against main. This builds main at the pinned
commit and the head, runs both through the same scenarios, and fails on any
difference that is not in a ledger.

```sh
DISPATCH_PARITY_DATABASE_URL=postgres://…/postgres pnpm run parity:local
pnpm run parity:local --only '^audit-'   # some scenarios
pnpm run parity:local --head <ref>       # a commit, not the working tree
pnpm run parity:local --control          # main against main: must find nothing
pnpm run parity:local --output <dir>     # report.md and report.json
```

It needs Bun, pnpm, Git and a scratch Postgres on loopback. A full run takes
about six minutes, five of which are one scenario waiting for a real timeout.
It is not part of `pnpm run check`.

## What it isolates

Each side of each scenario gets a database, home, state root and loopback
port, plus an allowlisted environment. Engines are the e2e fixture adapter.
`gh`, `security`, the clipboard and service tools are shims, and non-loopback
HTTP goes to a closed proxy. A killed run (SIGKILL) can leave databases named
`dispatch_parity_*` and a `/tmp/dp-*` directory.

## Files

| File                        | Rule                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `main-pin.json`             | Moves only in the commit that merges that main commit.                                      |
| `known-regressions.json`    | Shrink-only. A fix deletes its entries in the same commit.                                  |
| `intended-differences.json` | Each entry cites an owner decision.                                                         |
| `substitutions.json`        | The only normalisation. Closed: a test lists it, so a change shows in review.               |
| `scenarios/`                | `audit-N` is item N of the local regressions in the architecture audit. The rest is sweeps. |

A known entry is `{scenario, path, main, head, finding}` and excuses that exact
difference. An entry may instead be `{field, main: "<absent>", head, finding}`
for one field the head adds to a record that many scenarios return. It never
excuses a changed or missing value.

An intended entry cites an owner decision and has one of three shapes:
`{scenario, path, main, head, decision}` for one exact difference;
`{field, decision}` for a field the head adds to records everywhere, with any
value (it never excuses a changed or missing value); or
`{consequence, decision}` for a difference computed from the built trees. The
only consequence is `migrations`: readiness reporting each side's own
migration count and latest name, read from `apps/server/src/db/migrations`.
A field-wide entry hides every value of that field, so add one only with an
owner decision.

## When it fails

- **Unexpected:** the change altered what local users see. Fix the change.
- **Stale:** a known difference is gone or different. If it is gone, delete the
  entry. If it is different, it is a new regression.
- **Failure:** a scenario could not finish. This is never a difference and
  cannot be put in a ledger.

After writing a scenario, read what main answered in `report.json`: two
identical errors also compare as "same". Run `--control` too, because anything
it finds is nondeterminism in the scenario.

## Limits

- The baseline was recorded on macOS. Error text from the operating system
  differs on Linux, so CI runs this on a macOS runner.
- Two timing races are avoided in the fixture rather than normalised away
  (`steadyFixture` in `world.mjs`). One of them is a real race on main.
- It cannot see timing, real engines, UI pixels, the signed Mac app or
  systemd. The platform helper's backup and restore is a named skip.
