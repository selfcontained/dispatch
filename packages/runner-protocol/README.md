# Remote runner protocol v1

`@dispatch/runner-protocol` exports transport frame types, host replay and
receipt types, and workspace locator helpers. It has no dependencies outside
the package. The separate `@dispatch/runner-protocol/node` entry point provides
NDJSON framing and a `Duplex` channel for Node-compatible runtimes. The package
ships TypeScript source for Bun or a TypeScript-aware bundler.

## Identity and transport

Runner registration is a service-side identity bound to its authenticated
connection. The runner's `ready` frame advertises version 1 and the workspace
handles available on that connection. Route an operation by registration and
workspace, then send the selected workspace and agent IDs in the command. A
runner binds an agent to a workspace and checks the binding on later commands.
The command's agent ID is authoritative for a launch.

Identifiers are case-sensitive strings of 1 to 128 UTF-16 code units and
exclude control characters and unpaired surrogates. Treat them as opaque,
including those containing slashes or percent signs. Build
`runner://<runner>/<workspace>` using `workspaceLocator`. Decode each component
once after splitting, as in `remotePlacement`. For example,
`runner://Fleet%2FNorth/Team%20A%2Frepo` names `Fleet/North` and `Team A/repo`.
Legacy locators such as `runner://lima/proof` are still accepted.

Each outer frame is JSON followed by a newline, encoded in UTF-8. A request
ID correlates a `request` with its `result` within the connection. For
`attach`, that ID also names the channel for base64 `data` and `close`
frames. The decoded channel bytes carry a separate NDJSON stream. A
transport close ends its channels, and a reconnect can attach to an
existing host. Use unique request IDs within each connection. These IDs
provide correlation only.

The guest resolves the working directory, executable and environment.
The optional launch field `mcp` supplies one service-scoped MCP endpoint
using an HTTPS `url`, bearer `token`, and optional `name`. Absence starts the
ACP session with an empty service MCP list. v1 launches with the original
`{ url, token }` shape use the server name `dispatch`. Prototype runner
binaries require that shape, so keep sending it when interoperating with
those binaries.

## Receipts and replay

| Signal                              | Meaning                                               |
| ----------------------------------- | ----------------------------------------------------- |
| Launch `result` with `value: true`  | The runner spawned the guest host process.            |
| Host `welcome` with `running: true` | The host reports a ready ACP session.                 |
| `prompt_accepted`                   | The host confirmed handoff to ACP for that operation. |
| Journaled terminal turn event       | The turn settled, with its reported outcome.          |

An outer request timeout or dropped result may leave execution unknown.
After attaching, send `hello` with the last durably applied `fromSeq`, its
`journalId`, and `replayComplete: true`. Use sequence 0 on the first attach.
`welcome` gives the current journal identity and the inclusive replay head.
The host sends events strictly after the resume position through that head,
then sends `replay_complete` when requested. Later events are live. If the
journal identity changed or the cursor exceeds the new head, the host starts
replay from 0. Reset the receiver's stream position before accepting the
replacement. An omitted journal identity is supported for legacy clients.

Deduplicate by journal ID and sequence within the bound agent. Sequences
start at 1 and increase contiguously. A gap prevents advancing the contiguous
cursor. Persist each payload or its projection atomically with that cursor,
or persist the payload first with idempotent application on retry.
`replay_complete` marks the sender's replay boundary. The receiver's next
`hello` advertises the prefix it committed.

For prompts, persist the operation ID and selected journal ID before
sending, and include both in the host prompt. The host records a claim
before submission and an accepted receipt before sending
`prompt_accepted`. Repeating an accepted operation on the same journal
returns its receipt without submitting again. A recorded claim without an
accepted receipt, or a request for a different journal, yields an unknown
outcome. Reconcile such an operation from journal evidence and avoid automatic
resubmission. A legacy prompt with no journal ID bypasses receipt
deduplication. `prompt_deferred` explicitly indicates the host held back
submission because an engine-initiated turn was already open.
