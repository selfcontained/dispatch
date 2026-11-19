# What Dispatch needs from a runner

**Starting point.** Implement owner review through a built-in local runner and a connected Linux runner. Both should accept the same operations on an opaque agent ID. Keep the native Mac execution path underneath the local implementation. The first release can support a different set of capabilities on each machine. Dispatch must be able to tell the user which operations their selected runner supports.

**Evidence baseline.** This inventory traces the feature branch at `598070c197cc`. GitHub’s main branch was at `8eebbe319863` during the audit. Ten main-branch commits were absent from the feature branch. The compatibility cases below include newer OpenCode launch, resume and verified update behavior, ACP adapter updates, and interruption across conversations. This is a source audit plus evidence from the two real runner sessions. Most rows have not been exercised on both placements. [Lifecycle model](../04-agent-lifecycle.md) · [ACP design](acp-runtime.md) · [Runner contract and compatibility](remote-runner-prototype.md)

## What exists on the wire

The outer protocol already covers launch, attach, liveness, stop, discard, log tail, a configured repository command, and runner-wide engine operations. Its ready frame advertises capabilities. The attached session channel carries prompts, steering, cancellation, permission answers, config changes, inventories, receipts and replay. Both transports should use these contracts. The existing repository command executes one configured operation. It cannot answer arbitrary questions about a managed checkout. The current prompt source also contains Dispatch-specific conversation and scheduling fields. A second service should be able to omit that metadata or have it echoed opaquely. [Execution](../../packages/runner-protocol/src/execution.ts) · [Session](../../packages/runner-protocol/src/session.ts) · [Runner implementation](../../apps/server/src/agents/remote/runner.ts)

## Capability inventory

“Present” means a protocol operation exists. “Partial” means only part of the local workflow has a runner path. “Gap” means the current wire contract lacks the required operation. “Decision” means ownership or support must be explicit before migrating that caller. Each entry includes an acceptance case and its source.

### Placement and session creation

**Choose a machine and location.** **Partial.** Dispatch owns projects, names, defaults and admission policy. The execution side resolves folders, Git context, branch choices and permissions. This Mac supports arbitrary existing folders, non-repos and existing main checkouts. Remote runners support configured folders or managed scratch and repository sessions.

- A default local launch still works in a non-repo. Two runners using an identical folder name each reach their own files. A revoked placement cannot silently fall back to local. [Project matching](../../apps/server/src/projects/matching.ts) · [Path and branch queries](../../apps/server/src/routes/system.ts) · [Placement](../../packages/runner-protocol/src/placement.ts)

**Provision and prepare an agent.** **Partial.** Preserve local worktree location, branch and base selection, allowed local config copying, initial files, dependency setup and phase/error reporting. Managed runners create a scratch directory or checkout from a cache, with new, existing or PR branch choices. Setup files and credentials belong to the selected environment.

- Check a new branch, a direct existing branch, a busy branch, a missing package manager and a retry after partial setup. In the field test a valid checkout still lacked dependencies and the guest install exited 137. [Workspace preparation](../../apps/server/src/agents/workspace-prep.ts) · [File seeding](../../apps/server/src/agents/file-seed.ts) · [Runner Git](../../apps/server/src/agents/remote/repository.ts)

**Track the effective checkout.** **Present for shared child launches.** An ordinary child or reviewer can borrow the author’s effective checkout by opaque agent ID on This Mac or on a capable Linux runner. Each child has its own session. A managed runner retains the checkout until its owner and borrowers have released it. Independent worktrees and workspace moves still need parity coverage.

- Launch a child in the author’s current checkout and another in a separate checkout. Reviewers keep separate sessions and see the author’s uncommitted files. A cross-runner reference is rejected. [Workspace selection](../../apps/server/src/agents/workspace-target.ts) · [Child launch options](../../apps/server/src/shared/mcp/agent-launch-tools.ts) · [Runner supervisor](../../apps/server/src/agents/remote/session-supervisor.ts)

### Running an agent

**Launch, supervise and recover.** **Present for core operations.** The execution side selects binaries and workload identity, builds the environment, starts or resumes the provider host, reports readiness, reattaches, tails bounded logs, stops descendants and discards state. Dispatch persists desired lifecycle and reconciles it with the runner.

