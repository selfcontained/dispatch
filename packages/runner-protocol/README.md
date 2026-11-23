# Remote runner protocol v1

`@dispatch/runner-protocol` exports transport frame types, host replay and
receipt types, and workspace locator helpers. It has no dependencies outside
the package. The separate `@dispatch/runner-client/v1/node` entry point provides
NDJSON framing and a `Duplex` channel for Node-compatible runtimes. The package
ships TypeScript source for Bun or a TypeScript-aware bundler.

## Implementing a service or runner

| Boundary   | Initiator                           | Responsibility                                                                                                                                                     | Contract                                                                                |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Enrollment | Runner                              | Ask the service for a code, poll for approval, and verify the issued certificate before persisting credentials.                                                    | `enrollment.ts` defines HTTP responses and private-CA bootstrap frames.                 |
| Execution  | Runner advertises, service requests | Bind each authenticated connection to a registration. Validate the first `ready` with `parseReadyFrame`. Send commands for advertised workspaces and capabilities. | `execution.ts` defines `ServiceFrame`, `RunnerFrame`, and `Command`.                    |
| Session    | Service attaches to a host          | Exchange hello/welcome, replay journal entries, and deliver prompts inside the attached byte stream.                                                               | `session.ts` defines journal positions and receipts. See **Receipts and replay** below. |

For a Node-compatible service, create one `RunnerConnection` from
`@dispatch/runner-client/v1/connection` per authenticated, ready peer. Its
constructor takes a frame sender. Route incoming `result`, `data`, and
`close` to `receive`. Call `close()` when the transport disconnects and
create a fresh connection when the runner returns. Call
`request(command, { openChannel: true })` to buffer channel data from the
moment an attach or engine operation is sent. The service owns registration lookup, authorization and durable journal
storage. Enrollment and attachment require no project, task board, review
workflow, notification system or UI. Treat those as service concerns.

To extend v1, define the message in its sending direction and document its
receipt or failure semantics. For an optional operation, advertise support in
`ready` and exercise both a capable peer and a peer that omits the flag.
`wireFrames` handles NDJSON and buffering. Its directional TypeScript types
describe the expected messages. Pass parsed JSON to `parseServiceFrame`
before dispatching a runner command, and to `parseSessionCommand` at the host
end of an attached channel. These decoders accept additive fields in familiar
v1 messages and reject unknown command kinds. The runner replies with
`result.error` if a malformed request has a usable ID and closes the transport
if it cannot correlate the frame. The host replies with an `error` message.

For HTTPS enrollment, decode successful response bodies with
`parseConnectCreated` and `parseConnectPoll` before displaying a code, polling,
or saving credentials. An unknown poll status is a protocol error. Verify the
issued certificate and CA before saving credentials.

Run the in-memory consumer tests from the repository root with
`pnpm run test:runner-protocol`.
The independent consumer uses only public package exports for the wire
contract. It launches without MCP, reads prompt receipts and journal events,
stops, reconnects, relaunches with an engine session handle, and resumes from
a journal cursor. It also checks correlated failures and consumes health and
inventory when offered. The deterministic in-memory peer runs with current
and baseline v1 capabilities. Extend this fixture for new wire operations
with both advertised and unsupported cases. It requires no database, TLS
certificates, agent process or running Dispatch instance.

For changes beyond the portable contract, the implementation tests in
`apps/server/test/` exercise different boundaries:

| Change                                                         | Test fixture                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Pair, approve, rotate or revoke                                | `remote-runner-connect` and `remote-runner-enrollment` use a test registry and local TLS peers.                               |
| Start a workload, allocate a session or check out a repository | `remote-runner-startup`, `remote-session-storage` and `runner-repositories` cover host configuration and filesystem behavior. |
| Reattach or stop a host after the runner daemon restarts       | `remote-runner-supervisor` tests binding, process identity, and cleanup independently of TLS.                                 |
| Record and recover received events                             | `remote-event-inbox` exercises the durable cursor and payload together.                                                       |
| Report health or manage an engine                              | `runner-health`, `engine-manager` and `engine-runner-executor` exercise sampling, routing and workload execution.             |

