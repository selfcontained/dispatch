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
A runner that advertises `managedWorkspace: true` with the reserved workspace
`@session` provides private
storage for each agent ID. Launch uses an empty scratch directory by default.
The optional `repository` launch field selects a credential-free HTTPS Git URL
and a checkout instead. A runner with `/usr/bin/gh` can use credentials from the
workload account’s GitHub login for `https://github.com`:

- `{ kind: "new", branch, base? }` creates a branch from the named or default
  remote branch.
- `{ kind: "branch", branch }` checks out an existing non-default branch.
- `{ kind: "pr", branch, number }` fetches `refs/pull/<number>/head` and checks
  it out under the supplied branch name.

An occupied or conflicting branch causes launch to fail. A successful
`discard` removes the agent's session directory and checkout while retaining
cached branches. Services can retry discard after a lost acknowledgement.
Configured workspace handles continue to use their configured directory.

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
After attaching, send `hello` with `fromSeq`, its `journalId`, and
`replayComplete: true`. Dispatch sets `fromSeq` to the last contiguous
sequence whose full event payload and receive cursor committed together in
PostgreSQL. Use sequence 0 on the first attach.

`welcome` gives the current journal identity and the inclusive replay head.
For the same journal, replay starts strictly after `fromSeq` and continues
through that head. The host then sends `replay_complete` when requested.
Later events are live. If the journal identity changed or the cursor exceeds
the new head, the host starts replay from 0. Reset the receiver's cursor
before recording the replacement stream. An omitted journal identity is
supported for legacy clients.

Deduplicate by journal ID and sequence within the bound agent. Sequences
start at 1 and increase contiguously. A gap prevents advancing the receive
cursor. `replay_complete` marks the sender's replay boundary. The receiver's
next `hello` acknowledges the prefix it committed. Projection of stored
events and prompt delivery receipts have separate state from this cursor.

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

## Runner health

A runner can advertise `health: true` in its v1 ready frame. A service that
wants reports replies once with `{"type":"accept_health"}`. The runner pushes
a `health` frame containing its latest sample immediately and every 30 seconds
while connected. Older services ignore the advertisement. A service chooses
what to retain. Samples have no journal cursor, acknowledgement or replay.
Reconnection starts a fresh reporting interval.

Session and working counts describe live agent hosts and hosts with an open
turn. CPU is a percentage over two samples (null until available), and memory
is reported in bytes. Version identifies the runner build. Dispatch binds each
report to its authenticated registration and stores the last snapshot with a
service-side receipt time so stale measurements can be labeled after disconnect.