- Distinguish spawn, provider-ready and prompt-accepted. Recover a live host without a second invocation. Exercise stale PID, duplicate launch, forced stop and a service restart. [Agent manager](../../apps/server/src/agents/manager.ts) · [Supervisor](../../apps/server/src/agents/remote/session-supervisor.ts) · [Host environment](../../apps/server/src/agents/acp/host-env.ts)

**Deliver turns, permissions and results.** **Present for core operations.** Preserve queued prompts, images, mid-turn steering, targeted interruption, cancel, permission request/answer, runtime config, background work and MCP inventory. Dispatch decides which conversation or human owns a response. The runner delivers it to the correct session.

- Disconnect after prompt acceptance and before completion. Resume from the last contiguous durable event in the same journal. Test journal replacement, an unanswered permission, and cross-conversation interruption. [Session messages](../../packages/runner-protocol/src/session.ts) · [Durable inbox](../../apps/server/src/agents/remote/event-inbox.ts) · [Steering](../../apps/server/src/agents/steering.ts)

**Authorize and connect service tools.** **Partial.** The runner accepts optional service-owned MCP. When present, endpoint reachability, workload trust, the agent’s scoped credential, and revocation must work for the actual engine. Dispatch owns tool authorization and the access ceiling for children.

- A real Codex session lists and calls its tool over authenticated TLS on first launch. In the field test, provider login succeeded while the tool connection failed until the guest trusted the service CA. Also run a session with MCP omitted. [MCP routes](../../apps/server/src/routes/mcp.ts) · [Access ceiling](../../apps/server/src/shared/access-ceiling.ts) · [Host environment](../../apps/server/src/agents/acp/host-env.ts)

### Native runner and Dispatch updates

Local and Linux sessions now start, attach, probe liveness, stop, read logs, and discard state through the same lifecycle operations. The local runner executes these in process and opens the existing Unix socket. Local workspace preparation still supplies the native working directory, engine paths, and environment. Native host discovery remains available to reconciliation and update recovery. The lifecycle implementation includes the local changes through Dispatch 1.7.28 (main at `8f0bac1a`), including cross-conversation interruption and OpenCode V2 startup and resume. OpenCode V2 requires full access, so a restricted owner review needs an engine that supports restricted sessions. [Local runner](../../apps/server/src/agents/local-runner.ts) · [Runtime](../../apps/server/src/agents/acp/runtime.ts)

A native host can complete an accepted turn while its controller is down. A replacement controller can reattach to that host and read events after its saved journal position. The process-level test verifies one provider invocation, one completion, and continued use of the original folder. Before allowing an update with active work, exercise a released old host against a new controller and its rollback version, verify database migration and cursor compatibility, and fence new launches during the handoff. The existing maintenance policy still applies. [Restart test](../../apps/server/test/acp-host.test.ts) · [Update recovery](../../apps/server/src/server/update-recovery-runtime.ts)

### Working with a checkout

**Select and launch owner reviewers.** **Present.** Dispatch requests changed paths, HEAD, a checkout state identifier and bounded file reads from the author’s runner. Dispatch loads ownership rules, selects review personas, checks that the review state still matches, and launches a reviewer in the same checkout. Dispatch owns review threads and findings.

- The original field test failed when Dispatch passed a runner URL to local Git. The [placement parity test](../../e2e/remote-runner/owner-review.spec.ts) checks an unpublished commit and an untracked marker, reads it through each reviewer, archives the reviewer, and confirms the author retains access. Staged, unstaged and renamed path handling have [checkout-level tests](../../apps/server/test/checkout-inspection.test.ts). [Owner handler](../../apps/server/src/server/mcp-persona-handlers.ts) · [Changed-file collection](../../apps/server/src/personas/codeowners.ts) · [Review workflow](../code-owner-reviews.md)

**Display Changes and worktree state.** **Gap.** Base/ref resolution, file lists, diff stats, individual hunks, image diffs, repo identity and dirty/unmerged state read the checkout. Dispatch owns diff comments, rendering and refresh timing. Background refreshers must use the same placement as foreground requests.

- Compare an untracked file, rename, image and dirty worktree against the same base. Handle a missing base without probing another machine. [Agent diff](../../apps/server/src/shared/git/agent-diff.ts) · [Agent routes](../../apps/server/src/routes/agents/lifecycle-routes.ts) · [Stats refresher](../../apps/server/src/agents/diff-stats-refresher.ts)