For a change that crosses these boundaries, `pnpm run test:e2e:remote-runners`
runs the browser workflow with isolated Linux runners and deterministic engines.

## Identity and transport

Runner registration is a service-side identity bound to its authenticated
connection. The runner's `ready` frame advertises version 1 and the workspace
handles available on that connection. Route an operation by registration and
workspace, then send the selected workspace and agent IDs in the command. A
runner binds a session handle to a workspace and checks the binding on later
commands. `agentId` is the legacy wire name for a caller-assigned session
handle. It need not follow a product prefix. Send the same handle in the
envelope and launch payload. The envelope is authoritative. The
engine-assigned `sessionId` in `welcome` is separate. Send it as
`resumeSessionId` to request an engine resume on a later launch and check
`welcome.resumed` to confirm.

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
  Runners advertising `sessionCheckout: true` also accept `allowDefault: true`
  on this checkout kind to let the existing branch be the origin's default.
  Git still rejects a branch held by another worktree.
- `{ kind: "default" }` checks out the existing branch named by the origin's
  HEAD symref. It requires `sessionCheckout: true`. The runner journals the
  resolved branch before reserving the worktree, so recovery preserves the
  branch even if the origin changes its default.
- `{ kind: "pr", branch, number }` fetches `refs/pull/<number>/head` and checks
  it out under the supplied branch name.

An occupied or conflicting branch causes launch to fail. A successful
`discard` removes the agent's session directory and checkout while retaining
cached branches. Services can retry discard after a lost acknowledgement.
Configured workspace handles continue to use their configured directory.

A runner advertising `workspacePreparation: true` accepts
`launch.prepareWorkspace: true`. When requested, the runner sends
`launch_progress` frames on the same connection and request ID before the
ordinary launch result. Use `parseLaunchProgress` and route valid frames to
`RunnerConnection.receive`. A caller using `RunnerConnection.request` can
receive them through `onProgress`. Progress describes workspace selection
(`workspace`), optional dependency preparation (`dependencies` with a
separate `done` or `failed` event), and the handoff to host startup
(`ready`). Dependency failure permits the host to start and a later launch
can retry it. A launch result still acknowledges host startup. Progress is
advisory and does not replay. After a lost result, attach first. If the host
is absent, retry using the same session and repository handles. The runner
retains a prepared checkout, resumes interrupted checkout configuration, and
rejects conflicting checkout selections. Services can continue sending
baseline launches without this field to v1 peers that omit the capability.
A runner sends no progress frames on baseline launches.

The optional launch field `mcp` supplies one service-scoped MCP endpoint
using an HTTPS `url`, bearer `token`, and optional `name`. Absence starts the
ACP session with an empty service MCP list. v1 launches with the original
`{ url, token }` shape use the server name `dispatch`. Prototype runner
binaries require MCP in that shape. For modern runners, omit `mcp`
if there is no endpoint. Use `name` to name a configured endpoint on hosts
that support it. An older host can ignore the additive name and retain its
legacy default. `systemPrompt` is optional in effect (`null` disables it).
The legacy `personaContext` field is optional text for first-prompt context.
The service prepares this text and any instructions it wants included.

## Commands and results

