# Context transfer foundation

A context-limited task needs a recoverable handoff before a successor can safely
continue. This foundation validates a budget snapshot and persists one transfer
intent. It does not launch agents, stop predecessors, change permissions or grant
filesystem ownership. Nothing registers it with the manager, ACP driver or MCP;
preparation is disabled by default. No live model or reserve configuration changes.

## Budget contract

Version `1` accepts an exact next rendered input count covering system, schemas,
history, tool results and images. Cached input is a subset, never added again.
Unknown, incomplete, stale, future or identity-mismatched observations block.
The current runtime identity binds agent/session/model, normalized absolute cwd,
branch/head, dirty state, permissions and a budget-profile hash covering tokenizer,
template, configured caps and reserve policy. A trusted future adapter must supply
these facts and resolve the physical worktree; model summaries are not authority.
No real tokenizer or engine accounting is implemented here.

For context `C`, exact rendered input `P`, effective output `O`, tool margin `T`
and handoff margin `H`, the ceiling is `min(inputCap ?? C, C - O - T - H)`.
Output is reserved once. Equality fits; one token over requests compaction, then
allows preparation only if an exact post-compaction snapshot is still too large.
The contract is independent of an engine's retrospective usage fields or native
compaction formula. It neither fixes nor proves installed OpenCode reserve behavior.

## Durable intent

`0039_context_transfers.sql` adds an unused table. Requests store private handoff
references and commitments, not conversation text. The handoff binds objective,
original authorization references, pending permissions, workspace identity and
artifact hashes. These are metadata, not authenticated approval or proof that the
referenced files exist; the later adapter must verify custody/content and current
permissions before any real transfer.

The ledger permits one immutable request per predecessor/boundary and one attempt
per trusted task chain, including cancelled/failed attempts. A partial unique index
prevents simultaneous open intents for the same normalized cwd. The future trusted
controller must derive chain identity and physical cwd rather than accept model
chosen keys. This index is not a native tool, process or MCP write lease.

| State                  | Meaning                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `prepared`             | Exact insufficient post-compaction budget and handoff committed.                                        |
| `launch_reserved`      | Stable reconciliation key persisted; no launcher is called.                                             |
| `receipt_recorded`     | A supplied successor ID is bound to that key. A receipt is not pickup.                                  |
| `pickup_verified`      | Supplied acknowledgement matches handoff and observed predecessor identity. Still no writer activation. |
| `cancelled` / `failed` | Terminal recovery metadata; late receipts cannot revive the intent.                                     |

All transitions use revision/state compare-and-set. Concurrent duplicate events
reconcile the same intent; mismatched handoffs or competing successors fail.
Replaying an immutable preparation after a lost response returns its durable row,
even after the original observation ages. Launch reservation separately checks
current identity. Restarting a coordinator does not create a second launch key.
Cancellation remains available when preparation is disabled. Terminal attempts
require explicit supervised recovery before a new chain can be considered.

## Remaining activation gates

There is no `active` state or activation callback. A future runtime must first
prove exact version-bound budget accounting, compaction outcome and authority
custody, then implement read-only standby, explicit pickup and enforced native
edit/write/bash plus MCP fencing. Quiesce and drain owned work before transferring
one writer; revoke old delivery/mutation capabilities and reconcile process identity.
An MCP-only lease or an instruction to wait does not stop native edits or shell
children. No automatic launch or writer activation is safe until these gates pass.

Tests exercise synthetic exact/unknown budgets, boundaries/cache/images flags,
profile/worktree/permission changes, concurrent preparation, transaction rollback,
lost responses/reconstruction, competing successors, mismatched pickup and late
receipt cancellation against an isolated PostgreSQL database. Those controls are
not real engine pickup, authority authentication or filesystem fencing evidence.
The table can ship empty without enabling a runtime path; no deployment is part
of this change. The next slice should implement the adapter and standby/write
barrier behind a disabled gate before adding automatic behavior.
