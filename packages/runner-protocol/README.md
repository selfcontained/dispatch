# Runner protocol

`@dispatch/runner-protocol/contract` defines the runner operations, inputs, results, errors, channels and events. The controller uses these operations with both its local child and enrolled runners. The package also defines enrollment, host journaling, and protected update messages.

## Addressing and transport

The controller selects a runner from the session row's placement. The local child uses its authenticated Unix socket. Enrolled runners initiate an outbound TLS connection using their enrollment certificate. The controller takes the registration identity from that connection and checks the session's placement before writing. The runner resolves session handles against its own stored bindings.

Both connections carry operation requests and correlated replies. Terminal and watch channels and blob transfers on enrolled connections use credit. The aggregate window bounds unacknowledged stream payload in each direction. A path-blob frame is available on the local socket only. A disconnected enrolled read reports `unavailable`. A mutation whose acknowledgement was lost reports `unknown_outcome`.

An enrolled runner also reports the protected updater's durable `update_status` on the authenticated connection. This observation lets the controller reconcile an attempt after reconnect. It carries no operation request.

For enrollment, decode successful HTTP responses with `parseConnectCreated` and `parseConnectPoll`. Verify the issued certificate and CA before saving credentials. For session attachment, parse host commands with `parseSessionCommand`. Host channels retain their existing NDJSON framing.

## Receipts and replay

| Signal                              | Meaning                                               |
| ----------------------------------- | ----------------------------------------------------- |
| Successful `session.launch` reply   | The runner spawned the guest host process.            |
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

## Verification

Run `pnpm run test:runner-packages` for the operation vocabulary, framing, workload and conformance fixtures. `pnpm run test:runner-protocol` exercises the host and enrollment decoders. The server tests `remote-runner-connect` and `remote-runner-enrollment` exercise registration and certificate handling on local TLS peers. The Linux integration lane is `pnpm run test:e2e:remote-runners`.