**Discover repositories and interact with GitHub.** **Partial.** Runner Git can provision a checkout. Repository search, branch/PR lookup, PR status/checks and risk analysis have separate callers. Decide explicitly whether each uses a Dispatch GitHub identity or the workload’s GitHub identity. A project association alone grants no GitHub access.

- From a fresh runner account, sign in to GitHub, clone a private test repo, fetch a fork PR, and verify the identity used for push and PR creation. Sign out and verify isolation from other runners. Local-only review must also work with no published branch. [Search](../../apps/server/src/routes/runner-repositories.ts) · [PR reader](../../apps/server/src/agents/pull-request-reader.ts) · [Refresh](../../apps/server/src/agents/pull-request-refresher.ts) · [Risk inputs](../../apps/server/src/agents/merge-risk/sources.ts)

**Browse workspace files.** **Gap.** Directory listing, filtering/ignore rules, indexing and bounded text/image reads require the effective workspace. Preserve traversal, symlink, size and binary-file handling on the execution side.

- Expand a directory and open a file in the runner checkout. A path escaping the workspace is refused there. [Workspace routes](../../apps/server/src/routes/agents/workspace-routes.ts) · [File explorer](../file-explorer.md)

**Move attachments across the boundary.** **Partial.** Dispatch stores and serves user-visible attachments. Initial files, images supplied to a prompt, and files a runner agent posts by path require explicit delivery or collection. A runner-local file path in a chat post is insufficient.

- Upload an image, deliver it to one runner agent, then have it post a generated file that opens after its session is archived. [File routes](../../apps/server/src/routes/files.ts) · [Prompt images](../../apps/server/src/agents/acp/prompt-images.ts) · [Attachment behavior](../file-attachments.md)

### Repository automation and cleanup

**Discover repo tools, hooks and instructions.** **Partial.** Local sessions load checkout-specific persona files, tool manifests and lifecycle hooks. Local stop hooks skip remote placements today. The proof command on configured workspaces covers only a narrow case. Service policy controls what may run. The execution side resolves the manifest and runs the approved operation in the correct checkout.

- A repo dev tool uses the runner’s working directory. Stop hooks run with their documented semantics for the launch and moved checkout. Missing tools are reported explicitly. [Repo tools](../../apps/server/src/shared/mcp/repo-tools.ts) · [Hooks](../../apps/server/src/agents/lifecycle-hooks.ts) · [Persona discovery](../../apps/server/src/personas/catalog.ts)

**Stop, archive and retain shared work.** **Partial.** Local archive checks dirty/unmerged changes, cleanup policy and live references. Managed runners queue offline cleanup. A shared review checkout adds a borrower whose archive must release its reference. Dispatch owns archive confirmation, history and retention.

- Archive the reviewer first and continue author work. Archive the owner while a borrower exists, disconnect during cleanup, restart, and retry without deleting another session’s work. Include a pre-migration live agent. [Archive and reference checks](../../apps/server/src/agents/archive.ts) · [Retention](../../apps/server/src/agents/retention.ts) · [Runner supervisor](../../apps/server/src/agents/remote/session-supervisor.ts)

### Machine capabilities and integrations

**Manage engines and credentials.** **Partial.** Inventory, versions, supported actions, install/update, and Codex/Claude login are runner-scoped. Model and effort catalogs, plugin install/status, provider usage, account reset and quota probes also need explicit machine/account scope. Dispatch can aggregate sanitized results.

- Compare two runners signed into different accounts. Verify first login, cancel, async completion, update, unavailable actions, selected model/effort and version-compatible OpenCode resume. [Engine operations](../../packages/runner-protocol/src/engine-management.ts) · [Model discovery](../../apps/server/src/agents/engine-models.ts) · [Provider plans](../../apps/server/src/agents/provider-plans.ts) · [Plugin routes](../../apps/server/src/routes/plugin.ts)

**Human terminals and desktop integrations.** **Decision per capability.** A human PTY opened in the agent checkout needs machine-local process, resize, input, detach/resume and close. Desktop IDE, clipboard, browser and computer-use actions need an explicit target and OS permissions. Some belong to the operator’s desktop, even when the agent runs elsewhere.

- Keep native Mac behavior. A remote terminal, if offered, opens in the correct guest with the correct identity. Never interpret a remote path as a request to open a Mac file. [Human terminal manager](../../apps/server/src/terminal/manager.ts) · [Clipboard behavior](../../apps/server/src/routes/files.ts) · [Mac integration](../macos-app.md)