| Command                          | Runner behavior and successful `result.value`                                                                                                      | Capability or configuration                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `launch`                         | Prepare machine-local state, start the host, return `true`. Wait for a running `welcome` before prompting.                                         | Advertised workspace. Use `managedWorkspace` for managed storage and `sharedWorktree` before sending `useWorktreeOf`. |
| `attach`                         | Connect to a running host, return `true`, relay bytes until close.                                                                                 | Open a channel.                                                                                                       |
| `alive`                          | Return a boolean for host presence.                                                                                                                | Baseline.                                                                                                             |
| `stop`                           | Stop the host and return `true`. The caller chooses graceful or forced stop.                                                                       | Baseline.                                                                                                             |
| `discard`                        | Retire stopped session state and return `true`.                                                                                                    | Baseline.                                                                                                             |
| `log`                            | Return a short host diagnostic string.                                                                                                             | Baseline.                                                                                                             |
| `repo`                           | Run the workspace's configured repository tool and return stdout.                                                                                  | Requires a workspace with a configured tool.                                                                          |
| `inspectCheckout`                | Run a `CheckoutQuery` against the bound checkout and return a JSON-encoded `CheckoutReply`. Validate it with `isCheckoutReply`.                    | `checkoutInspection`.                                                                                                 |
| `viewCheckout` / `watchCheckout` | Read a checkout view or subscribe to change pulses. See below.                                                                                     | `checkoutViews`.                                                                                                      |
| `engine`                         | Run an `EngineOperation` and return a JSON-encoded `EngineOperationAck`. When progress is available, stream NDJSON `EngineOperationEvent` records. | `engineManagement`. Open a channel when consuming progress.                                                           |
| `github`                         | Perform a `GitHubOperation` using the runner account and return its JSON reply. See below.                                                         | `githubManagement`, plus `pullRequestStatus` for current-head checks or `pullRequestEvidence` for details and diffs.  |

Use an advertised workspace and an opaque placeholder `agentId` for the
runner-wide `engine` and `github` operations. The runner routes those
operations independently of session bindings. With `useWorktreeOf`, the
value is the handle of a session with an existing checkout on the same runner
and workspace. Omit `repository` for a borrowed checkout.

Runners advertising `sessionCheckout: true` accept the bound
`sessionCheckout` command with the ordinary `agentId` and `workspace`
handles. `operation: {kind: "describe"}` reports the effective checkout.
`operation: {kind: "select", path}` selects an existing absolute directory
on that runner and resolves a Git subdirectory to its checkout root. Use a
null path to return to the session's launch or borrowed checkout. The result
is a JSON string validated by `isSessionCheckout`. It carries the canonical
`path`, whether it is `moved` from the initial checkout, and its
credential-free HTTPS `origin` when available. Newer runners also report the
common `repositoryRoot`, the Git `checkoutRoot`, and the checked-out `branch`
(the short commit when HEAD is detached), or null outside Git. Older runners
can omit these fields, and services treat a missing field as null.

The runner checks directory access under the workload identity and durably
records an accepted selection before responding. Checkout reads and future
host starts use it. A running host keeps its current cwd. Retrying the same
selection is safe, and a service can describe the effective checkout after a
lost response. A selection cannot change the runner, transfer archive
ownership, or select a root that contains runner storage. Outside its own
managed session directory and other sessions' protected `checkout` subtrees,
a checkout must be disjoint from runner storage.
Configured workspaces additionally restrict selection to the configured directory.

When a session borrows a checkout from a runner with this capability,
`useWorktreeOf` captures the source session's effective checkout on the
first launch. The borrower retains it across restarts and can make its own
selection. For an independent managed Git checkout, describe the source
session on that runner, then launch a different session with a new
`repository` request using the returned origin. The new checkout uses refs
from the origin.

Negotiate again on each connection. Require an explicit `true` for optional
capabilities and ignore unknown advertisements. For an absent capability,
omit the command and report that the operation is unavailable. A configured
workspace can support baseline lifecycle operations without managed storage.
An unsupported wire version cannot establish a v1 connection.

An execution error uses `result.error`. An attach to a known missing host
also sets `result.code` to `host-gone`. Losing the connection before the
result leaves the outcome unknown. The service can reattach using the
durable cursor described below.

## Attached session operations

`SessionCommand` and `SessionReply` describe the common host vocabulary.
The public decoder preserves optional `source` on `prompt` and `steer` as
opaque service metadata. The built-in Dispatch ACP host accepts commands
with no `source`, and its adapter validates the legacy Dispatch shape when
present. Omit `source` when connecting to that host from an independent
service. Keep conversation, attribution and scheduling metadata in your
service unless the attached host explicitly supports your schema. Prompt
`images`, if used, must already be readable on the execution machine.
Dispatch-specific event payloads and host reply extensions are in
`apps/server/src/agents/acp/host-protocol.ts`.

