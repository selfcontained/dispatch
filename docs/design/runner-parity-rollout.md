# Runner parity rollout

The runner owns observations and actions that require a session checkout, machine process or workload credential. Dispatch owns project membership, user permissions, schedules, notification policy, history and delivery to browsers. The built-in Mac/Linux runner keeps native execution and arbitrary local folders. Use the [capability inventory](runner-capability-inventory.md) to trace callers.

The branch already exercises session supervision, shared reviewer checkouts, checkout inspection, scoped GitHub login, and live Files and Changes. Work through the following in order. Each step should leave existing callers usable.

| Order | Work                                                                                                                                                                                                                                                      | What proves it                                                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Move PR lifecycle and CI reads to the agent’s runner. Partition deduplication, manual refresh, notices and evidence by placement. Move merge-risk source collection to the same account, then let runners observe tracked PRs and send changed snapshots. | Two machines track the same URL with different visibility. A forced refresh, disconnect, account switch and reconnect produce the right card and notifications for each. An old runner reports unavailable. |
| 2     | Finish repository identity, worktree changes and archive decisions. Use the owning runner for dirty/unmerged checks, moves and cleanup. Exercise every launch caller including tasks, jobs, templates and nested children.                                | Replay both archive orders with a live borrower, offline cleanup and restart. Recover an existing native folder session and its project association.                                                        |
| 3     | Deliver prompt files and collect posted files across the runner boundary. Keep durable copies in Dispatch.                                                                                                                                                | An agent reads an uploaded image and posts a generated file. The browser can still open it after archive. Cover interrupted transfers and size limits.                                                      |
| 4     | Resolve repo manifests, persona definitions, instructions and lifecycle hooks in the effective checkout. Execute only service-authorized operations under the workload identity.                                                                          | Two checkouts with different tools and identical paths produce different catalogs. Stop and move use the right hooks.                                                                                       |
| 5     | Audit model and effort choices, provider usage, plugins, and all account-dependent probes. Separate terminal processes on the execution machine from clipboard, IDE and browser actions on the operator desktop.                                          | Compare two workload homes and exercise native Mac/Linux flows. An unsupported action has an explicit result. Scope remote port forwarding separately.                                                      |
| 6     | Run the native/remote contract suite and repeat a real task with a child and owner review. Audit HTTP, MCP, jobs, background refresh, recovery and archive for residual local filesystem/process calls.                                                   | Verify version negotiation, replay, reconnect, revocation and retained sessions after a Dispatch restart. Record which updates can safely reattach to existing hosts before changing update policy.         |

## First checkpoint

Scheduled and manual PR reads now use the selected runner. The optional `pullRequestStatus` capability returns lifecycle and current-head checks. Dispatch isolates cached observations, in-flight replies and notices by runner and URL. The Linux browser fixture posts a private PR, observes the initial and changed checks in an open card, and forces a fresh read from the same runner.

Merge-risk details and commit comparisons now use the owning runner's GitHub credential. Dispatch matches the credential context from the status and details reads, partitions assessment reservations and history by runner and credential, and checks current PR access before using saved explanations. Unscoped assessments are visible only to the native placement. The wire returns GitHub source fields. Dispatch retains evidence selection, review history, policy and paid calls. An older runner can still report lifecycle and checks.

Dispatch now sends the union of tracked PRs to each capable runner. Runner observations include sampling time and full current state so a missed update can be recovered on the next sample. Reconnect reopens the watch, and account reset clears the previous credential’s snapshots. Older peers continue using scheduled reads. The Dispatch host still owns browser events, dismissals, and notices.

## Workspace preparation

The built-in runner probes the launch path and Git state, prepares native
worktrees, and returns the effective directory, selected base and Git context
to Dispatch. Dispatch still resolves project membership and picks launch
options. A selected native project's inferred HTTPS origin comes from the
native runner because that is where the project path is registered.

Enrolled runners bind the workspace and session handles on the authenticated
connection. Their configured directories, managed scratch directories, and
repository checkouts are machine-local. Managed repository preparation can
report progress through the optional v1 `workspacePreparation` capability,
including dependency installation as the workload account. The service maps
that progress to its own startup UI. Existing v1 launchers can continue to use
the baseline launch request and result.

## Live updates

Each observation needs an owning machine/account, freshness, a bounded payload, and a way to reconcile after a disconnect. Dispatch tracks which resources matter and projects observations into existing UI events. Test missed events and late replies from replaced connections. Preserve the difference between an empty result and unavailable data. Use the existing refresh budget while migrating PR reads, then test subscription and reconciliation behavior independently of browser count.

## Checkpoints

Ship each capability through its normal local and remote entry points, test older peers, and update the inventory with evidence. Keep release/update policy changes separate until the restart and mixed-version tests establish what can safely coexist.

A launch with service MCP uses the HTTPS URL as seen from the workload.
The runner stages its enrollment CA in the private host directory and the
host adds it to the engine's TLS bundles before spawning the adapter. For
an endpoint on a separate private CA, the runner operator can configure
`trustBundle` with the additional roots. The v1 launch shape and optional
`mcp` field are unchanged. An attach after disconnect uses the opaque
session handle and reuses the running host without resending its bearer.
The service validates the bearer against the intended session and owns
revocation and child access policy.

The supervisor regression exercises the host's TLS bundles against the
Dispatch MCP route with a loopback client. To repeat the offline tool call
with a real Codex app-server on a fresh thread, run
`DISPATCH_TEST_CODEX_BIN="$(command -v codex)" pnpm --filter @dispatch/server exec vitest run test/remote-runner-supervisor.test.ts -t 'fresh real Codex'`.

Session checkout selection now runs on the owning runner. Dispatch preserves
the machine binding and project membership and records the selected path
after runner acknowledgement. Borrowers retain the effective directory
captured at launch. Independent MCP worktrees use the effective checkout's
HTTPS origin and a distinct repository preparation request. Project
templates and scheduled jobs retain explicit runner locators, and task
launches use the selected template placement. A new checkout uses a
published base from its origin. Borrowing shares the existing files,
including unpublished changes.

Archive observes the checkout bound to the session on its owning runner.
Moving the session to another directory leaves archive ownership with the
original checkout. Dispatch stores the cleanup policy and the observed state
ID for retries. The runner checks that state again under its checkout lock
and defers removal while another session holds a borrower binding. Older
runners keep their legacy protocol, and managed cleanup requested by a newer
Dispatch waits for a runner that advertises conditional release.
