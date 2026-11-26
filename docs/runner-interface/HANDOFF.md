> **Remove `docs/runner-interface/` before the PR is marked ready (fold it into T40).** It is a plan doc committed only for this handoff.

# Runner interface: handoff

State at integration head `9dfe3efff`, branch `agt_6500d94e4ff5/agent-4e4ff5`, draft PR #1540. The full design, decisions and task text are in [`design.md`](design.md) (revision 4). Where this file and the design disagree, the code wins, then this file.

## Goal

1. Dispatch talks to every machine an agent runs on through **one `Runner` interface** (`@dispatch/runner-protocol`), and nothing else.
2. There is **one runner program** (`@dispatch/runner`): "local" is that program as a child process the app starts; "remote" is the same program on Linux behind TLS.
3. Every agent has a placement `{runner}`; Dispatch code does not branch on local versus remote.
4. **Local users see exactly origin/main.** Runner agents can do everything local agents can.
5. It ships as one PR, after T40 seals wire v1.

## Owner rules (standing, not negotiable)

- **Local = origin/main exactly**, even where a difference looks safer. For every difference you find or introduce, ask "what does main do?" and do that (D9).
- **No restriction as a fix.** Never close a gap by refusing, hiding, capping, confining or dropping a tool for runner callers. If the real fix is not ready, the gap stays a baseline entry.
- **No invented behaviour**, UI copy or disclaimers. A task does only what main does, the same on a runner, or what an owner decision (D1–D12 in the design, section 0.5) says.
- **No separate remote UX.** Runner agents get the same controls and flows as local ones. Known gaps the owner accepted are listed below; nothing else.
- **Runner agents can do everything local agents can**, except take a folder a user named on that machine (D7: runners make their own checkouts from a project's repository; an agent's own `set_workspace` takes any directory its account can use).
- **One PR at the end. Never merge to main. The PR stays draft.**
- **At most three parallel builders, on non-overlapping files.** Five caused conflicts and worse results.
- **Right-sized verification:** reviewers only for files in the diff; mutation proofs only for critical logic; no repeated-run rituals; keep the real-host runs listed under "Unverified".
- **No new CI jobs or slow tests without stating their cost and value first.** CI budget is about 5 minutes.
- **The parity oracle is branch-only:** not in CI, run in full once per milestone, not alongside other heavy checks.

## How to work

### Where things live

