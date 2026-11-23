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
  When replacing a pending scenario, remove its entry and name any remaining
  contract mismatches under the scenarios that exercise them.
- `src/reference-client.ts`: accepts a remote runner's TLS connection,
  describes it, launches a session, attaches and prompts it through turn end,
  runs a guarded checkout command, then stops and discards the session. The
  remote lane runs this twice with different environment keys and MCP server
  names. It verifies the MCP names at the fixture engine. The launch environment
  assertion stays red on wire v1 under T24.

## Lanes

| Lane      | What runs                                                                                                                   | How                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `local`   | the local runner child and real hosts, with a fixture ACP adapter                                                           | `pnpm run conformance:local`                          |
| `adapter` | the temporary in-app adapter (`apps/server/src/runners/local.ts`) for the operations it routes                              | `apps/server/test/runner-conformance-adapter.test.ts` |
| `remote`  | the compiled runner on Linux in Docker, real TLS, workload account, wire v1, fixture ACP adapter; then the reference client | `pnpm run conformance:remote`                         |

The local and remote lane scripts run on demand. The remote lane needs a reachable
Docker daemon, `bun`, `openssl` and the `node:22-bookworm` image. Its run
directory is under `~/.cache/runner-conformance` (override with
`RUNNER_CONFORMANCE_ROOT`) because Colima does not share the system
temporary directory. Containers are labelled `runner-conformance=<run>` and
removed when the lane closes.
