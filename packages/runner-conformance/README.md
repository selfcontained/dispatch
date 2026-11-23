# @dispatch/runner-conformance

One scenario set that every implementation of the runner contract must pass,
and a reference client that uses only `@dispatch/runner-protocol` and
`@dispatch/runner-client`.

## Pieces

- `src/scenarios.ts`: scenarios over the `Runner` interface. Every operation
  has at least one. An operation without written scenarios has a `pending`
  scenario that fails, so it is a red baseline entry, never a skip.
- `src/checked.ts`: every response, event and failure is checked against the
  contract schemas and the operation's declared error codes.
- `baseline.json` (R4): the red entries, per lane, each with the task that
  turns it green. A baselined scenario that passes, an unbaselined one that
  fails, and an entry for a scenario that did not run all fail the lane.
  Entries are only ever removed.
- `src/reference-client.ts`: accepts a remote runner's TLS connection,
  describes it, reads a file and runs a command guarded by it.

## Lanes

| Lane      | What runs                                                                                                                   | How                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `local`   | the local runner child (L1, L2); none exists yet, so every scenario is red                                                  | `pnpm --filter @dispatch/runner-conformance test`     |
| `adapter` | the temporary in-app adapter (`apps/server/src/runners/local.ts`) for the operations it routes                              | `apps/server/test/runner-conformance-adapter.test.ts` |
| `remote`  | the compiled runner on Linux in Docker, real TLS, workload account, wire v1, fixture ACP adapter; then the reference client | `pnpm run conformance:remote`                         |

The remote lane is not part of `check`, `test` or `ci`. It needs a reachable
Docker daemon, `bun`, `openssl` and the `node:22-bookworm` image. Its run
directory is under `~/.cache/runner-conformance` (override with
`RUNNER_CONFORMANCE_ROOT`) because Colima does not share the system
temporary directory. Containers are labelled `runner-conformance=<run>` and
removed when the lane closes.