| Package or path                                                        | What                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/runner-protocol`                                             | The contract: `src/contract/**` (74 operations, schemas, errors, surface snapshot)                                                                     |
| `packages/runner-client`                                               | `Runner`/`Runners` client, operation framing, existing host framing and launcher channel                                                               |
| `packages/runner`                                                      | The runner program: `src/core/` (workspace, repository, checkout, sessions, engines, github), `src/platform/{posix-user,linux-privsep}/`, `src/local/` |
| `packages/runner-conformance`                                          | Scenarios for every operation, `baseline.json` (red entries per lane), reference client                                                                |
| `apps/server/src/runners/`                                             | Dispatch side: `local.ts` (local adapter, temporary in-process fallbacks), `enrolled/**` (remote), `controller-machine.ts`                             |
| `apps/server/src/agents/remote/`                                       | Controller enrollment, authenticated operation connections and update coordination                                                                     |
| `apps/server/src/agents/acp/`                                          | Agent host, driver, runtime. The host is generic after T22 (T22b finishes it)                                                                          |
| `scripts/check-runner-boundary.mjs`, `scripts/runner-restrictions.mjs` | Boundary scanner and restriction anchors                                                                                                               |
| `scripts/runner-local-parity/`                                         | Local parity oracle against a pinned main                                                                                                              |

Local sockets and authenticated enrolled connections carry the same contract operations. The enrolled supervisor lives in `packages/runner`.

### Gates

| Gate               | Command                                                                                                    | Notes                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types and boundary | `pnpm run check`                                                                                           | Runs the boundary scanner first, then each package                                                                                                                                       |
| Runner packages    | `pnpm run test:runner-packages`                                                                            | protocol, client, runner, conformance unit tests                                                                                                                                         |
| Boundary scanner   | `node scripts/check-runner-boundary.mjs`                                                                   | Baseline `scripts/runner-boundary-baseline.json` is **shrink-only**: a new hit fails; a fixed hit must be deleted from the baseline in the same commit (a stale entry fails too)         |
| Caller parity (E9) | `apps/server/test/mcp-caller-parity.test.ts` (in `pnpm run test`)                                          | A runner caller gets the same tools and accepted inputs as a local one                                                                                                                   |
| Owner coverage     | `PR_BASE_SHA=<base> PR_HEAD_SHA=<head> bun scripts/ci-owner-coverage.ts`                                   | Every **added or modified** file needs an explicit owner in `.agents/owners.json`, not just new ones. Touching a file nobody owns fails CI                                               |
| Surface snapshot   | `pnpm --filter @dispatch/runner-protocol surface` (and `@dispatch/runner-client surface` for the launcher) | Regenerate after any contract change; the diff must show only your change                                                                                                                |
| Migrations         | next number is `0069`                                                                                      | Add the rewind lines for your migration to `dropTasks()` in `apps/server/test/migrations.test.ts` (drop what it adds, delete its `pgmigrations` row), or the migration replay test fails |
| Conformance        | `pnpm run conformance:local` / `pnpm run conformance:remote`                                               | Local runs the real child; remote needs Docker, `bun`, `openssl`, `node:22-bookworm`. On demand, not every commit                                                                        |
| Parity oracle      | `DISPATCH_PARITY_DATABASE_URL=… pnpm run parity:local`                                                     | Scratch Postgres on loopback, about 6 minutes. Once per milestone. `--only '<regex>'` for a subset                                                                                       |
| Full tests         | `pnpm run test`                                                                                            | Server tests need a test database URL pointed at a dev Postgres, or about 39 suites false-fail                                                                                           |

Boundary rules: **R1** placement reads, locators and controller-machine imports in Dispatch; **R2** host access (fs, process, os, git) from Dispatch code; **R3** local adapter methods and in-process side channels that bypass the child; **R5** Dispatch vocabulary or imports crossing the package boundary (either way); **R6** placement reads and protocol values in the web app; **R7** named "runner can do less" restrictions (design, Appendix D; anchors in `runner-restrictions.mjs`).

**Current counts:** R1 65, R2 257, R3 6, R5 45, R6 7, R7 10. R6 exempts only the explicitly listed runner management screens (settings, health, updates and runner GitHub account); general UI and shared hooks remain covered.

**Starting line:** R1 77, R2 269, R3 15, R5 49, R6 34, R7 19. Every task lowers at least one; none may raise any.

Commit style: a move and a behaviour change are separate commits. Take main at each milestone and move the parity pin (`scripts/runner-local-parity/main-pin.json`) only in that merge commit.

## Remaining tasks, in order

Three lanes that share no files. A task that must touch another lane's file waits for that lane. Full text for each is in `design.md` section 5.

### Lane A: runner program, supervisor, v1 codec

1. **T23b · One binding store.** Replace the linux-privsep adapter over the supervisor's files with the core's store, through an L4-style one-time import that leaves the old files readable until T40.
   - _Start:_ `packages/runner/src/platform/linux-privsep/bindings.ts`, `packages/runner/src/{core/workspace,local/bindings}.ts`, `agents/remote/session-{supervisor,storage}.ts`, `agents/local-runner.ts`, `runners/local.ts`.
   - _Acceptance:_ local: L4 import cases, archive and select unchanged. Runner: probation rollback reads the same session; symlink-swap tests kept. R3 `bindWorkspace`, `checkoutRelease`, `requestedWorktree`, `resolveLaunchDirectory` and `local.ts`'s in-process checkout reads deleted.
   - _Traps:_ privilege boundary. Every path root touches must be reached only through directories the workload cannot write (`assertProtected`). Sessions an older build prepared finish on their path.
   - Also decide **N12** here ("what does main do?": main runs the user's Git config and hooks).
2. **T29 · Install, update, plugins.** One engine manager on every platform. Closes N34. _Start:_ `engine-updates.ts`, `engine-runner-executor.ts`, `plugin-status.ts`. _Trap:_ still no automatic install locally.
3. **T30 · Catalog and learning.** Learning keyed by runner, catalog through the interface. Closes N30 (anchor in `manager.ts`: wait for lane B to leave it). _Trap:_ the learned-model settings key must stay main's.
4. **L5 · Signed Mac and systemd validation.** Needs the owner's approval for a signed build and a machine or VM. Ask first.
5. **T40 · Seal v1.** Move the app-local engine/plugin host implementations (the host portions of `agents/engine-updates.ts`, `agents/remote/engine-runner-executor.ts`, the engine/plugin portions of `agents/remote/engine-capability-worker.ts`, `shared/plugin-status.ts`) into `packages/runner` when the in-process fallback is removed; T29 routes through EnginePort without a reverse package dependency. Delete the codec, locators, capability refusals and legacy anchors (N14, N16, N29, N35, N13 if not closed), move the runner out of `apps/server`, turn baselines into absolute bans, delete `docs/runner-interface/`. Last.

### Lane B: manager, admission, host, MCP

1. **T22b · Host imports nothing from Dispatch.** The R5 imports in `acp/driver.ts`, `acp/host-env.ts` (3), `acp/host/main.ts`, `acp/opencode-instructions.ts` become inputs. _Acceptance:_ T22's host goldens unchanged. _Trap:_ live main-era hosts. Move first, change second.
2. **T34 · Repository identity.** One identity for Brain, tasks, agent list, history, loop handoff; a runner session takes its project's key (D5, D8). Closes N18, N19. Deletes R3 `canonicalPath`, `inferRepositoryUrl`, `resolveProjectRoot`. _Trap:_ never rewrite an existing local key; Brain memory orphans silently.
3. **T35 · Personas.** Discovery and authoring through checkout operations; `checkout.read` digest, `checkout.write` served. Closes N23, N24. _Trap:_ writes as the workload, behind the digest guard.
4. **T36 · `launch_agent`, children, reviews.** One admission with local's rules. Closes N1, N2, N4 (`launch-admission.ts`). Needs T25 (done) and T35. _Trap:_ access escalation; re-run the ceiling tests.
5. **T31 · Usage, watches, reset.** One cached reporter per runner, no runner-only cap. Closes N17 (`routes/mcp.ts`). _Trap:_ a reset spends a real credit. Fixture transport only.

### Lane C: web, tasks, icons

1. **T13b · Task briefings and attachments.** Put files on the agent's runner before emitting paths. _Start:_ `tasks/service.ts` (`buildTaskBriefing`), task attachment store, `files/session-file.ts`. Deletes R3 `collectSessionFile`, `deliverSessionFile`.
2. **T15c · Project icons through the runner.** The project icon route and create-time warm-up (`getDirectoryIconPath` callers; `manager.ts` skips it for runner engines today). _Trap:_ delete the skip; do not add a new one. Touches `manager.ts`: coordinate with lane B.
3. **T37 · One agent view.** Closes N25, N32 and R6 entries. **Includes removing the runner-only card branch from `6c2d1deb1`** (`web:` `agent-card{,-details,-header,-status}.tsx`): runner agents show "Runs on" instead of the branch and lose Change workspace and copy. Open in IDE follows main's rule only (D11). _Acceptance:_ screenshots at 390 px and desktop match main for local; same controls for runner.
4. **T38 · One launch and automation form**, including **T08's trigger location** (triggers still resolve through their template). R6 to 0. _Trap:_ main changed these files; take main first.
5. **T39 · Ports (D6).** `port.connect`, preview proxy, screencast. Closes N26. Its `agents/remote/service.ts` forward waits for lane A. _Trap:_ SSRF; authenticated, session-bound, loopback only, as the workload.

### Not on any lane yet

- **N13 watch limit.** Enrolled watches now use credited channels. The runner retains the existing 512-watch limit.
- **N35 archive: two policies remain (one owner decision).** The archive seam runs one entry (`archiveCheckout`) and one executor (`archiveExecutor`) over `directory.for(placement)`. The composition gives each runner an `archive` policy next to `settings` and `cleanupBudgetMs` (`runners/directory.ts`); the executor reads only that, never the placement, the row's columns or the runner id. Row data cannot select: a runner-prepared checkout records its folder in `worktree_path` (`prepareRunnerWorkspace`, 506605c9), so a runner row can look like a local one. Both policies keep today's outcomes exactly (pinned in `test/archive-seam-policy.test.ts`, `test/archive-policy.test.ts`, `test/archive-local-budget.test.ts`, `test/db/archive-co-owner-parity.test.ts`); unifying them is the owner's call, not the seam's.

  |                                                                     | Local (`localArchivePolicy`, main's)                                                                                                                                                                        | Enrolled (`enrolledArchivePolicy`)                                                                                                                                                                   |
  | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Co-owner rule                                                       | `recorded`: another live row with the same `worktree_path`, a `workspace_path` or reviewer `cwd` at either spelling (`path.resolve` on the runner), or the same `worktree_branch`; checked before observing | `observed`: a reviewing borrower the runner reports, or a row on the same runner with the same native `cwd` and `worktree_branch`; checked after observing an owned checkout                         |
  | Borrowers (status read before archive)                              | `recorded`: a row without its own worktree reads its owner's binding for `ownership: "borrowed"` and the owner's borrowers; live rows on the checkout's path that hold it borrow it (`nativeBorrowers`)     | `observed`: the runner's own observation as reported; borrowers have no worktree of their own                                                                                                        |
  | Borrower row's worktree status                                      | Main's no-worktree answer (no path, files or `checkoutState`), `borrowed` and its borrowers kept                                                                                                            | The same, mapped at the controller (`borrowerAsMain`); the runner's observation and frames are unchanged                                                                                             |
  | No recorded worktree                                                | Not managed (kept)                                                                                                                                                                                          | Observed and released by the runner                                                                                                                                                                  |
  | Force                                                               | Removes without observing (no Git status)                                                                                                                                                                   | Observes ownership first (`workspace.observe` with `policy: "ownership"`: no Git status or fetch, the runner checks the binding without reading Git status); a borrowed or external checkout is kept |
  | Removal                                                             | Snapshot: remembers the observed state, then releases                                                                                                                                                       | Bound: the runner carries out the caller's decision (`workspace.release`)                                                                                                                            |
  | Failure anywhere (incl. uncertain release, runner-reported failure) | Kept, "Worktree cleanup failed; leaving on disk."                                                                                                                                                           | Pending (retried), "Runner checkout release remains pending."                                                                                                                                        |
  | Host still running                                                  | Proceeds                                                                                                                                                                                                    | Pending until the host stops                                                                                                                                                                         |
  | Budget                                                              | Main's 60 s over the whole cleanup                                                                                                                                                                          | None (the transport bounds it)                                                                                                                                                                       |

  Routing follows the row's placement (`runner_id`), and never derives a machine from the cwd.

- **Conformance debt.** Write the missing scenarios: local lane workspace, path, checkout reads, files, git, terminal (27 `pending` entries whose "no local runner child yet" reason is stale since T23d); remote `workspace.describe/select/observe`; `github.pr.*` and `engine.list`/`engine.login.*` on both lanes. Run the remote scenarios not yet run on this head: `checkout.image`, `checkout.defaultFiles`, `checkout.watch`, `checkout.read` bytes, `session.sample`. Give each to the lane that owns the operation.
- **R1 77 / R2 269** have no single owner. Each family task deletes its own entries; anything left at T40 is either on the controller-machine allow list or moved.
- **Milestone close:** one full parity run and one owner review, then take main and move the pin.

## Incoming from main

- **Worktree location setting (PR #1541, commit `ec723a30d` on main).** Main gains an external-directory option for where local worktrees are created. `manager.ts` makes one call, `resolveWorktreePathOverride(placement, …)` in `worktree-location-settings.ts`, which returns a path or undefined. On this branch the manager no longer creates worktrees (create goes through `workspace.prepare`), so when you next take main, carry the setting to the local platform's workspace location by calling the same helper there. Enrolled runners never read it: local-only by construction, with no "is remote" check.

## Lessons that cost us time

- **Builders drift from main.** Pin main's behaviour with a test **before** refactoring, and ask "what does main do?" for every difference. A safer-looking difference is still a regression.
- **Placement checks smuggled past the gate are still violations.** Helpers like `samePlacement`, or "is remote" under another name, are R1/R6 hits in spirit even when the scanner misses them.
- **Test fixtures need `placement`.** Every agent record has one; fixtures without it fail in confusing places.
- **Goldens that inject pre-resolved values prove nothing.** A PATH or environment golden must run the real resolution (login shell included), or it passes on broken code.
- **A child-transport failure must fall back in process for local.** For reads, wait once the connected child accepts the request. In-process fallback applies if the request was never sent, the connection was lost or the child was fenced.
- **New migrations need the rewind helper** (`dropTasks()` in `migrations.test.ts`), or the replay test fails in CI only.
- **Staging-only artifacts versus product bugs.** A staging launcher environment without `SHELL` produced a "bug" the real app never has. Check what the real Mac app launcher sets before fixing.
- **Touched files need owners.** Owner coverage checks every added or modified file, not only new ones.
- **Enrolled transport.** The controller gets the runner description, inventory and health through contract calls. Enrollment still authenticates the outbound TLS connection.

## Native definition read transport

Enrolled runners retain the existing 300-second read transport deadline for native-mode folder/project definition reads. This is intended enrolled-runner behavior. Native listing uses plain `readdir` and never opens entries; native file reads use plain `readFile`, with no helper process or new timeout. A FIFO read waits for a writer as main does, subject to the existing enrolled transport deadline.

## Open differences — must close before the seal

- Command-manifest discovery reads the entire file locally, as on main. Enrolled discovery retains its 256 KiB UTF-8 ceiling. Both use the bound guard from `checkout.read` in `command-manifest` mode for the subsequent command.

- **Enrolled launches accept at most one MCP server.** The contract accepts an array. The enrolled supervisor rejects a second entry with `v1 carries one MCP server.` and requires HTTPS, a scoped token and the enrollment CA for its server. The carrier cutover preserves the refusal and checks. The owner may revisit multi-server support separately.

- **A read falls back here on connection loss, which does not by itself prove the child stopped running it** (since Part A). The adapter treats a lost or closed connection (`unknown_outcome` mid-read) as "the child went" and reads here once. In normal operation the app closes that connection only after the child exited (the supervisor's `waiting` state), on a restart's new endpoint, or at app shutdown; the transport also drops it on a malformed frame (a defect). A 3 MiB reply crosses the same connection without loss. To close it: fall back only once the child's exit is observed (the supervisor's `exited`), not on the socket close alone.
- **A local child that is alive but hung stalls reads until it resumes or dies.** A read sent to the child is waited for until it answers, its connection is lost, or the caller cancels; it is never run here while the child may still be running it (no second reader, no second engine session). Nothing restarts a hung child today: the supervisor only logs when describe and health go unanswered. A supervisor liveness owner with a terminal-aware policy (the child hosts users' terminals) is a possible later feature for the owner, not part of the seal.
- **Archive under `auto` when status is unreadable.** The owner decided to retain the checkout. The archive builder owns the change in `finishArchiveCheckout` and its fixtures.

**Closed: a borrower row reported its owner's checkout.** 347eb0c3 made a borrower's worktree status report the owner's checkout (path, files, dirty flags), so the archive dialog offered to remove a worktree that archive never removes for a borrower. The fix gives main's no-worktree answer on every runner. c81e6417 ("a local borrower's worktree status answers what main answers") covers local rows. The commit after it ("a borrower's worktree status answers main's on every runner") covers enrolled rows. The second is an intended change on enrolled runners, toward main.

## Known gaps accepted by the owner

- **T35 session persona listing:** session checkout listings omit a directory, dangling link or FIFO named `*.md`; main’s native loader warns for directory/dangling entries and waits for a FIFO writer.
- **T35 ownership availability:** session persona routes read the ownership file; main’s `access()` offers ownership reviews for a directory/unreadable map and answers 400 for other access errors.
- **T35 persona upsert:** an explicitly rejected stale digest is re-read and retried up to three attempts, then reports that the file kept changing; uncertain mutation replies are never replayed.

- **T39 / N26 deferred past this PR:** ports, previews and screencast for runner agents remain a known gap, like Open in IDE. T40 does not wait for T39.
- The message "Queued until the runner reconnects" stays as worded.
- **Plain git after runner GitHub sign-in fixed** (merged `57667634`): the workload account's global Git config includes gh's credential helper for https://github.com; sign-out removes the include. Runner revocation still does not sign gh out on that machine; SSH remotes and non-github.com hosts are not covered.
- **T29 merged** (`06decbeb`): engine install, update and plugins use the runner's engine operations; N34 is closed. Dispatch stays the durable coordinator for update operations; the host implementation stays app-local behind EnginePort until T40.
- **Open runner gaps:** N1 other-folder launch on the caller's runner; configured-workspace IDE locator; runner "checkout gone" 503 versus main's dialog; a runner project target's folder history is empty in the create form; PR-URL/typed-branch entry was removed from the form (the API still accepts it); local `files.get` and some archive/checkout reads still run in process.

- `login_link` from a runner agent when Dispatch listens only on loopback (D11).
- Open in IDE for runner agents: main's one-machine rule (D11).
- A dirty checkout is kept on auto-archive: that is main's policy.
- Legacy hosts with no ownership proof are not swept.

## Unverified (honest list)

- Real enrolled-runner runs for T24, T25, T27, T28, T32 and T33 beyond the staging smoke test.
- Merge-risk through a runner with a real pull request.
- A signed build under launchd (L5).
- systemd restart, SIGKILL and protected update (L5).
- A real app update with live agents.
- A fresh runner enrollment on this build.

### T40 residual ledger / own-machine policy (2026-11-25)

Read-only census at 5291f29d: 340 baseline rows / 370 occurrences, R1 58,
R2 251, R3 2, R5 45, R6 7, R7 7. Dispositions: host 29, workload 162,
update 18, route through Runner 53, neutral type/parser 16, legacy deletion 72,
own-machine 19, false-positive 1. Lead approved the 14-file own-machine proposal
and literal-const computed import correction. R2 becomes 231; other rules stay
unchanged. Caller batches and full ledger are attached in the seal builder stream.

Own-machine grants are exact file paths plus specific capabilities/helper imports,
each with a reason. Existing regex grants were expanded only to already tracked
matching source files; new files receive nothing. Mixed engine/session/workspace
controllers receive no new grants. Release routes operate on Dispatch's authoring
repository and installer verification operates on Dispatch artifacts. Generic
helpers must stay controller-owned when workload dependencies move. Computed
imports resolve only preceding literal const bindings in the same lexical block;
resolved imports still receive all ordinary boundary checks. Unknown or mutated
bindings remain violations. Single owners retain manager, ACP runtime, local
adapter, remote service and supervisor files; fallback removal still requires the
lead's recovery decision.

The controller reads the last 20 lines of a retained agent setup log when reporting a job crash. Release v0.38.16 wrote this file through tmux. Commit `ae3156db` removed the writer, while main still follows the old path when present. The owner may retire the reader after deciding how to handle retained logs.

T40 move records stay counted, with exact approved importers and verified package targets; only main.ts may supply app-owned providers through a separately validated input seam.
The move list has a reviewed record budget and shrinking importer list; growth requires the named-commit policy fixture. Frozen historical list snapshots only replay existing commits.
Remove each record with its baseline entry; the final seal requires zero records and zero budget.

The first workload vocabulary allowances preserve the on-disk `.dispatch` repository folder in `workload/shared/icon-scan.ts` and the `DISPATCH_AGENT_ID` key tools read in `workload/shared/lib/tool-environment.ts`. Each allowance matches only its exact file and token.

The workload move must mark compatibility allowances for persona catalog diagnostics, the on-disk `persona-catalog` name, the persisted `personaContext` field and the current on-disk `agt_` prefix as temporary. At standalone packaging, remove or re-justify each exact file/token pair. Move persona validation to the controller first, preserving invalid-entry filtering, warning order, truncation and precedence. Keep the existing user-visible message bytes until that transfer.

The enrolled supervisor's `runnerStorageKey` stores `agt_[a-z0-9]+` verbatim and hashes other IDs. Directory discovery recognizes both forms. By owner decision, session listing requires the ID recorded in the identity and no longer reconstructs it from an older host directory. These enrolled paths are branch-era data. Main at `bfdee9f1` generates IDs with that prefix but has no enrolled runner or supervisor writing this directory layout. Prototype `3df14397` wrote raw IDs under hosts/bindings, and `c050dfe4` used these keys under sessions. Neither writer is reachable from main or any release tag through v1.7.38.

The atomic move relocated 67 files and drained the remaining 17 move records. Four workload imports now reach the client package directly. In `agents/remote/runner.ts`, the worker imports `runnerReplyTimeoutMs` and `scheduleDeadline` from `@dispatch/runner-client/v1/connection`, and `wireFrames`, `FlowStreams`, `acceptsStreams` and the `StreamFrame` type from `@dispatch/runner-client/v1/node`. The enrollment and terminal workers import `wireFrames` from the same Node entry. The controller's `runners/enrolled/v1-framing.ts` facade stays with the enrolled adapter. Delete it with its last legacy caller and retire or redirect the corresponding test fixtures.

The launch form calls `path.resolve({path, automatic: true})`, `path.complete({prefix, limit: 20})`, and `git.remoteHeads({path})` through the runner directory. The entry supplies the same workload helpers to local fallback, child and enrolled execution. Automatic inspection applies main's privacy check before filesystem access and probes the typed path with the three-second Git check. Completion preserves main's filtering and ordering; remote heads retain the fifteen-second origin read. The HTTP responses and errors are pinned in `launch-form-paths.test.ts` and `launch-branches.test.ts`. The entry composes these helpers from the runner package.

The server entry loads one in-process bundle after restoring the shell environment and before importing the server. Its portable type is exported from `@dispatch/runner-protocol/in-process`. The local adapter uses its workload ports for in-process calls, and the enrolled acknowledgment adapter receives its existing Zod parser. The entry loads its provider from the runner composition subpath. Both adapters continue receiving the implementation from the entry. The scanner counts the local adapter's delegation at the bundle boundary.

The controller owns `files/session-file-io.ts` and `files/open-workspace-file.ts`. They open a controller-held source for lazy delivery through `files.put`. The runner keeps private copies of `openRegularFile`, `openLinuxDirectory` and their required constants for checkout and session workers. Compare both implementations against the same regular-file, symlink and directory fixtures on each supported platform. The controller retains the existing `fs` and `fs/promises` own-machine accesses in `open-workspace-file.ts`.

The workload engineUpdatePort wrapper serves the legacy detected-update executor. Delete it with that executor. Fold the shared operation facade into the controller when the controller is its only caller.

Unused in source since the archive seam and B2, deleted with legacy (tests still use both as references, so pin a fixed expectation first): `enrolledArchiveCheckout().releaseBound` in `runners/enrolled/checkout.ts` (the adapter's `workspace.release` sends the same frame; `enrolled-archive-operations.test.ts` compares against it), and `localDefaultBranch` in `shared/git/default-branch.ts` (`effective-base.ts` reads `git.defaultBranch`; `comparison-base-parity.test.ts` and `checkout-intent.test.ts` use it as the old rule).

## Owned file reads and launch folders

`checkout.read` and `checkout.access` accept `checkout: "owned"`: the checkout held for the session, independent of its selected workspace. Writes and commands keep the existing target schema. Locally, owned means `worktreePath ?? cwd`; the launch selector retains `launchCwd ?? repoRoot ?? cwd` for launch-folder/icon reads. Enrolled runners' launch and owned reads are the same immutable checkout and use the existing launch stream. These selectors intentionally differ locally; do not unify launch with owned or current. A stale local binding is compared with the row's desired directory before reading, using the existing identical in-process read on mismatch.

### T40 F_OK presence seam (intentional operation addition)

`checkout.access` intentionally raises the operation count from 72 to 73. It probes native F_OK access (links followed; directories and unreadable files present), returns false only on ENOENT, and carries other native errors unchanged with code/path/syscall details. Its two planned controller consumers are the assessor's primary/legacy map selection and then the folder picker's `hasCodeowners`. Selection order stays in the controller: select with access, read the selected file once using native mode, and never try legacy after a read-time ENOENT. The assessor is an explicitly named native-read consumer alongside folder/project definition readers. Writes and commands still do not accept the owned selector.

By owner decision, the controller no longer looks up or converts workspace receipts from unreleased branch revisions. The runner resumes current receipts and the controller replays the request persisted on the agent row when needed. Agents created by older revisions of this branch may need archiving or relaunching.

Current enrolled cleanup uses the stored placement and the runner’s ownership observation. The configured-workspace lookup, managed flag, snapshot release and archive retry locator check have been removed.

### T40 assessor ownership reads

The assessor uses the owning session's `owned` checkout for every runner, with F_OK primary/legacy selection followed by one native read. In the enrolled root matrix, `moved-repository` and `moved-subfolder` now use the worktree owner rather than the selected workspace owner, matching main; worktree, no-worktree, gone-worktree and non-repository cases are unchanged. Native FIFO maps now wait for their writer instead of the old enrolled regular-file inspection rejecting them. A selected file disappearing during its read does not retry legacy, as on main.

Main's evidence identity inconsistency is preserved: assessed files come from the PR URL while the ownership map comes from the agent's launch/worktree checkout; there is no repository identity cross-check. The icon's `launch` selector is unchanged.

Main `9549f236` adds the repository archive hook and its preview. On the local runner it uses the same checkout resolution, including the retained-worktree launch fallback, for both preview and execution. A failed hook leaves the agent available for retry. Local cleanup now also retains a worktree named by another surviving agent’s cwd or launch cwd. The owner approved enrolled archive hooks. The archive builder owns resolver integration. Their existing archive and stop policies continue to apply.

Main runs the archive command it resolved even if another tool in the manifest changes before execution. The local archive resolver reads the manifest with native filesystem semantics, including FIFOs. For this read it requests the checkout directory identity. Its `checkout.exec` call binds the resolved command to an explicit session, checkout selector, path and directory identity. The worker checks that directory before spawning and skips the manifest reread by design. Other command callers retain the file-digest guard. The enrolled carrier accepts the same resolved-root guard. A bound native read returns its directory path and identity. The workload checks both before spawning in the canonical directory. The archive builder owns the resolver change and the unreadable-status retention policy in `finishArchiveCheckout`.

Open for owner decision: main caches parsed hooks by manifest path and mtime across requests. With one FIFO writer for preview and none for a later archive, main reuses the cached command while the runner read waits for a second writer. Regular-file previews and archives match for unchanged manifests and edits that update mtime.

### T40 transport census at ea689d78

Under `packages/runner-client/src/v1/`, the enrolled command codec (`codec.ts`), command/reply dispatcher (`connection.ts`), watch and terminal adapters (`watch.ts`, `terminal.ts`), and the uncredited data/close tunnel (`node.ts:hostChannel`) retire after their consumers switch. The conformance reference client is one such consumer.

Keep `host.ts` at its current path. Both `packages/runner/src/local/sessions.ts` and the server's local adapter use it to attach to existing hosts. Keep the byte vectors in `test/v1-host-fixtures.ts` and their assertions in `test/v1-host.test.ts`. The local socket uses `node.ts:frameWriter` and the credit protocol in `streams.ts` on both ends. Enrollment and terminal worker IPC also use `node.ts:wireFrames` for NDJSON. These live framing primitives stay in place with their existing wire bytes. An import under this directory alone does not establish that a caller uses the enrolled command envelope.

Enrolled TLS also carries the existing validated `update_status` observation from the protected updater. A trial may finish or a fence may expire while disconnected. On reconnect the runner reports that durable outcome before any controller call exists, so it has no call ID. Replaying a mutation to learn its outcome would violate single-attempt writes. The observation belongs to the authenticated registration and connection epoch. The local socket has no such notification.

The enrolled supervisor still writes the retirement marker when an unknown managed session is discarded or released. It prevents a delayed launch after restart without creating a checkout, a binding or a host. Snapshot-based release and its separate `.released` receipt have no current caller.

Protected-update recovery distinguishes a lost transport acknowledgement from the coordinator's explicit decision after reconnect. The coordinator rechecks the saved attempt, registration, epoch and advert. In staging or settling it can issue another offer for that attempt, including after a supervisor restart that lost the in-memory staging result. Existing coordinator fixtures pin this recovery. The transport never resends a call.

Credit bounds unacknowledged stream payload to 1 MiB in each direction across all streams on an enrolled connection. This budget covers bytes in transit. Open terminals retain per-channel bookkeeping and their workload processes, and streamed-terminal concurrency stays as before.

### T40 enrolled carrier cutover

The controller uses the authenticated registration to choose a connection and checks the session row before sending. The runner uses its own bindings and host records. Session handles are bare IDs. The existing answers for missing sessions include `host_gone` on attach and `gone` on liveness after discard. A lost mutation acknowledgement is `unknown_outcome`. Enrolled reads lost with a connection return `unavailable`. The coordinator keeps its same-attempt staging and settling recovery.

The update fence preserves the terminal grace deadline. A reader with credit receives the existing update notice and EOF. A stalled reader closes with `fenced` at the deadline so it cannot delay the update. The FIFO preview/archive caching decision remains open.

Enrolled launches use project placement or the requesting session’s own folder. A saved enrolled project has an empty directory until its runner prepares the checkout. The controller stores the native path the runner returns. Current bindings, archive ownership receipts and the retirement marker remain valid. Session rows and templates written on main retain local placement across upgrade and rollback.
