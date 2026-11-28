# Archive outcome parity

Main's model is unchanged. UI/API and MCP use `auto` when no mode is supplied. The UI keeps its existing warning and Keep/Remove choices. A cascade uses `force`, independent of its parent's mode.

The table is the independent oracle in `apps/server/test/archive-outcome-parity.test.ts`. Each row runs for Local folder, Local repository, and enrolled runner handlers, through the HTTP DELETE route, MCP `archive_agent`, and cascade (`deleteAgentDirect`): **81 cases**, plus three force-removal checks preserving pre-existing user branches. “Branch” below means a Dispatch-created worktree branch; keeping the checkout preserves its HEAD and bytes.

| Checkout state    | Mode  | UI/API and MCP checkout + branch | Cascade checkout + branch |
| ----------------- | ----- | -------------------------------- | ------------------------- |
| Clean             | auto  | Remove                           | Remove                    |
| Clean             | keep  | Keep                             | Remove                    |
| Clean             | force | Remove                           | Remove                    |
| Uncommitted files | auto  | Keep                             | Remove                    |
| Uncommitted files | keep  | Keep                             | Remove                    |
| Uncommitted files | force | Remove                           | Remove                    |
| Unmerged commit   | auto  | Keep                             | Remove                    |
| Unmerged commit   | keep  | Keep                             | Remove                    |
| Unmerged commit   | force | Remove                           | Remove                    |

Every case asserts the stopped host directory, active binding, binding sidecars, and preparation receipt directory are gone. Shared repository caches and retirement tombstones remain deliberately: caches serve other sessions, and tombstones prevent stale launches from resurrecting an archived session. An intentional Keep leaves only the checkout and branch belonging to that session.

The fixture in `apps/server/test/helpers/archive-parity.ts` prepares real Git worktrees through the real Local child or enrolled workspace/session handlers. GitHub-shaped URLs are rewritten to an isolated local bare repo; no network, engines, or credentials are used. The controller database and OS process launcher are substituted; the matrix covers stopped sessions, not Linux UID isolation or Docker transport. Existing supervisor tests cover process identity and borrower protections. Added supervisor tests prove an owner's metadata remains usable by its borrower and that a failed preparation-metadata cleanup retries after the active binding is gone.

The observed differences were metadata-only: enrolled retirement left repository sidecars on Keep, and preparation receipt directories survived both Keep and Remove. `packages/runner/src/workload/agents/remote/session-supervisor.ts` now shares metadata removal between release and retirement; `packages/runner/src/platform/linux-privsep/index.ts` supplies receipt-only removal, wired in `packages/runner/src/workload/agents/remote/runner.ts`. Checkout decisions and branch deletion rules are unchanged. While a borrower or checkout cleanup still needs ownership evidence, metadata stays pending for retry rather than being discarded early.

Previously kept runner checkouts can be found by comparing runner `sessions/` directories and Git worktree registrations with archived controller rows and surviving bindings/receipts. Confirm ownership and user intent before removal, then use Git's worktree removal and the recorded branch cleanup; arbitrary recursive deletion would leave Git registrations behind. This change does not scan or delete historical kept checkouts.