| Command                             | Host behavior and service handling                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`                             | Send `welcome`, journal entries after the supplied cursor, and `replay_complete` when requested. See Receipts and replay.                                                                                        |
| `prompt`                            | Submit to the engine and send a receipt. Use journaled events to observe the turn outcome.                                                                                                                       |
| `steer`                             | With `steeringSupported`, send `steer_result` with `injected` or `promptRequired`. Queue a normal prompt if steering is unavailable or a prompt is required.                                                     |
| `interrupt`                         | With `interruptSupported`, cancel the named open turn and send `interrupt_result`. A stale turn sequence never cancels a later turn.                                                                             |
| `cancel`                            | Cancel the current turn without a correlated acknowledgement. Use only when current-turn cancellation is intended.                                                                                               |
| `answer_permission`                 | Answer the request using the advertised option ID, or `null` to decline. The host confirms with `permission_answered` or returns a correlated error.                                                             |
| `set_config`                        | Set an advertised engine option. Dispatch replies with `config_set` and the current options or a correlated error. Omit this command when the host publishes no options.                                         |
| `mcp_inventory` / `background_work` | With `mcpInventorySupported` / `backgroundWorkSupported`, query the current engine session ID. The built-in host replies with `mcp_inventory_result` / `background_work_result` and a Dispatch snapshot payload. |
| `ping`                              | Reply with `pong`.                                                                                                                                                                                               |
| `shutdown`                          | Ask the host to exit. Closure ends the channel.                                                                                                                                                                  |

An older host may lack journal identity and the optional `welcome` flags.
Use its supported baseline, keep such a cursor scoped to a known host
incarnation and avoid automatic retries when a prompt's outcome is unknown.

### Files and Changes

When `ready.checkoutViews` is true, the service can send `viewCheckout` with the bound agent ID, workspace handle and a `CheckoutView` query. The runner resolves the checkout. Successful results carry a JSON string containing `{data}`. Use `isCheckoutViewData(query, data)` to validate the result. An expected read error carries `{status,error}`. The complete UTF-8 response is capped at 16 MiB.

A populated stats view may include `data.outcome` (`"success"` or `"partial"`). A partial result carries usable totals after a best-effort Git probe fails. Omitted outcomes on populated stats are treated as success. `data: null` still means no data, and a fatal read still reports `{status,error}`.

To receive changes, send `watchCheckout` with the same agent and workspace and open its channel. A one-byte pulse (ASCII `1`) signals that setup completed or that contents changed. Coalesce pulses and reread the current view. Release the channel when interest ends. After a transport disconnect, reopen the subscription and reread. Consumers that need durable turn history use session journal replay.

### Surviving a daemon restart

On Linux, the runner's session supervisor records each new host's identity
before allowing it to start the engine. That record belongs to the runner,
survives its TLS connection, and identifies the process within its boot and
PID namespace. A replacement daemon can attach to the same host and journal.
A host that exited, or a machine that rebooted, follows the host-loss path.
When a prompt's outcome is unknown, the service needs a receipt or journal
evidence before deciding whether another delivery is safe.

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

Engine inventory is opt-in for each connection. Runners advertise
`engineManagement: true` in `ready`. A service can set `engineInventory: true`
on its `accept_health` response to receive periodic `engine_inventory` frames.
A plain `accept_health` subscribes to health samples alone.

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

### Optional GitHub account management

Runners that advertise `githubManagement: true` in `ready` accept the
runner-wide `github` command. As with other runner-wide commands, use a
routable workspace and an opaque placeholder agent ID. The operation
supports account status, device-login start, cancel, and logout, plus
repository search and pull request source-branch lookup on github.com.
Replies are JSON strings carried in `result.value`. Account replies have a
`status` of `signed-out`, `signed-in`, `pending`, `unavailable`, or
`failed`. Poll with `status` for the device code while pending and the
account login after authorization. The consumer should expose a pending
code only to the authenticated operator and should keep it out of logs,
inventory, and durable state.

The Linux implementation uses the runner's dedicated workload account.
GitHub CLI login uses the workload user's native credential store and falls
back to the user's gh configuration file on headless systems without a
keyring. Managed checkouts and agent HTTPS Git operations use
the same account through the gh credential helper. A transport disconnect
ends a pending login, and a completed credential remains with that
workload account. Logout removes the active account locally. GitHub
authorization can be revoked separately in GitHub settings.

A peer advertising both `githubManagement` and `pullRequestStatus` accepts
`{type: "pullRequestStatus", owner, repo, number}`. Run the fixed current-head
GitHub query under the workload account. Return the GitHub state, draft flag,
title, head SHA and rollup in `{state, draft, title, head, rollup}`. Rollup
contains up to 100 current-head CheckRun or StatusContext nodes. An empty
array means no checks. Null means incomplete, unavailable, truncated, or
mismatched head. An inaccessible PR has no state. Leave CLI output and
GraphQL diagnostics on the runner. Consumers validate the result and
scope cached observations and notifications to the runner and canonical URL.

A peer advertising `githubManagement` and `pullRequestEvidence` accepts
two additional GitHub operations. Both use the same `owner`, `repo` and
positive PR `number` as the status request.

- `{type: "pullRequestDetails", owner, repo, number}` returns
  `{credentialContext, number, title, body, baseRefName, headRefName,
baseRefOid, headRefOid, additions, deletions, files}`. The files contain
  provider paths and line counts. The fixed query includes up to 100 files.
  An incomplete, denied, or oversized read is unavailable.
- `{type: "pullRequestDiff", owner, repo, number, base, head, credentialContext}`
  returns `{files}` for the GitHub comparison between those full commit SHAs.
  The runner checks that the supplied credential context is still active and
  can read the PR before it compares the commits. GitHub supplies up to 300
  changed files. Files can include a `patch` of up to 32,768 characters.

Replies use the existing JSON string carried by the `github` result. A
JSON `null` or unsuccessful result means unavailable. The supplied Linux
runner caps CLI output at 128 KiB per call and discards provider error
details. It pins the credential across all GitHub calls within an operation.

When the peer also advertises `pullRequestStatus`, a consumer may request
`withCredentialContext: true` on a status operation. A scoped observation
includes `credentialContext` alongside the original fields. A status-only
observation can still be returned if a credential context was unavailable.
Send the flag and the new operations only after negotiation. Existing
consumers can continue to use the original status request and response.

A credential context is an opaque 64-character lowercase hexadecimal handle
for equality comparisons. Treat it as runner-local and sensitive metadata.
It does not grant authority to read GitHub. Credential or runner key changes
can invalidate it. To join provider data or reuse a saved result, match the
runner, repository and PR, relevant commits, and credential context from a
successful fresh read. Keep application policy, derived judgments, and
history in the service that requested the GitHub data.

### Watching pull requests

A v1 peer advertising both `githubManagement: true` and
`pullRequestWatch: true` accepts the GitHub operation
`{type: "watchPullRequests", targets: [{owner, repo, number}, ...]}`.
Use a regular GitHub command envelope with an advertised workspace and any
opaque routing ID. The ID does not need to identify a session. Open the channel
when issuing the request and expect a boolean `true` acknowledgement. Cached
observations may arrive before the acknowledgement. Older peers continue to
use `pullRequestStatus` if advertised.

Each runner-to-service channel data frame contains one UTF-8 JSON line of at
most 1 MiB, validated by `parseGitHubPullRequestWatchEvent`. An observation
includes the target, the runner's sampling time in Unix milliseconds
(`observedAt`), and the same full observation as the scoped status read.
A null observation indicates a lookup failure. A null check rollup indicates
unavailable or incomplete checks, while an empty rollup is authoritative.
The initial snapshot arrives one target at a time as samples become available.
Each new sample carries the time of its provider read. The runner also
replays the latest full observation after a minute without a new delivery,
keeping its original `observedAt`. This allows a receiver to recover a missed
event without applying deltas or mistaking a replay for a fresh provider read. A `{type: "reset"}` event invalidates all prior observations on
the channel after a credential transition. A consumer should discard state on
disconnect or reset, fence off the old connection, and subscribe again after
reconnect. A service can use receipt time to detect a silent subscription.
Renew the subscription to recover delivery while preserving the runner's
provider schedule.

Send the desired set of up to 64 targets when opening each channel. To update
the set, open a replacement and close the previous channel. The ordinary
channel `close` frame releases the subscription. The runner deduplicates
case-insensitively, shares up to two concurrent samples and 12 sample attempts
per rolling minute. Subject to that budget, automatic provider reads run
every 30 seconds for open or draft PRs and every six hours for closed PRs.
Merged PRs have no automatic reads after their initial sample. Failed
lifecycle reads back off from 15 minutes to four hours. Cached delivery
does not consume the provider budget. A new subscription without a cached
sample and an account reset require a fresh initial read. A host can pass `refreshWatch: true` on
`pullRequestStatus` when the watch capability is advertised. For a watched
target this forces a new sample or joins one already in flight, and may return
an error when capacity is exhausted. Regular status reads retain their
existing behavior. All samples use the runner's workload credential.

### Conditional checkout release

Send `checkoutRelease` only to a v1 peer advertising `checkoutRelease: true` in
its ready frame. It uses the existing session and workspace handles. The
`observe` operation replies with a JSON-encoded `CheckoutObservation`. Owner
and borrower handles in that observation are opaque and machine-local. A null
`checkout` for an owned binding means the checkout could not be observed.
A rejected request or missing result is also unavailable.

Stop the session before sending `release`. The host decides whether to pass
the observed `stateId` to authorize removal, or `null` to retain the checkout.
The runner rechecks the state before removal and keeps external checkouts.
`released` means the session is released, `retained` means the session is
released and its owned checkout was kept, and `inUse` means live borrower
bindings still hold the checkout. Retry a deferred release using the same
authorization. Repeating a release is safe, including after a lost reply.
The legacy `discard` command keeps its original behavior for clients using it.

## Session files

A runner advertises `sessionFiles: true` in `ready` to enable the
`sessionFile` command. Send it with the same opaque `agentId` and
`workspace` used to launch the session. Peers that omit the flag continue
to use the existing lifecycle and prompt protocol.

- `operation: { kind: "deliver", name, data }` writes a complete file to the
  session's input directory. `name` is a single filename. `data` is padded
  standard base64. The result value is the absolute runner path for the
  workload to read, including as an ACP prompt image path.
- `operation: { kind: "collect", path }` reads a regular file from the session
  files directory or the effective checkout. Absolute paths must belong to one
  of those roots. Relative paths are relative to the effective checkout.
  The result value is padded standard base64. Traversal, symlinks, hard links,
  and paths outside the bound session's roots are rejected. A deliberately
  shared checkout grants access to its shared files.

Each file holds at most 20 MiB of decoded bytes, including zero-byte files.
Send one transfer at a time per connection. There is no transfer cursor.
An interrupted frame creates no visible file. If a delivery completed but
the acknowledgement was lost, repeat the whole request with the same name
and bytes. Delivery replaces the named file atomically. Collection is
read-only and retries re-read the current file. Commit each successful
collection to service-owned storage before publishing a reference to it.

### Checkout metadata and default-branch files

With both `checkoutInspection: true` and `checkoutMetadata: true`, the v1
`inspectCheckout` request supports two additional queries:

- `{kind: "roots"}` returns the effective checkout root and the common
  repository root. A non-Git directory has a null repository root. Both
  paths are meaningful only on the runner.
- `{kind: "listFiles", path}` lists immediate regular filenames in the
  checkout-relative directory, including ignored files. An absent directory
  returns an empty list. The runner bounds enumeration and rejects traversal.
  Read the selected filenames with the existing bounded `readFile` query.

Share a checkout using the existing session handle. Moves update the
effective binding. A host should reacquire metadata for each discovery
instead of treating equal paths as equal checkouts across machines. Older
v1 peers still accept the original inspection queries.

With both `checkoutInspection: true` and `defaultBranchFiles: true`, send
`{kind: "defaultBranchFiles", directories, waitForRefresh}` for a bounded
set of immediate regular files in selected checkout-relative directories.
The runner observes the origin's default branch in a private Git ref, without
changing the checkout. The reply includes raw UTF-8 files and refresh status.
A caller can list cached files during refresh or wait for a cold snapshot.
A checkout without an origin returns `hasOrigin: false`. Older peers continue
to serve original queries and the workspace-approved `repo` operation.

### Workload model, usage and plugin operations

A peer that advertises both `engineManagement: true` and
`engineCapabilities: true` in its v1 `ready` accepts the following optional
`engine` operations. They use the existing runner-wide routing convention
with a permitted workspace and an opaque caller-supplied request owner.
Clients send these operations only when both flags are present. Existing
inventory, install, update and login clients continue using `engineManagement`
alone. Replies use the existing JSON-encoded ack with a typed `capability`
on success. There is no progress stream for these operations.

- `model_catalog` reads the engine's model choices in the workload's home.
  The optional `model` asks for the effort choices for that model. Other
  models may omit effort, which indicates no observation for those models.
- `provider_usage` returns bounded subscription windows and observation
  times. A provider that could not be read can report empty windows and
  an unavailable reason. The built-in runner uses a fresh read because
  on-disk usage snapshots lack reliable account attribution after sign-in.
- `codex_reset` requires a UUID request ID and the opaque
  `codexResetAccount` from the usage reply. The runner checks it against
  the credential it will use for redemption. A missing handle means the
  action is unavailable. Handles can change when credentials rotate or
  the runner restarts. Reuse the UUID for a retry of the same operation
  and refresh usage after an uncertain result.
- `plugin_status`, `plugin_install` and `plugin_update` refer to a configured
  `name@marketplace` identifier. A runner chooses which plugins and actions
  it supports and how to resolve them. The built-in runner supports its
  Dispatch plugin and rejects other identifiers. Plugin replies publish
  status, versions and available actions without plugin paths or CLI output.

Scope any host-side cache to the runner. A disconnected or older peer gives
an unavailable result. Never substitute another runner's data or the host's
own credentials, catalog or plugin state.

### Session terminals

The V1 `ready.terminals: true` flag opts into `openTerminal`. Services must
check it before sending this request. Its absence means the peer cannot open a
terminal. No protocol version change is required.

Use the existing `request` envelope with a fresh channel ID and
`{ kind: "openTerminal", agentId, workspace }`. The two target fields are
opaque IDs obtained from the session's execution binding. The runner resolves
the current checkout and starts the login shell with its workload identity.
The successful result's string value contains JSON `{ cwd, host, user }`
for display. These fields describe the execution machine.

Open the channel when issuing the request. After the result, send newline-
terminated JSON `TerminalControl` records on the channel. The runner sends
newline-terminated JSON `TerminalEvent` records back. Channel data uses the
existing base64 framing and records can span frames. An `output` record carries
base64 PTY bytes, preserving binary output and partial UTF-8 sequences.
Send `input` with a UTF-8 string (up to 16 KiB) and `resize` with integer
`cols` (2–500) and `rows` (1–200).

Send `detach` to suspend delivery and buffer the last 256 KiB of new output.
Keep the runner channel open. Send `resume` on that channel to drain the
buffer and continue live delivery. These controls are idempotent. The detached
PTY ignores input and resize until resumed. Services can retain previously
delivered output separately and control how long their frontend is allowed to
reconnect. A runner transport disconnect ends its terminals.

Destroy the channel or send a channel `close` to end the terminal and clean up
the shell and its process session. The runner sends `exit` on shell exit or
closes the channel if the worker is lost. Browser authentication, browser
session IDs, tabs, and user interface state belong to the service.
