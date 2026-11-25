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
| `packages/runner-protocol`                                             | The contract: `src/contract/**` (66 operations, schemas, errors, surface snapshot), plus legacy v1 types                                               |
| `packages/runner-client`                                               | `Runner`/`Runners` client, wire v1 codec (`src/v1/codec.ts`, `NOT_ON_V1`), framing, launcher channel                                                   |
| `packages/runner`                                                      | The runner program: `src/core/` (workspace, repository, checkout, sessions, engines, github), `src/platform/{posix-user,linux-privsep}/`, `src/local/` |
| `packages/runner-conformance`                                          | Scenarios for every operation, `baseline.json` (red entries per lane), reference client                                                                |
| `apps/server/src/runners/`                                             | Dispatch side: `local.ts` (local adapter, temporary in-process fallbacks), `enrolled/**` (remote), `controller-machine.ts`                             |
| `apps/server/src/agents/remote/`                                       | Today's Linux supervisor and runner service (v1). Moves out at T40                                                                                     |
| `apps/server/src/agents/acp/`                                          | Agent host, driver, runtime. The host is generic after T22 (T22b finishes it)                                                                          |
| `scripts/check-runner-boundary.mjs`, `scripts/runner-restrictions.mjs` | Boundary scanner and restriction anchors                                                                                                               |
| `scripts/runner-local-parity/`                                         | Local parity oracle against a pinned main                                                                                                              |

Every remote change so far follows one pattern: a negotiated capability flag in `ready`, credit-controlled streams for capable peers, and legacy frames byte-identical for old peers.

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

- **N13 watch limit** (`watches.size >= 512`): close with a credited watch channel, or delete with v1 at T40.
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
- **A child-transport failure must fall back in process for local.** If the child is not ready, dies mid-call or never answers, run the same port in process so users never see a new failure mode (T32's `github.pr.status` and T33 are the pattern).
- **New migrations need the rewind helper** (`dropTasks()` in `migrations.test.ts`), or the replay test fails in CI only.
- **Staging-only artifacts versus product bugs.** A staging launcher environment without `SHELL` produced a "bug" the real app never has. Check what the real Mac app launcher sets before fixing.
- **Touched files need owners.** Owner coverage checks every added or modified file, not only new ones.
- **One remote pattern.** Capability flag in `ready`, credited streams for capable peers, legacy frames byte-identical. Old peers stay supported until T40.

## Native definition read transport

Enrolled runners retain the existing 300-second read transport deadline for native-mode folder/project definition reads. This is intended enrolled-runner behavior. Native listing uses plain `readdir` and never opens entries; native file reads use plain `readFile`, with no helper process or new timeout. A FIFO read waits for a writer as main does, subject to the existing enrolled transport deadline.

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

T40 move records stay counted, with exact approved importers and verified package targets; only main.ts may supply app-owned providers through a separately validated input seam.
The move list has a reviewed record budget and shrinking importer list; growth requires the named-commit policy fixture. Frozen historical list snapshots only replay existing commits.
Remove each record with its baseline entry; the final seal requires zero records and zero budget.

Launch-form probes move with the atomic workload rename. `agents/local-workspace-probes.ts` is in the manifest, but the boundary scanner currently treats it as app-owned. Wiring it to `agents/checkout-worker.ts` before relocation adds an R5 import. Moving its implementation to `agents/workspace.ts` creates new R2 keys for `os` and `shared/lib/run-command`. Keep the current `routes/system.ts` import until the move.

At the move, use the same probe implementation on each runner. Wire `path.resolve({ path, automatic: true })` to main’s automatic inspection: expand tilde on the target, apply the existing macOS privacy check before filesystem access, stat the typed path, and run only the 3-second Git work-tree probe there. Return the existing path-resolution shape with `canonicalPath`, `projectRoot` and `git` null. Keep unflagged resolution unchanged. Implement `path.complete({ prefix, limit: 20 })` with main’s privacy, directory matching, ordering, cap and tilde presentation. Implement runner-scoped `git.remoteHeads({ path })` as one 15-second `git ls-remote --heads origin` in the expanded directory, returning main, master, then locale-sorted heads. Supply the same functions to the local child, local adapter’s single in-process read fallback, and enrolled workload-account worker. Map the existing route responses and errors as pinned by `launch-form-paths.test.ts` and `launch-branches.test.ts`. Sequence the additive contract and enrolled encoding with the contract owner and preserve existing v1 frames.

The controller composition root temporarily supplies the existing Zod capability parser to the enrolled engine acknowledgment adapter. Once the workload moves, import the same parser at the adapter and remove the composition callback.

The workload engineUpdatePort wrapper serves the legacy detected-update executor. Delete it with that executor. Fold the shared operation facade into the controller when the controller is its only caller.