**Serve previews.** **Deferred.** An agent can publish a preview link. Reaching a server bound inside a remote execution environment is a separate capability. Dispatch owns the browser-facing URL and access policy.

- When implemented, two runners can independently serve the same guest port. Access and live reload end for the revoked runner. [Preview acceptance in handoff](remote-runner-handoff.md)

**Report health and manage the runner.** **Present in part.** Remote registration, pairing, certificates, revocation, periodic health and engine inventory already exist. Keep wire-version negotiation, last-seen time, stale reports, session counts, CPU, memory, diagnostics, safe update and recovery visible. Built-in local execution needs a stable identity and capability set. The app installer can own its lifecycle.

- An older runner lacks an optional feature and still executes supported commands. A revoked runner stays revoked. A busy update defers. Distinguish stale data from a measured zero. [Health](../../packages/runner-protocol/src/health.ts) · [Enrollment](../../packages/runner-protocol/src/enrollment.ts) · [Installer](../../bin/install-dispatch-runner.sh)

### Other launch entry points

**Launch from tasks, jobs, templates and agent tools.** **Cross-cutting.** The UI is one caller. Scheduled jobs, templates, child launches and reviewers can inherit a project, directory, access policy and defaults. Dispatch owns schedules, task state, messages, brain objects and project membership. Some callers currently infer scope from a local repo root.

- Launch the same project via Create Agent, a task, a template and a child. Verify placement and project association across restart. A project may contain a scratch session without a repository. [Jobs](../../apps/server/src/jobs/service.ts) · [Templates](../../apps/server/src/templates/service.ts) · [Repo-keyed brain storage](../../apps/server/src/brain/store.ts) · [Child options](../../apps/server/src/shared/mcp/agent-launch-tools.ts)

## First implementation and release gate

1. **Characterize local owner review before moving it.** Use an unpublished feature branch, checkout-local owner rules and a persona, staged and unstaged changes, and an untracked file. Capture the selected base, paths, owners and effective reviewer cwd. Cover the case where the launcher differs from the display parent. [Existing owner tests](../../apps/server/test/mcp-persona-codeowners.test.ts)
2. **Define the minimum portable operations for that fixture.** An authenticated service asks the runner for checkout changes relative to a base and bounded reads of the relevant config. The normal launch command gains an optional way to use the existing worktree of a named agent on the same runner. Define missing checkout/base, wrong placement, unsupported capability, author archive, and retry responses. The runner validates the binding. Dispatch parses ownership rules, selects people/personas and tracks findings. A shared mutable checkout requires a way to identify the reviewed state, including dirty files. A commit hash alone cannot do that. Define what “read-only reviewer” can actually enforce on each platform before promising it.
3. **Implement the built-in runner first, then the Linux implementation.** Use the same typed requests, responses, validation and contract fixtures. The local transport can call in process. Keep path resolution, Git invocation and file access inside the implementation. The candidate feature should pass existing local tests before remote support is enabled.
4. **Gate the migrated workflow on both implementations.** The same test launches the reviewer on the author’s machine, verifies it can see the unpublished and uncommitted changes, and verifies archiving it leaves the author working. Add remote disconnect/reconnect, revocation, and a second runner with the same folder name. Forbid direct filesystem, Git/process helpers and local-cwd fallbacks in the migrated review orchestration, including indirect helper calls. Run the independent protocol-consumer test. Finally repeat both real-agent tasks from their runner sessions. [Consumer test](../../apps/server/test/runner-protocol-consumer.test.ts) · [Multi-runner acceptance](../../e2e/remote-runner/acceptance.spec.ts)

## Keeping the list honest

Treat this as a register of workflows. Before migrating a row, enumerate its UI, HTTP, MCP, background worker and archive/recovery entry points. Trace their use of filesystem APIs, Git/gh, process spawning, home directories, provider state and machine-local URLs. Record the implementation owner, negotiated capability, local baseline test, remote test and supported exception. Mark a row complete only when its callers use the boundary and the shared acceptance case passes. A source link or matching method signature alone is insufficient evidence.

Repeat the audit against main at each integration. Capability-specific contract tests should run for local and Linux execution, with platform-only and deferred cases visibly identified. Existing live sessions, old runners and outstanding durable events need compatibility fixtures throughout the transition. The unverified areas with the highest consequence are shared-worktree lifecycle, first-launch MCP trust, private GitHub authentication, artifact transfer, native desktop permissions, and update/recovery across versions.
