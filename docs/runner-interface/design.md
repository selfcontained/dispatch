# One runner protocol, two implementations: design and lock-down plan (revision 4)

> **Handoff copy.** This file lives in the repo only for the handoff. Delete `docs/runner-interface/` before the PR is marked ready (part of T40). Start with `HANDOFF.md`.

## What changed in this revision

1. **State brought to integration head `9dfe3efff`** (draft PR #1540). Merged since revision 3, each checked against its diff: T13 (in part), T19b, T19c, T20 and T20b, T22, T23 with T23c and T23d, T24, T25, T26, T27, T28, T09c, T15b (agent route), T32, T33. Fixes: the runner worktree branch is recorded (`fc398e561`), the PATH golden exercises the login shell (`10813fa11`), tool locations stay absolute after a host exit (`948ca5f40`), a host welcomes a client only after its hello (`81d110e66`). All P slices (P0–P7) landed; the parity oracle's known-regressions list is empty.
2. **Reality differs from revision 3's text in these places** (the task's status line says so too):
   - **T25:** create is intent → insert → prepare → launch, not resolve → admit → prepare → insert. The row is inserted first with a durable preparation intent (migration 0067), so a restart can prove no host was launched.
   - **T26:** a recorded stop is scoped to the launch id it was meant for (migration 0068), so a retry never stops a later launch.
   - **T23:** the session core landed, but the binding store was not unified. The linux-privsep adapter over the supervisor's files is still the store → **T23b** (new).
   - **T33:** R3 did not reach 0. 15 local-adapter method entries remain → folded into the tasks that own them (0.4).
   - **T22:** the host is generic, but four host files still import Dispatch (R5) → **T22b** (new).
   - **T13:** task briefings and task attachments did not move → **T13b** (new).
   - **T15b:** the project icon route and the create-time warm-up still read the controller's disk → **T15c** (new).
   - **Leftover restriction anchors on done tasks:** N12 (T19), N13 (T09), N14 (T14), N16 (T21), N35 (T20). N14, N16 and N35 apply only to legacy wire peers and go with v1 at T40. N12 and N13's watch limit are real and still open (0.4, carry-overs).
3. **A runner-only UI branch found on the agent card** (`6c2d1deb1`): runner agents show "Runs on" instead of the branch, and lose Open in IDE, Change workspace and the copy action. Assigned to T37: one agent view, with main's rule for IDE (D11).
4. **Counts re-taken at `9dfe3efff`:** boundary R1 77, R2 269, R3 15, R5 49, R6 34, R7 19. Conformance red baseline 100 entries (55 local, 45 remote).
5. **Machine names, paths and local file references removed** for the handoff. Decisions D1–D12 and the owner rules are unchanged.

**Task count:** 62 tasks: revision 3's 55, the splits T20b, T23c and T23d that landed, and the new T13b, T15c, T22b and T23b. 47 done, 15 left (0.4).

<details><summary>Revision 3's changes, kept for reference</summary>

1. **Local is main (D9).** Any behavioural difference a local user would see is restored to main, even where the branch looks safer. This is a rule for every task (5.2). It is applied without asking to:
   - archive keeping a shared worktree, or a switched-to branch
   - unknown base
   - force after a stale dialog state
   - archive after a failed status
   - main's diff error texts

   All of these land in **P7**.

2. **Approved as intended:**
   - placement on agent records, worktree status's `ownership`, `borrowers` and `checkoutState`, and the migration count.
   - Direct consequences of the feature existing need no question from now on.
   - **P0** gives the ledger one entry per approved field and one consequence entry for migrations.
3. **Projects follow Option A (D7) and one project per repository (D8).**
   - A project keeps its local folder, records its repository when it has a Git origin, and can be created from a repository alone.
   - Runners never take a user-named folder: they make their own checkouts from the repository.
   - Existing duplicates merge once into the oldest project, and new duplicates are refused.
   - Dispatch never _sends_ a user-named folder to another runner, but it does record a folder an agent moves itself into there: `set_workspace` on any runner takes any directory the agent's account can use, as local (owner, after r3's first post).
   - Rewritten as a result: T17; also T08, T16, T18, T19, T25, T34, T35, T36, T38, the interface's `target` and `workspace.*` rows, and `Placement`.
   - **Workspaces are deleted**, not generalised: `Placement` is `{runner}`.
4. **F1 became P0–P7.**
   - P1–P3 landed (`142343d7a`, `3c91c0a9f`, `816e4ab62`, `9fd196ac2`), and P4 is being built.
   - T01–T04 are done (T04 in a reduced scope, `c545c09ef`).
   - Order: P0–P7, then F2 and F3, then T04 onward.
   - **F3 landed** (`45325e933`). **F2 is blocked** by the web R6 gate (the web would need the agent's runner). A server-side route by agent id is being tried; otherwise F2 moves to right after T07.
5. **T20 corrected:** `workspace.release` expresses main's force, so Dispatch decides and the runner removes, with no state recheck and no borrower deferral. P7 records the runner's current recheck as R7 **N35** for T20 to delete.
6. **T26 approved (D10):** a stop while the runner is unreachable is recorded and retried on reconnect.
7. **Two known gaps are left as they are (D11):**
   - `login_link` from a runner agent when Dispatch listens only on loopback
   - Open in IDE for runner agents
8. **T08's default is confirmed:** with no `runner`, a save targets the creator's machine.
9. **Smaller after P1–P7:** T09, T11, T14, T15, T25, T35, T36, T37 and T40. Each task says what is left.
10. **T04 landed in a reduced scope** (`c545c09ef`): operation table, errors, description, opaque types, `Runner`/`Runners`/`RunnerHandlers`, snapshot, and the wire v1 codec in `runner-client`. Where the tables in 1.3 differ from the built contract, the contract wins. Three corrections land before T06 (`workspace.release` shape, worktree `location`, `session.launch` deadline class). **T04b** is added for host messages and events. The launcher schema moves to L1. C1–C3 landed in the contract.

11. **State at integration head `61f893a31`** (draft PR #1540; GitHub CI green on Linux including e2e at `8c568bb49`; main merged at `85caafec3` with the parity pin moved). See 0.4. Remote changes follow one pattern: a negotiated capability flag in `ready`, credit-controlled streams for capable peers, and legacy frames byte-identical for old peers. Restriction rules that cannot express "old peers only" stay listed (N13, N14, N16). The local parity check is out of CI by owner decision and runs once per milestone.
12. **T19 split** into T19 (core, done), **T19b** (the runner serves `workspace.prepare`: platform-supplied location, binding adapter) and **T19c** (Dispatch launches by project; N5, N6). Carry-overs became **T09c** and **T15b**.

**Task count:**

- **55 tasks:** T01–T40, L1–L5 and the splits T04b, T06b, T06c, T09b, T09c, T14b, T15b, T19b, T19c, T21b. 29 are done and 26 are left.
- **8 fix-now slices (P0–P7):** 3 landed, 1 in progress and 4 planned.
- **2 fix-now items:** F2 (blocked, see 5.1) and F3 (landed `45325e933`).

</details>

<details><summary>Revision 2's changes, kept for reference</summary>

1. All six decisions recorded. D1: local is a separate child process.
2. L1–L5 added; flow control (T10) ahead of the socket.
3. The in-process composition dropped.
4. F4 withdrawn; T08 plans a runner field on jobs and templates.
5. Every "runner can do less" rule listed in Appendix D; E9 and R7 added.
6. "Stop inventing new behavior" made a rule for every task.
7. T01's acceptance includes main's update fixes.
8. Enforcement re-derived for a child process.
9. Counts re-taken at `f7897bf7e`.
10. 45 tasks and 3 fix-now items.

</details>

---

**Read at:** revision 2 at `f7897bf7e`; revision 3 at `9fd196ac2` and `61f893a31`; revision 4's status lines, 0.4 and 5.1 at **`9dfe3efff`**. Task bodies that are marked done keep revision 3's plan text for reference; the status line under each heading wins where they differ. File:line references in unchanged task text are revision 2's; find code by symbol.

**Evidence labels**

- **[code]**: read in the source.
- **[ran]**: measured or tried here, on an exported copy or scratch fixture.
- **[audit]**: taken from the audit and not re-traced.
- **[inferred]**: reasoned, not traced or run.
- Everything else is design.

No real server, engine, runner, host machine or VM was used. Host compatibility was run on real host code with a fake engine.

**Paths** are relative to `apps/server/src/` unless they start with `packages/`, `apps/`, `scripts/`, `bin/` or `web:` (`apps/web/src/`).

**Contents:** 0 Summary · 1 Interface · 2 Model · 3 Boundary · 4 Enforcement · 5 Migration · 6 Decisions · 7 Risks · Appendices A–D

---

## 0. Summary

### 0.1 The model in five lines

1. There is one `Runner` interface, defined as one operation table in `@dispatch/runner-protocol`. Dispatch calls nothing else to touch an agent's machine.
2. There is one runner program, `@dispatch/runner`: one set of handlers over a small platform port (`posix-user`, `linux-privsep`).
3. "Local" is that program as a **child process started by the app**: same binary, same build, a local socket, no TLS or enrollment. "Remote" is the same program on Linux behind TLS.
4. Every agent has a placement `{runner}`, never null. `cwd` is only a path on that runner. A runner agent can do whatever a local agent can, except take a folder a user named on that machine (D7): runners make their own checkouts from a project's repository. The agent itself can still move into any folder its account can use (`set_workspace`), and Dispatch records that path.
5. Requests carry generic inputs (text, environment names, argv, bytes, policy values). Dispatch decides what they mean, and the runner decides how they happen on its machine.

### 0.2 How it is locked

|     | Mechanism                                 | A violation it fails                                | With a child process                     |
| --- | ----------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| E1  | Separate packages, each typechecked alone | Runner imports Dispatch, or the reverse             | Simpler: Dispatch imports no runner code |
| E2  | Boundary scanner, shrink-only baselines   | New host access or placement test in Dispatch       | **Still essential**                      |
| E3  | Opaque `Placement` and `RunnerPath`       | Null placement, opening a runner path in the app    | **Still essential**                      |
| E4  | One operation table                       | An operation with no handler, validator or scenario | Same                                     |
| E5  | Conformance on the real programs          | Local and remote return different results           | Simpler: two lanes instead of three      |
| E6  | Reference client                          | The interface needs Dispatch to be usable           | Simpler: spawn and connect               |
| E7  | Parity oracle against main                | Local users see a change                            | **More important**                       |
| E8  | Surface snapshot and vocabulary           | A Dispatch concept or new limit enters the protocol | Also covers the launcher channel         |
| E9  | **New:** caller parity                    | A runner agent gets fewer tools or accepted inputs  | Needed whatever the process model        |

### 0.3 What the plan rests on

- **The branch is the only place any of this exists. [ran]** The protocol, local runner and remote runner are absent from main and from the 15 newest tags at the first reading.
- **Local does not use the protocol today. [code]** Only 5 of the 17 wire commands can be sent to it with the same signature. Launch and checkout command need a side channel, and 10 others are not handled at all.
- **Nothing enforces the boundary today. [code, ran]** The protocol package is not in `check`, hoisting resolves any dependency, a relative import of server code typechecks without `rootDir`, and PR CI never runs the real Linux runner.
- **A separate process can take over main's agents. [ran, code]**
  - This branch's client drove real v1.7.28 and main host code: attach, prompt, steer, replay, set config, stop.
  - Directory, socket, argv and token are unchanged.
  - Most hosts will not need it: main's protected update stops idle agents and resumes them on the new build.
- **Two traps in doing so. [ran]** In the remote client mode a main-era host never becomes ready. Any second connection to a host evicts the first, so a host must never be probed by connecting.
- **The child will not die with the app. [code]** launchd has `AbandonProcessGroup`, the app kills only its own child, and systemd uses `KillMode=process`.
- **This branch predates main's update fixes. [ran, code]** Its host ignores `idleOnly` and dies mid-turn. It lacks probation quiesce and the receipt merge. T01 must keep main's.

### 0.4 Tasks and order

**State at `9dfe3efff`** (draft PR #1540):

- **Done (47):** T01–T28 except those listed under Left, with the splits T04b, T06b, T06c, T09b, T09c, T14b, T15b, T19b, T19c, T20b, T21b, T23c, T23d; T32, T33; L1–L4; all P slices; F2 (superseded by T28's one sign-in route) and F3.
- **Left (15):** T13b, T15c, T22b, T23b, T29, T30, T31, T34, T35, T36, T37, T38 (with T08's trigger location), T39, L5, T40.
- **Boundary (shrink-only baseline `scripts/runner-boundary-baseline.json`):** R1 77, R2 269, R3 15, R5 49, R6 34, R7 19.
- **Parity oracle:** known regressions 0; 8 intended entries, each citing a decision. Run once per milestone, not in CI.
- **Conformance red baseline (`packages/runner-conformance/baseline.json`):** 100 entries.
  - Local lane, 55: 27 `pending` scenarios never written for the local lane (workspace, path, checkout reads, files, git, terminal; their recorded reason "no local runner child yet" is stale since T23d) and 28 for engine, GitHub, update and port operations.
  - Remote lane, 45: v1 shape mismatches (T23, T24, T26, L1), workspace scenarios not written (T16), not-on-v1 operations (T15, T17, T35), and the same engine, GitHub, update and port operations.

**Carry-overs that no remaining task names yet** (each needs "what does main do?" before code):

- **N12** (`agents/remote/runner.ts`): the runner forces `core.hooksPath=/dev/null` and `GIT_CONFIG_GLOBAL=/dev/null` on Git it runs. Main runs the user's Git configuration and hooks. Put it with T23b or T40.
- **N13 watch limit** (`watches.size >= 512` in `agents/remote/runner.ts`): the Files watch still rides v1's `watchCheckout` channel. Close it with a credited watch channel or delete it with v1 at T40.
- **R3, 15 entries:** `local-runner-engine.ts` (`consumeCodexReset`, `plugins`, `readModelCatalog`, `readModelOptions`, `readProviderPlans`) belong to T29–T31. `local-runner.ts` `bindWorkspace`, `checkoutRelease`, `requestedWorktree`, `resolveLaunchDirectory` and `runners/local.ts`'s in-process checkout reads belong to T23b. `collectSessionFile`, `deliverSessionFile` belong to T13b. `canonicalPath`, `inferRepositoryUrl`, `resolveProjectRoot` belong to T34.
- **R5, 49 entries:** 39 tagged T04 are mostly `agents/remote/update-*` and supervisor imports of Dispatch code (go with T40's move of the runner out of `apps/server`), plus four host files (T22b). The rest are tagged on their task.
- **R1 77 and R2 269** have no single owner. Each family task deletes its own entries as it moves; whatever is left at T40 is either on the controller-machine allow list or moved. This is the largest residual.
- **Conformance debt:** write the missing scenarios for done operations (local lane workspace, path, checkout, files, git, terminal; remote `workspace.describe/select/observe`; `github.pr.*` and `engine.list`/`engine.login.*` on both lanes) and run the remote scenarios not yet run on this head (`checkout.image`, `checkout.defaultFiles`, `checkout.watch`, `checkout.read` bytes, `session.sample`).

**Next, in three lanes that share no files** (at most three builders; a task that must touch another lane's file waits for that lane):

| Lane | Owns                                                                                                     | Order                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A    | `packages/runner/**`, `agents/remote/**`, `runner-client/src/v1/**`, `local-runner*.ts`, engine files    | **T23b** → T29 → T30 (its `manager.ts` line waits for lane B) → L5 (owner approval) → T40   |
| B    | `manager.ts`, `launch-admission.ts`, `acp/**`, `routes/mcp.ts`, `server/mcp-*handlers.ts`, `personas/**` | **T22b** → T34 → T35 → T36 → T31 (`routes/mcp.ts` N17)                                      |
| C    | `apps/web/**`, `tasks/**`, icon files                                                                    | **T13b** → T15c → T37 → T38 → T39 (its `agents/remote/service.ts` forward waits for lane A) |

Conformance debt goes with whichever lane owns the operation's files. Close the milestone with one full parity run and one owner review.

| Milestone             | Tasks                                 | Left | Useful result                                                                           |
| --------------------- | ------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| M1 Lock               | T01–T06, T04b, T06b, T06c ✓           | 0    | No new detectable fork or restriction lands                                             |
| M2 Model and process  | T07–T10, T09b, T09c, L1–L4 ✓          | 0    | Placement is data. The child runs, survives restarts and updates, serves checkout reads |
| M3 Files              | T11, T12, T13 ✓; T13b                 | 1    | Share, read and steer with files on every placement                                     |
| M4 Checkouts          | T14–T21 and splits ✓; T15c            | 1    | Same checkout, branch, base and archive. Projects by repository                         |
| M5 Sessions           | T22–T27, T23c, T23d ✓; T22b, T23b, L5 | 3    | Local and remote are one program, proved on signed Mac and systemd                      |
| M6 Engines and GitHub | T28, T32, T33 ✓; T29, T30, T31        | 3    | Same engines, usage, PR tracking                                                        |
| M7 Parity and seal    | T34, T35, T36, T37, T38, T39, T40     | 7    | Same tools and UI, v1 sealed, the one PR                                                |

### 0.5 Decisions, all made by the owner

|     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Local is a separate process**, started by the app. Same binary and version, local socket, no TLS or enrollment, re-attaches to detached hosts                                                                                                                                                                                                                                                                                                        |
| D2  | v1 may change incompatibly until it first ships. The trial runner host is reinstalled once                                                                                                                                                                                                                                                                                                                                                             |
| D3  | One PR after the last task. Take main at each milestone                                                                                                                                                                                                                                                                                                                                                                                                |
| D4  | Attach any regular file the agent's own OS account can read, on every placement                                                                                                                                                                                                                                                                                                                                                                        |
| D5  | Brain and tasks are shared across machines. Existing local keys are unchanged. **Revised by D8:** a runner session takes its project's key                                                                                                                                                                                                                                                                                                             |
| D6  | Authenticated, session-bound loopback port forwarding                                                                                                                                                                                                                                                                                                                                                                                                  |
| D7  | **Projects, Option A.** A project keeps its local folder as today, plain non-Git folders included. It also records its repository when the folder has a Git origin, and it can be created from a repository alone. Runners never take a user-named folder: they use the repository and make their own checkout. An agent's own `set_workspace` is not a user-named folder: any directory its account can use, on every runner, and Dispatch records it |
| D8  | **At most one project per repository.** Existing duplicates merge once into the oldest (T17), and new duplicates are refused. Projects stay allowed for plain folders "for now"                                                                                                                                                                                                                                                                        |
| D9  | **Local is main.** Any behavioural difference a local user would see is restored to main, even where the branch looks safer. Direct consequences of the feature existing are intended without a question                                                                                                                                                                                                                                               |
| D10 | A stop while the runner is unreachable is recorded and retried on reconnect (T26)                                                                                                                                                                                                                                                                                                                                                                      |
| D11 | `login_link` from a runner agent on a loopback-only Dispatch, and Open in IDE for runner agents, stay known gaps                                                                                                                                                                                                                                                                                                                                       |
| D12 | Intended differences approved 2026-11-22: placement on agent records, worktree status `ownership`, `borrowers` and `checkoutState`, and the migration count (P0)                                                                                                                                                                                                                                                                                       |

The standing corrections still apply: runner callers are never restricted relative to local ones, and no new behaviour is invented. D7 is the one owner-made exception, about where folders come from.

---

## 1. The interface

### 1.1 Shape

```ts
// @dispatch/runner-protocol: no Node, no dependencies
export const operations = {
  "session.launch": op({
    scope: "session",
    kind: "call",
    request,
    response,
    errors, // validators; types derive from them
    retry: "by-key",
    key: "launchId",
    timeout: "launch",
    capability: "baseline",
  }),
  // ...every operation below
} as const;

export interface Runner {
  describe(): RunnerDescription; // last known, also while offline
  readonly connection: Connection; // state, epoch, onChange
  call<K extends CallName>(
    op: K,
    req: Req<K>,
    opts?: CallOptions
  ): Promise<Res<K>>;
  open<K extends StreamName>(
    op: K,
    req: Req<K>,
    opts?: CallOptions
  ): Promise<{ info: Res<K>; channel: Channel }>;
}

export type RunnerHandlers = { [K in OpName]: Handler<K> }; // a missing op is a type error

// Dispatch
export interface Runners {
  for(placement: Placement): Runner;
  list(): RunnerSummary[];
  defaultPlacement(): Placement;
}
```

`RunnerDescription` is `{runnerId, displayName, build, protocol, engines[], capabilities}`. It deliberately has no `kind`, `local`, `remote`, `os`, `transport`, `limits` or `workspaces` field.

**There are no workspaces (D7).** Revision 2's `workspaces[] {id, defaultDirectory}` existed to name folders on a runner, and D7 says runners never take a user-named folder. A runner keeps one internal checkout store for the checkouts it makes. Agents are not confined to it: `set_workspace` moves an agent into any directory its account can use, and the agent's `cwd` records that path. That deletes every `managed`, `confined` and per-workspace check rather than generalising it.

Vocabulary:

- **`session`**: an opaque handle chosen by the caller. The wire name `agentId` goes away.
- **`target`**: one of `{session, checkout?: "current" | "launch" | "moved"}`, `{path}` (pre-launch, subject only to the workload account's permissions) or `{repository: url}`. Dispatch sends `{path}` only to the controller's runner, because that is the only machine where a user names folders (D7). Pre-launch reads for any other runner use `{repository}`. This is a rule about where folders come from, kept in Dispatch's admission, not a protocol capability or a runner refusal.
- **`path`**: a `RunnerPath`. It is meaningful only on the runner that returned it.
- **Streams**: NDJSON or bytes over a channel with credit-based flow control. The current channel has none: a write backlog over 32 MiB destroys the whole runner connection (`packages/runner-protocol/src/node.ts:35-38`). **[code]**

### 1.2 Errors

Every failure is `{code, message, details?}`. Dispatch maps codes to HTTP statuses and keeps today's local wording.

| Code                   | Meaning                                                    | Retry                              |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------- |
| `invalid`              | Malformed or disallowed input                              | No                                 |
| `not_found`            | No such session, path or operation ID                      | No                                 |
| `forbidden`            | The OS refused the workload account. Never a runner policy | No                                 |
| `conflict`             | The key is bound to another request, or a branch is taken  | No                                 |
| `stale`                | An expected state or digest no longer matches              | Re-read                            |
| `busy`                 | In use                                                     | Later                              |
| `too_large`            | Over a limit the caller passed in                          | No                                 |
| `unsupported`          | An optional capability is absent                           | No                                 |
| `unauthenticated`      | Engine or GitHub account is not signed in                  | After sign-in                      |
| `unavailable`          | Not sent                                                   | Yes                                |
| `unknown_outcome`      | Sent, no reply                                             | Only by the operation's retry rule |
| `host_gone`            | No host to attach to                                       | Relaunch                           |
| `fenced`               | Refused by an update fence, not started                    | When released                      |
| `cancelled`, `timeout` | Ended by the caller or the deadline                        | By the retry rule                  |
| `failed`               | It ran and failed                                          | No                                 |

Any operation may return `invalid`, `unavailable`, `unknown_outcome`, `fenced`, `cancelled`, `timeout` or `failed`. The tables list only the others.

### 1.3 Operations

**As built (T04, `c545c09ef`):** the contract in `packages/runner-protocol/src/contract/**` was typed from the executors' real output and wins wherever these tables differ (34 recorded differences). The tables keep the design intent.

There are 66 operations: 15 in the protocol, 41 in the protocol but done differently by local, 9 local-only and 1 missing.

**Today** column:

- **P**: in the wire protocol.
- **L**: a local-only method or direct controller code.
- **P+L**: in the protocol, but local does not use it or uses a different signature.
- **M**: missing from both, or only a fragment exists.

**Retry** column:

- **read**: safe to repeat.
- **key:x**: a repeat with the same x returns the first result. A different request under the same x is `conflict`.
- **state:x**: safe to repeat, rejected if x changed.
- **none**: never repeated automatically.

#### Runner and transport

| Operation         | Request → response                               | Stream  | Errors | Retry | Today                                      |
| ----------------- | ------------------------------------------------ | ------- | ------ | ----- | ------------------------------------------ |
| `runner.describe` | none → `RunnerDescription`                       | no      | none   | read  | P+L (`ready` has 21 flags, local has none) |
| `runner.health`   | none → `{build, sessions, working, cpu, memory}` | samples | none   | read  | P (remote only)                            |

Enrollment and TLS belong to the transport package. They are not runner operations.

#### Sessions and hosts

| Operation         | Request → response                                                                                                                      | Stream | Errors                                                    | Retry             | Today                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------- | ----------------- | ------------------------------- |
| `session.launch`  | `{session, launchId, engine, model, effort, access, resume, systemText, firstText, overflowNotice, env, mcp[], owner}` → `{instanceId}` | no     | `conflict`, `not_found`, `unauthenticated`, `unsupported` | key:launchId      | P+L (side channel)              |
| `session.attach`  | `{session}` → channel (1.4)                                                                                                             | yes    | `host_gone`                                               | read              | P                               |
| `session.alive`   | `{session}` → `{state: live/gone/stale}`                                                                                                | no     | none                                                      | read              | P (boolean)                     |
| `session.stop`    | `{session, force}` → `{state: stopped}`                                                                                                 | no     | none                                                      | read (idempotent) | P                               |
| `session.discard` | `{session}` → `{}`                                                                                                                      | no     | `busy`                                                    | read (idempotent) | P                               |
| `session.logs`    | `{session, lines}` → `{live, text}`                                                                                                     | no     | `not_found`                                               | read              | P (formatted differently)       |
| `session.list`    | `{owner}` → `{session, state, instanceId, build, retained}[]`                                                                           | no     | none                                                      | read              | L (`listHosted`, `inspectHost`) |
| `session.sample`  | `{sessions[]}` → `{session, cpu, rss, processes}[]`                                                                                     | no     | none                                                      | read              | L (`hostPid`)                   |

`env` values are either a string or `{from: "session.id" | "session.filesDir" | "mcp.origin" | "mcp.caFile"}`. Dispatch can ask for `DISPATCH_FILES_DIR` without the runner knowing that name or the controller knowing the path. `mcp[]` is `{name, url, token, caPem?}`.

#### Terminals

| Operation       | Request → response                                                                         | Stream | Errors              | Retry | Today                   |
| --------------- | ------------------------------------------------------------------------------------------ | ------ | ------------------- | ----- | ----------------------- |
| `terminal.open` | `{target, cols, rows}` → `{cwd, host, user}` + input, resize, detach, resume, output, exit | yes    | `not_found`, `busy` | none  | P+L (`terminalBackend`) |

#### Workspaces and checkouts

| Operation            | Request → response                                                                           | Stream   | Errors                               | Retry                     | Today                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- | -------- | ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.prepare`  | `{session, source, worktree?, copyIgnored[], installDependencies}` → `Binding`               | progress | `conflict`, `not_found`, `forbidden` | key:session + spec digest | L (`bindWorkspace`, `prepareWorkspace`), buried in P `launch`                                                                               |
| `workspace.resume`   | `{session}` → `Binding` or none                                                              | progress | `conflict`, `not_found`              | key:session               | L (`resumeWorkspace`)                                                                                                                       |
| `workspace.describe` | `{session}` → `Binding`                                                                      | no       | `not_found`                          | read                      | P+L (`sessionCheckout describe`, `requestedWorktree`)                                                                                       |
| `workspace.select`   | `{session, path or null}` → `Binding`                                                        | no       | `not_found`, `forbidden`             | read (idempotent)         | P+L (two algorithms). Any directory the account can use, on every runner, as main. Not restricted by D7: the agent chooses it, not the user |
| `workspace.observe`  | `{session, base}` → ownership, owner, borrowers, `{stateId, unmerged, changed, uncommitted}` | no       | `not_found`                          | read                      | P+L                                                                                                                                         |
| `workspace.release`  | `{session, deleteBranch, originalBranch}` → `{removed}` (T04 correction C1)                  | no       | none                                 | read (idempotent)         | P+L. Main's removal exactly: Dispatch decides (co-owner, mode, status) and the runner removes. No state recheck, no borrower deferral (T20) |
| `path.resolve`       | `{path}` → `{canonical, exists, directory, restricted, projectRoot, git: GitContext}`        | no       | `forbidden`                          | read                      | L (`resolveLaunchDirectory`, `resolveProjectRoot`, `canonicalPath`, `inspectLocalPath`). Sent to the controller's runner only (D7)          |
| `path.complete`      | `{prefix, limit}` → `{entries[], restricted}`                                                | no       | `forbidden`                          | read                      | L. Controller's runner only (D7)                                                                                                            |

- `source` is one of `{directory: path}`, `{repository: url, checkout}`, `{session}` (borrow) or `{scratch}`. Under D7 Dispatch sends a user-named `{directory}` only to the controller's runner. On any runner, an agent's independent worktree of its own folder is `{directory}` with the session's current path, which may be a folder it moved itself into with `set_workspace`. `{scratch}` stays where it exists today: it is a runner-made folder, not a user-named one.
- `worktree` is `{branch, create, base, location}`. `location` is `sibling` or `{nested: relativeDir}`, so `.dispatch/worktrees` comes from Dispatch (T04 correction C2).
- `Binding` is `{launchPath, currentPath, filesDir, ownership, owner, branch, base, git}`.

**Much of the preparation fork is a category error: source has been confused with placement.** A worktree from a directory copies `.env`, sees that repository's tags and needs no origin. A worktree from a URL has no directory to copy from. Both platforms implement both sources. An agent asking for a worktree of its own checkout always uses the directory source. URL sources accept what Git on that account accepts: there is no HTTPS-only rule, hook ban or runner-only branch rule. **D7 decides which sources Dispatch sends where:** a user's folder only on the controller's runner, a repository for every other runner.

#### Checkout views

| Operation               | Request → response                                                          | Stream | Errors                   | Retry        | Today                                        |
| ----------------------- | --------------------------------------------------------------------------- | ------ | ------------------------ | ------------ | -------------------------------------------- |
| `checkout.list`         | `{target, path}` → entries                                                  | no     | `not_found`, `forbidden` | read         | P+L                                          |
| `checkout.read`         | `{target, path, encoding, maxBytes}` → `{data, digest}` or absent           | no     | `forbidden`, `too_large` | read         | P+L (`readFile`, command `read`)             |
| `checkout.write`        | `{target, path, data, expectedDigest or null}` → `{digest}`                 | no     | `forbidden`, `stale`     | state:digest | L (`persona_upsert` writes controller files) |
| `checkout.preview`      | `{target, path}` → text, image, SVG or unsupported                          | no     | `not_found`, `too_large` | read         | P+L                                          |
| `checkout.index`        | `{target, generation}` → paths                                              | no     | none                     | read         | P+L                                          |
| `checkout.stats`        | `{target, base, uncommitted, exclude[]}` → totals, excluded totals, outcome | no     | `not_found`              | read         | P+L                                          |
| `checkout.diff`         | `{target, base, uncommitted, whitespace, path?}` → files and hunks          | no     | `too_large`              | read         | P+L                                          |
| `checkout.image`        | `{target, base, path, side}` → bytes                                        | no     | `not_found`, `too_large` | read         | P+L                                          |
| `checkout.changes`      | `{target, base}` → `{baseRef, head, stateId, files}`                        | no     | `not_found`              | read         | P+L                                          |
| `checkout.defaultFiles` | `{target, dirs[], wait}` → files, refresh state                             | no     | none                     | read         | P+L                                          |
| `checkout.watch`        | `{target}` → change pulses                                                  | yes    | `busy`                   | read         | P+L                                          |

#### Repo tools and hooks

| Operation       | Request → response                                                                                                                               | Stream | Errors          | Retry | Today                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------- | ----- | ----------------------------------- |
| `checkout.exec` | `{target, guard: {path, digest}, argv, env, timeoutMs or null, maxOutput or null, shell: direct or login}` → `{exit, stdout, stderr, truncated}` | cancel | `stale`, `busy` | none  | P+L (the binding is a side channel) |

The runner does not know "tool" or "hook". Dispatch supplies the manifest path, argv and limits. The fixed `repo` command is deleted.

#### Session files

| Operation   | Request → response                                 | Stream    | Errors                   | Retry             | Today                |
| ----------- | -------------------------------------------------- | --------- | ------------------------ | ----------------- | -------------------- |
| `files.put` | `{session, name, size, digest, blob}` → `{path}`   | bytes in  | `not_found`, `conflict`  | key:name + digest | P+L (two signatures) |
| `files.get` | `{session, path}` → `{name, size, digest}` + bytes | bytes out | `not_found`, `forbidden` | read              | P+L (two policies)   |

`blob` is resolved by the transport. TLS streams the bytes. The local-socket transport may send the path of an existing file, which the child opens itself, so local keeps today's in-place path with no copy. That is a transport frame accepted on no other transport, not an operation field. The caller gets a path either way.

#### Git context

| Operation           | Request → response                                                           | Stream | Errors            | Retry | Today                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------- | ------ | ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `git.context`       | `{target}` → repository root, checkout root, branch, head, origin, icon path | no     | none              | read  | P+L (`describe`, local probe)                                                                                                   |
| `git.defaultBranch` | `{target}` → branch or null                                                  | no     | none              | read  | L                                                                                                                               |
| `git.branches`      | `{target}` → branches                                                        | no     | `unauthenticated` | read  | L, P for GitHub URLs. `{path}` locally as main (no `defaultBranch` field, P6); `{repository}` for a project on any other runner |
| `git.base`          | `{target, requested, fallback[]}` → resolved base                            | no     | none              | read  | P+L (hidden inside views)                                                                                                       |

Dispatch chooses `requested` and `fallback`. The runner never hard-codes `main` or `origin/main`.

#### GitHub

| Operation             | Request → response                                      | Stream | Errors                         | Retry             | Today |
| --------------------- | ------------------------------------------------------- | ------ | ------------------------------ | ----------------- | ----- |
| `github.account`      | none → state, login, opaque context                     | no     | none                           | read              | P+L   |
| `github.login.start`  | `{requestId}` → code, URL                               | no     | `busy`                         | key:requestId     | P     |
| `github.login.cancel` | `{requestId}` → state                                   | no     | none                           | read (idempotent) | P     |
| `github.logout`       | none → state                                            | no     | none                           | read (idempotent) | P     |
| `github.repositories` | `{query}` → repositories                                | no     | `unauthenticated`              | read              | P     |
| `github.branches`     | `{owner, repo}` → branches, default                     | no     | `unauthenticated`              | read              | P+L   |
| `github.pr.head`      | `{owner, repo, number}` → URL, branch                   | no     | `unauthenticated`, `not_found` | read              | P+L   |
| `github.pr.status`    | `{target}` → state, draft, title, head, checks, context | no     | `unauthenticated`              | read              | P+L   |
| `github.pr.details`   | `{target}` → evidence, context                          | no     | `unauthenticated`              | read              | P+L   |
| `github.pr.diff`      | `{target, base, head, context}` → files                 | no     | `unauthenticated`, `stale`     | read              | P+L   |

**Credentials:** always the workload account of the runner named by the placement. For local that is the user's own `gh`, as today. An agent's PR is read through that agent's placement. Dispatch's own release operations are controller platform work and stay outside the protocol. `watchPullRequests` is removed: cadence and backoff are policy, and Dispatch's refresher should poll every placement alike.

#### Engines

| Operation              | Request → response                                             | Stream   | Errors                | Retry             | Today                     |
| ---------------------- | -------------------------------------------------------------- | -------- | --------------------- | ----------------- | ------------------------- |
| `engine.list`          | `{refresh}` → id, installed, version, path, signed-in, actions | no       | none                  | read              | P+L                       |
| `engine.install`       | `{engine, requestId}` → operation ID                           | progress | `busy`, `unsupported` | key:requestId     | P+L (local refuses)       |
| `engine.update`        | `{engine, requestId}` → operation ID                           | progress | `busy`, `unsupported` | key:requestId     | P+L                       |
| `engine.operation`     | `{operationId}` → state                                        | no       | `not_found`           | read              | P+L                       |
| `engine.login.start`   | `{engine, restart, requestId}` → login view                    | events   | `unsupported`, `busy` | key:requestId     | P+L                       |
| `engine.login.submit`  | `{loginId, code}` → login view                                 | no       | `not_found`           | none              | P+L                       |
| `engine.login.status`  | `{loginId}` → login view                                       | no       | `not_found`           | read              | P+L                       |
| `engine.login.cancel`  | `{loginId}` → login view                                       | no       | `not_found`           | read (idempotent) | P+L                       |
| `engine.models`        | `{engine, model?}` → models, default, efforts                  | no       | `unauthenticated`     | read              | P+L (different semantics) |
| `engine.usage`         | none → providers, windows, reset handle                        | no       | none                  | read              | P+L                       |
| `engine.quota.reset`   | `{engine, account, requestId}` → result                        | no       | `stale`               | key:requestId     | P+L                       |
| `engine.plugin.status` | `{engine, plugin}` → versions, actions                         | no       | `unsupported`         | read              | P+L                       |
| `engine.plugin.apply`  | `{engine, plugin, action, requestId}` → status                 | no       | `unsupported`, `busy` | key:requestId     | P+L                       |

The plugin list is composition configuration, identical for both platforms, not a `dispatch@dispatch` literal.

#### Ports

| Operation      | Request → response                                  | Stream | Errors      | Retry | Today           |
| -------------- | --------------------------------------------------- | ------ | ----------- | ----- | --------------- |
| `port.connect` | `{session, port}` → bytes to that runner's loopback | yes    | `not_found` | none  | M (decided, D6) |

#### Updates (optional `selfUpdate` capability)

| Operation         | Request → response             | Stream | Errors                    | Retry             | Today |
| ----------------- | ------------------------------ | ------ | ------------------------- | ----------------- | ----- |
| `update.offer`    | `{attempt, target}` → status   | events | `unsupported`, `conflict` | key:attempt       | P     |
| `update.fence`    | `{attempt, retained}` → status | no     | `stale`                   | key:attempt       | P     |
| `update.activate` | `{attempt}` → status           | no     | `stale`                   | key:attempt       | P     |
| `update.confirm`  | `{attempt}` → status           | no     | `stale`                   | key:attempt       | P     |
| `update.cancel`   | `{attempt, reason}` → status   | no     | none                      | read (idempotent) | P     |

The local child is updated by the app and always runs the app's build, so it does not offer this capability. Host drain uses `session.list` on every placement.

### 1.4 The prompt and ACP byte channel

`session.attach` carries the existing host vocabulary, which is already common to both. Three changes are needed:

1. **Bring the extensions into the protocol.** `prompt_receipt`, `quiesce`, `release_quiesce`, quiesced `shutdown` and the reply extensions live in Dispatch's `agents/acp/host-protocol.ts` today.
2. **Bring the event vocabulary in.** The protocol says `event: unknown`, and the real type is `DriverEvent` in `agents/acp/driver.ts`. A second product would have to reverse-engineer the journal. Events, permissions, config options, commands, MCP inventory and background snapshots become protocol types, with ACP updates passed through as JSON.
3. **Make `source` truly opaque.** The host validates Dispatch's `PromptSource` today (`agents/acp/host-protocol.ts:117-122`). Dispatch validates it on receipt instead.

**The client negotiates from the host, never from placement.** Hosts from this branch advertise `replay_complete`. For a main-era host, which does not:

- it is ready once replay has reached `welcome.journalSeq`
- no receipt, lease, build identity or instance ID is expected
- an unacknowledged prompt is not resent
- `shutdown {idleOnly}` is honoured by main's hosts and ignored by older ones, so it is sent only after the host reported no open turn
- inventory uses pid and argv, never a connection, and there is one connection per host.

| Message                                  | Identity                  | Today                          |
| ---------------------------------------- | ------------------------- | ------------------------------ |
| `hello` / `welcome`, replay              | journal ID + sequence     | P                              |
| `prompt`, receipt                        | operation ID + journal ID | P                              |
| `prompt_receipt`                         | same                      | L (host extension)             |
| `steer`, `interrupt`, `cancel`           | ID, turn sequence         | P                              |
| `answer_permission`, `set_config`        | ID                        | P (reply types are extensions) |
| `mcp_inventory`, `background_work`       | ID + engine session       | P (payloads are extensions)    |
| `quiesce`, `release_quiesce`, `shutdown` | hold ID                   | L (host extension)             |
| `event`                                  | journal ID + sequence     | P envelope, L payload          |

### 1.5 Capabilities

- Everything above is **baseline**, ports, health and engine operations included: a runner that lacks one does not pass conformance.
- The only optional capability is `selfUpdate`. Whether one engine can be installed or updated is reported per engine in `actions`, as local does today.
- Today's 21 booleans and the per-flag refusals in `agents/remote/service.ts:2215-2315` are deleted.
- Adding an optional capability or any limit changes the E8 snapshot.
- Validators may not be stricter than main's local behaviour: file names, path characters, branch names, sizes, counts and timeouts.

### 1.6 The local launcher channel (not part of `Runner`)

A pipe from the app to its child. It exists only for a parent that starts a runner, and has exactly five messages:

| Message                                                                                    | Purpose                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `start {build, protocol, nonce, roots, config}` → `ready {build, protocol, nonce, socket}` | Configuration and exact-version handshake               |
| pipe EOF                                                                                   | Lifeline: the child exits. Detached hosts are untouched |
| `freeze` / `thaw`                                                                          | The updater's write fence                               |
| `import {bindings[]}`                                                                      | One-time bindings for sessions from older builds        |

It is not reachable over the socket or TLS, its schema is in the E8 snapshot, and no product operation may be added to it.

### 1.7 What the protocol must not contain

- The meaning of any prompt, system text or first-message text.
- Personas, reviews, owners, CODEOWNERS, "review base".
- Tasks, boards, projects, jobs, templates, schedules.
- Brain, chat, streams, threads, notifications, reactions.
- Policy: who may launch where, which base to prefer, when to archive, retention, poll cadence, steering eligibility, what counts as a test file.
- Dispatch names: `DISPATCH_*`, `.dispatch/…`, `agt_`, `dispatch@dispatch`, the default MCP name `dispatch`.
- Controller paths, database IDs other than opaque handles, HTTP statuses.

**Leaks to remove. [code]**

| Leak                                           | Where                                                                           | Becomes                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `personaContext` and the persona overflow text | `packages/runner-protocol/src/execution.ts:68`, `agents/acp/persona-context.ts` | `firstText`, `overflowNotice`  |
| `PromptSource` validated in the host           | `agents/acp/host-protocol.ts:117-122`                                           | opaque `source`                |
| Dispatch environment built by the runner       | `agents/remote/session-supervisor.ts:920-928`                                   | `env` bindings                 |
| `dispatchReviewBase` Git config                | `agents/remote/session-storage.ts:117-123`                                      | a recorded base in the binding |
| Owner-review helpers inside inspection         | `agents/checkout-inspection.ts:27-30`                                           | `checkout.changes`             |
| `excludingTests`                               | `packages/runner-protocol/src/checkout-view.ts:100`                             | caller-supplied `exclude[]`    |
| Tool and hook timeouts                         | `packages/runner-protocol/src/checkout-command.ts:4-23`                         | `timeoutMs`                    |
| Plugin literal                                 | `agents/remote/engine-capability-worker.ts:183`                                 | configured list                |
| `agt_` storage rule                            | `agents/remote/session-supervisor.ts:68-72`                                     | opaque key, with a legacy read |
| `~/.dispatch/env`, environment scrub rules     | `agents/acp/host-command.ts:48-113`                                             | composition config             |
| Fixed `repo` command                           | `agents/remote/runner.ts:1139-1156`                                             | deleted                        |
| PR watch cadence                               | `agents/remote/github-pull-request-watches.ts`                                  | Dispatch's refresher           |

---

## 2. The model

### 2.1 Placement is always present

```ts
type Placement = Opaque<{ runner: RunnerId }>; // no workspace (D7)
type AgentRecord = {
  placement: Placement; // never null, never optional
  cwd: RunnerPath; // launch checkout on that runner
  launchCwd: RunnerPath | null; // what was asked for
  workspacePath: RunnerPath | null; // mirror of the runner's selection
};
```

- **Database:** `runner_id text NOT NULL DEFAULT 'local'`. There is no `runner_workspace` column (D7). Local `cwd` values are unchanged, so an older app still works on the migrated database. The SQL default exists only for that rollback. TypeScript requires the field.
- **What replaces "`cwd` encodes placement":** that column. Jobs, templates, job-run config and launch requests store a `Location`: `{runner, path}` on the controller's runner, `{runner, projectId}` on any other (D7). `runner://` is accepted at one input decoder during the branch's life and deleted at T40.
- **Trial remote rows:** placement is read from the locator, and its workspace segment is dropped. The path stays unresolved until `workspace.describe` fills it. The migration fails loudly if a registration is already called `local`.
- **Equality:** `samePlacement(a, b)` and `sameRunner(a, b)` are the only comparisons. The local ID is a value users and tools can pass, but code cannot compare against it outside `runners/`.
- **Four rules must know the app's own machine.** They live in `runners/controller-machine.ts`, return values and not booleans, and their export list is snapshotted:
  1. `identityKey`: existing local Brain keys (D5 as revised by D8)
  2. `blobSource`: a file in place or bytes
  3. `previewUrl`: forward a loopback URL or leave it unchanged (D6)
  4. `ideTarget`: is the checkout on this machine, for the existing IDE rule.
- **`agentWorkspaceDir` and `agentDiffPath` are deleted.** A consumer either shows a path as text or sends a target to the runner.

### 2.2 The local side channel disappears

| Side input today                      | Where it goes                                                            |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `cwd` at launch                       | The runner's own `Binding`                                               |
| `bins`                                | Resolved by the runner, with overrides from `start`                      |
| `env`                                 | The request's generic `env`, with bindings for machine-local values      |
| `pathPrefix`                          | `start` config, or the remote runner's config                            |
| `checkout: AgentRecord` on commands   | The runner's binding                                                     |
| Files root, other agents' directories | Layout from `start`. D4 removes the need for other agents' directories   |
| Borrower query                        | Runner bindings. Dispatch still passes its co-owner decision as "retain" |

**One-time binding import.** Agents created by main have no binding on disk, and the child has no database. Before the child serves a session, the app sends `import` for sessions that lack one, read from the agent rows.

- It never overwrites an existing binding, so repeating it at each start is safe, including after a rollback to main created more agents.
- It covers archived rows with cleanup pending.
- The child records "owned worktree" only if Git says that path is a linked worktree. Anything else is external and is never deleted. A changed branch keeps the branch, as main does.
- It is launcher-only. An adopt operation on the wire would be a delete-any-path primitive.

### 2.3 The local runner process

**Start**

- The server spawns `<its own executable> local-runner` before it restores agents, probation starts included.
- The child gets main's scrubbed child environment, after login-shell restoration, plus `start` on the pipe: roots, the adapter captured at startup, bins and prefixes. It never gets the database URL or the app's tokens.
- MCP over loopback HTTP stays valid. The core must not copy the remote supervisor's HTTPS-only check.

**Identity and exclusivity**

- A kernel-held lock keyed by the agent state root, released on death. The Linux supervisor has one. The macOS equivalent is to be proved in L1 [inferred].
- The socket is in a private 0700 runtime directory outside the backed-up state paths, short enough for macOS's socket path limit. A connection must present the spawn's nonce.
- A build, protocol or root mismatch fails the handshake. The app restarts the child. There is no in-process fallback.

**Lifeline**

- On EOF the child stops accepting, aborts its own commands, closes terminals and exits within the app's shutdown grace.
- It never stops hosts.
- A replacement waits for the lock. It signals a leftover only after matching its argv, root and identity.

**Unavailable is not dead**

- Socket loss is `unavailable`. The client retries for as long as the app runs, queues prompts in the existing queue and shows the existing reconnecting state.
- An exit is recorded only when a runner answers that the host is gone. Today the local client gives up after about 25 seconds and records one. **[code]**
- Startup never settles an agent as lost because the child is not up yet.
- The supervisor restarts the child with backoff.

**App restart, with turns in flight**

- The engine keeps working in the detached host. The journal and permission requests replay on re-attach.
- As today: prompts still in the app's memory are lost and marked not delivered, an unacknowledged prompt is not resent, Dispatch tool calls fail while the app is down, and terminals close.

### 2.4 Upgrades and the updater

**Protected update**

1. Busy checks read through the child. An unavailable child counts as busy, so the update defers.
2. The app has idle hosts stopped through the child, using `idleOnly`.
3. The app writes main's resume receipt, merged per transaction.
4. The app sends `freeze`: no spawns, preparation, engine operations, sweeps or journal and binding writes.
5. The boundary check reads a fresh host list from the frozen child.
6. Backup, then the app exits and the lifeline ends the child.
7. The new app starts its child frozen. Probation quiesces surviving idle hosts through it, as main does.
8. On commit: `thaw`, import, restore, resume idle agents with the same session ID.

An aborted fence thaws.

**Unprotected paths** (manual or external-database update, crash)

- Hosts from the old build survive. The child attaches using the main-era client rules in 1.4.
- They move to the new build on their next stop and start. Idle recycling of them is not planned.

**Existing behaviour kept:** if Claude or Codex cannot resume, a fresh session starts. OpenCode errors.

### 2.5 One core, two platforms

```
Dispatch app ──► Runners ──► runner-client
                               ├─ local socket ─► local-runner child ─► core ─► posix-user
                               │                        └─► detached agent hosts (survive both)
                               └─ TLS ──────────► remote runner ─────► core ─► linux-privsep
```

The core owns bindings, the session state machine, launch idempotency, preparation, release and every handler. The platform port is small:

```ts
interface Platform {
  workload: {
    run<K extends WorkerOp>(
      op: K,
      input: In<K>,
      o: RunOptions
    ): Promise<Out<K>>;
  };
  processes: { spawn; identify; connect; signal; reap; sample };
  layout: { state; files; sessions; cache };
  privateState: { read; write; remove; resetHost };
}
```

|                              | `posix-user`                                       | `linux-privsep`                                     |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Who runs workload operations | The same user, as a direct function call           | `setpriv` self-exec of **one** `runner-worker <op>` |
| Process identity             | `ps` argument match, as on main                    | Boot ID, PID namespace, start time, pidfd           |
| Layout                       | Today's `agentStateRoot/<id>` and `filesRoot/<id>` | Today's `/var/lib/dispatch-runner`                  |
| Private state                | 0600 in the user's directory                       | Root-owned                                          |
| Health                       | Process tree sample                                | cgroup v2                                           |

The remote runner already has this split by hand. Each checkout operation is a separate self-exec subcommand running as the workload (`main.ts:47-93`), and those functions are mostly the same leaf modules local calls. The design makes that split the port and deletes the second supervisor logic, not the security boundary. Root never performs a workload filesystem or Git operation.

### 2.6 macOS as a runner target

A macOS runner would be `posix-user` plus the TLS transport, with launchd and its own updater later. Only these points affect the interface:

- Paths are POSIX absolute strings. Case and Unicode comparison happens in the runner, never in Dispatch.
- `restricted` is a normal path result, for privacy-protected folders. It is the OS's rule.
- The contract has no uid, cgroup, systemd or `/proc`.
- `selfUpdate` stays optional.

### 2.7 Differences that remain legitimate

Only facts about a machine:

- it is unreachable or being updated
- its account has different logins or permissions
- it has different software installed
- its loopback is its own.

These appear as connection state, OS errors, engine `actions` or one of the four named rules. The local child can be unavailable too, so the retry rules are shared. **No difference in what a caller may ask is legitimate**, with one owner-decided exception: a user names folders only on the controller's machine (D7), so other runners take projects, not folders.

---

## 3. The boundary in code

### 3.1 Packages

```
packages/runner-protocol/     operations, types, validators, errors. No Node, no dependencies.
packages/runner-client/       byte framing, connection, session/replay client,
  src/transport/              local socket, TLS service side
  src/launcher/               spawn, handshake, lifeline, freeze, import
packages/runner/              the runner, usable without Dispatch
  src/core/                   handlers, bindings, sessions, workspaces
  src/workload/               fs, git, gh, engine CLI, pty: run as the workload
  src/host/                   agent host, ACP driver, engine specs
  src/platform/               posix-user/, linux-privsep/
  src/transport/              TLS runner side, enrollment
  src/update/                 Linux self-update
  src/local/                  child entry, socket server, lock
  src/cli.ts                  standalone entry: local-runner, remote-runner, agent-host
packages/runner-conformance/  scenarios, reference client
apps/server/src/runners/
  local.ts                    starts and supervises the child through runner-client
  controller-machine.ts       the four named rules
  directory.ts                Runners
  enrolled/                   registry, approvals, listener policy
```

### 3.2 Who may import what

| Importer                      | May import                                                                              | May not                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| protocol                      | itself                                                                                  | Node, any package                                                 |
| client                        | protocol, Node streams, net, TLS. `child_process` and socket checks in `launcher/` only | runner, Dispatch                                                  |
| runner                        | protocol, client framing, ACP SDK and adapters, Node                                    | `apps/**`, `@dispatch/shared`, `pg`, `fastify`                    |
| conformance, reference client | protocol, client                                                                        | runner internals, Dispatch                                        |
| Dispatch generally            | protocol types, `runners/directory`                                                     | runner, transports, host modules, `node:fs`, `node:os`, processes |
| `runners/local.ts`            | client launcher and socket transport                                                    | runner, host modules                                              |
| `runners/enrolled/**`         | client TLS transport                                                                    | runner                                                            |
| `main.ts`                     | `@dispatch/runner/cli`, only in subcommand branches that never load the server          | anything else in runner                                           |
| web                           | protocol types                                                                          | `runner://`, placement inspection                                 |

### 3.3 What moves

| From                                                                                                                                                         | To                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `agents/acp/host/main.ts`, `driver.ts`, `engine-spec.ts`, `host-env.ts`, `host-command.ts`, `opencode-instructions.ts`, `permissions.ts`, `background-*`     | `runner/host`                                                             |
| `agents/acp/host-protocol.ts`                                                                                                                                | protocol, with product types removed                                      |
| `agents/acp/host-client.ts`, `packages/runner-protocol/src/{connection,node}.ts`                                                                             | client                                                                    |
| `agents/workspace.ts`, `workspace-prep.ts`, `worktree-local-config.ts`                                                                                       | `runner/workload`                                                         |
| `agents/checkout-{view,watch,inspection,observation,command-executor}.ts`, `default-branch-files.ts`                                                         | `runner/workload`                                                         |
| `shared/git/**`, `shared/github/pr.ts`, `shared/process/**`, `shared/repo-icon.ts`, `files/workspace-*`, `files/session-file.ts`, `projects/resolve-root.ts` | `runner/workload`. Pure parsers go to protocol                            |
| `agents/engine-{availability,login,updates}.ts`, `provider-plans.ts`, `shared/plugin-status.ts`, `remote/engine-*executor`, capability worker                | `runner/workload/engines`, merged pairwise                                |
| `agents/github-pull-request-evidence.ts`, `remote/github-runner-executor.ts`                                                                                 | `runner/workload/github`                                                  |
| `terminal/pty.ts`, `process-session.ts`, `runner-worker.ts`                                                                                                  | `runner/workload`                                                         |
| `agents/remote/session-{supervisor,storage,processes}.ts`                                                                                                    | split between core and `linux-privsep`                                    |
| `agents/local-runner*.ts`                                                                                                                                    | handlers move into the child family by family, then deleted               |
| `agents/remote/runner.ts`                                                                                                                                    | TLS runner transport + CLI                                                |
| `agents/remote/update-{agent,trial,probe,verify,stage-cli,fence-store}`                                                                                      | `runner/update`                                                           |
| `agents/remote/service.ts`                                                                                                                                   | peer and TLS code to client, registry and approvals to `runners/enrolled` |
| `agents/engine-models.ts`                                                                                                                                    | stays. Learning is Dispatch's, keyed by runner                            |
| `agents/remote/update-{coordinator,hold}`, `force-sessions`, `event-inbox`, refresher, merge-risk policy, archive policy                                     | stay. They work through `Runner`                                          |
| `build-identity.ts`                                                                                                                                          | stays. Passed to the runner as config                                     |

`dispatch agent-host --state <dir>` keeps exactly that argv. Process identity matches on that string (`agents/local-runner.ts:117`), so live hosts from main depend on it.

---

## 4. Enforcement

**What a separate process changes**

|                                                          | Now impossible or simpler                                         | Still possible, so still gated                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Passing closures, records or database handles into local | Impossible: bytes on a socket                                     |                                                                                                                                   |
| A second set of local executors                          | Impossible once each family moves: Dispatch has no import of them | Until then, adapters are baseline entries (R3)                                                                                    |
| Non-serialisable requests, unvalidated replies           | Impossible: the real codec always runs                            |                                                                                                                                   |
| Strict in-process test transport, third lane             | Deleted                                                           |                                                                                                                                   |
| **Going around the runner**                              |                                                                   | The app is the same user on the same disk. `fs`, Git and `spawn` work silently for local. This is how most forks happened. E2, E3 |
| **Branching or refusing by placement**                   |                                                                   | A process boundary does nothing for it. E2, E3, E9                                                                                |
| Different results by platform                            |                                                                   | E5                                                                                                                                |
| Product concepts in the runner                           | Importing them is harder                                          | Naming and copying them is not. E6, E8                                                                                            |
| A side channel growing elsewhere                         |                                                                   | The launcher pipe and the blob frame. E8                                                                                          |

This is designed around what failed when tried. **[ran]**

| Obvious mechanism                       | Result                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Put it in another package               | Imported server source by relative path and typechecked cleanly. Fails only with `rootDir` set                                                                                               |
| Rely on `package.json` dependencies     | `pg`, `fastify` and the server all resolve, through hoisting                                                                                                                                 |
| Branded string for runner paths         | `fs.readFile(runnerPath)` compiles. An opaque non-string type is rejected                                                                                                                    |
| ESLint `no-restricted-imports`          | Caught static imports. Missed `import()`, `Bun.spawn`, `process.getBuiltinModule` and wrappers                                                                                               |
| `types: []` on the protocol             | Correctly rejects `node:fs`                                                                                                                                                                  |
| AST scanner over the server (prototype) | 0.35 seconds. Caught five planted violations: `import()`, `Bun.spawn`, `getBuiltinModule`, a re-export and a placement check. A wrapper is caught only at the file that does the host access |

### E1. Package boundaries · `pnpm run check`

- Dispatch has no import of `@dispatch/runner` outside `main.ts`'s subcommand branches. The server bundle's metafile is checked for it.
- A tsconfig per package with `rootDir: "src"`. The protocol also has `types: []`, which needs the framing code moved to client.
- All four packages are added to the root `check`, with a test that fails if a workspace package is missing from it.
- The scanner rejects any import not declared in that package's `package.json`.
- A build test bundles `packages/runner/src/cli.ts` alone and fails if the metafile contains an `apps/` input.

**Catches:** runner→Dispatch imports including transitive ones, Node in the protocol, undeclared dependencies.
**Cannot:** detect Dispatch logic copied into the runner.
**Cost:** 1 task, a few seconds per check.

### E2. Boundary scanner and ratchets · `pnpm run check`, pre-commit, CI

`scripts/check-runner-boundary.mjs` uses the TypeScript compiler already installed, so there is no new dependency. In controller code it bans:

- value imports, re-exports, `import()` or `require` of `fs`, `os`, `child_process`, `worker_threads`
- `Bun.spawn`, `Bun.file`, `Bun.write`, `Bun.$`, `process.kill`, `process.getBuiltinModule`, `createRequire`, computed imports
- imports of any host module (Git, gh, command runner, workspace, engines, runner packages)
- `remotePlacement`, `runner://` literals and patterns, `runner://` in SQL, any read of `.runner` or the local ID outside `runners/`
- any use of `controller-machine.ts` beyond its four exports and their listed callers
- `defaultPlacement()` outside the listed create-default call sites, and comparing a runner ID or description ID with a literal. Either would be "is local" by another name

**The exact allowlist.** Each entry carries a reason in the script. An unknown file is controller code by default.

| Glob under `apps/server/src/`                                                                                                                                                                            | Own-machine reason                         | May use                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `runners/local.ts`                                                                                                                                                                                       | starts its own child                       | client launcher                        |
| `runners/controller-machine.ts`                                                                                                                                                                          | the four named rules                       | blob-store paths                       |
| `runners/enrolled/**`                                                                                                                                                                                    | listener, keys                             | fs, TLS                                |
| `db/**`                                                                                                                                                                                                  | migrations, Postgres                       | fs                                     |
| `update-recovery/**`, `server/update-recovery-runtime.ts`                                                                                                                                                | backup of Dispatch itself                  | fs, processes                          |
| `server/release-*.ts`, `routes/release.ts`, `release-{store,candidate-store,tarball-cache}.ts`                                                                                                           | Dispatch's own releases                    | fs, processes                          |
| `server/runner-artifacts.ts`, `server/runner-dev-key.ts`                                                                                                                                                 | serves installers                          | fs                                     |
| `startup/**`, `main.ts`                                                                                                                                                                                  | bootstrap                                  | fs, processes, runner CLI in `main.ts` |
| `local-tls.ts`, `routes/local-trust.ts`                                                                                                                                                                  | Dispatch's certificate                     | fs, openssl                            |
| `config.ts`, `state-dir.ts`, `multi-listener.ts`, `diagnostics.ts`, `server/http-logging.ts`                                                                                                             | own config, sockets, logs                  | fs, os                                 |
| `files/{store,send-file,image-variants}.ts`, `routes/files.ts`, `routes/browser-extension.ts`, `agents/file-seed.ts`, `agents/retention.ts`, `tasks/attachment-store.ts` (split from `tasks/service.ts`) | Dispatch's blob store, never a workspace   | fs                                     |
| `observability/artifact-storage.ts`                                                                                                                                                                      | size of Dispatch's stores                  | fs, `du`                               |
| `notifications/slack-link-origins.ts`, `shared/lib/clipboard-capability.ts`                                                                                                                              | controller facts                           | os                                     |
| `server.ts`                                                                                                                                                                                              | to be narrowed to bootstrap during T27–T31 | fs, os                                 |

No directory such as `agents/**` or `shared/**` is ever allowlisted. Blob-store modules accept a blob ID, never a caller path.

**Baselines live in `scripts/runner-boundary-baseline.json`:**

| Ratchet | Counts                                                                                                       | Baseline                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **R1**  | Placement decoding and tests                                                                                 | **86** in the server at `f7897bf7e` (83 calls + 3 raw prefix tests)            |
| **R2**  | Controller access to agent-machine resources                                                                 | **94**, plus 12 allowlisted                                                    |
| **R3**  | Local-only API                                                                                               | **23** (16 extra runner methods, 2 side-channel types, 5 extra engine methods) |
| **R4**  | Operation × platform pairs, plus child lifecycle and upgrade scenarios, not yet passing on the real programs | set by T06                                                                     |
| **R5**  | Runner→Dispatch import edges and protocol leaks                                                              | set by T02. The edges and the 12 leaks named above are its first entries       |
| **R6**  | Web placement tests                                                                                          | **11** (6 calls, 3 prefix tests, 2 `runnerManaged`)                            |
| **R7**  | Rules that make a runner agent or user able to do less                                                       | **34** (Appendix D, part 2)                                                    |

The figures are from `f7897bf7e`. T02 re-takes them after the merge and records any difference.

Rules that stop the ratchet being gamed:

- Entries are `{file, kind, detail, count, task}`. The **set** may only shrink. Removing two old entries does not buy one new one.
- A stale entry fails, so an improvement is locked in by the same commit.
- Pre-commit compares with `HEAD`. CI walks every commit in `base..head` that touches the baseline. Comparing only with main would be useless on a long branch, because main has no baseline.
- The script fails on zero files scanned, and has a planted-violation self-test for every rule.
- R1 also counts the three existing wrappers (`agentWorkspaceDir`, `agentDiffPath`, `resolveLaunchLocation`) and `.remote` on live sessions as banned symbols with their own entries.

**The current 83 placement calls and three prefix tests burn down by task in section 5.** The per-task numbers were produced by assigning every hit to a task, not estimated.

**Catches:** nearly every way this branch acquired its forks.
**Cannot:** see host access inside a third-party library or an HTTP call to loopback (`stream-manager.ts` does the latter, so loopback `fetch` and `WebSocket` get a literal-address rule), or judge semantics.
**Cost:** 1 task, under a second per run.

### E3. Types · `pnpm run check`

- `AgentRecord.placement: Placement`, required. A negative type test asserts that `null` and omission fail.
- `Placement` and `RunnerPath` are opaque objects at the type level, not branded strings. Only `runners/` can construct or read a placement.
- `RunnerDescription` has no field that identifies local or remote.
- `displayPath(path)` is the only conversion to text. The scanner limits it to response serialisers and prompt builders.

**Catches:** null placement, passing a runner path to `fs` or `path`, branching on placement.
**Cannot:** survive a cast. The scanner bans `as RunnerPath`, `as Placement` and `as unknown as` on these types outside codecs. A type also cannot prove a path came from the same runner, so requests take targets and the session binding.
**Cost:** lands with T07, and the compile errors are the migration worklist.

### E4. One operation table · `pnpm run check`

- Client types, request and response validators, handler map, timeouts, retry rules and conformance coverage all derive from `operations`.
- A handler map that omits an operation fails to compile. An operation without a scenario fails the conformance coverage test.
- There is one handler map, so "a local method the protocol lacks" has nowhere to live.

**Catches:** side APIs, half-implemented operations.
**Cannot:** stop a wrong handler. That is E5.

### E5. Conformance · `pnpm run test` and CI

One scenario set on the two real programs, same normalised transcript:

| Lane   | Composition                                                             | Runs in                                                 |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| Local  | compiled `local-runner` child, launcher pipe, real socket, `posix-user` | `pnpm run test` on macOS. Also Linux, in CI's container |
| Remote | compiled binary, `linux-privsep`, real TLS, Docker                      | a required step in the `ci` job for non-docs PRs        |

- **No in-process composition exists.** Until a family moves, its temporary adapter is tested as a known divergence, with a task.
- Each operation has a success case, each declared error, a retry after a lost reply, cancellation and a restart between steps.
- Process scenarios: SIGKILL the child, SIGKILL the app, two apps on one root, version mismatch, freeze during work, abort and thaw, child down for longer than 25 seconds, app down during a turn.
- Old-host scenarios: real v1.7.28 and main host code with the fixture adapter.
- Security: path traversal where an API takes a relative path, symlink swap against root, supervisor private state, release with stale state, wrong nonce.
- Boundary values come from main's local limits, so a stricter validator fails.
- Normalisation replaces roots, PIDs, times and host names, and nothing else. There is no skip, and an unexpected pass fails until its entry is removed.

**Catches:** "same name, different behaviour", lifecycle bugs, privilege-separation regressions.
**Cannot:** test real engines, signed-app privacy prompts, systemd (L5 does both) or untested inputs.
**Cost:** 1 task, then a scenario per task. An estimated 4–7 CI minutes.

### E6. Non-Dispatch reference client · CI, both lanes

`packages/runner-conformance/reference-client.ts`, under 200 lines, importing only protocol and client: spawn a local runner or connect to a remote one, describe, prepare a directory, launch with no MCP, attach, prompt, read typed events, read a diff, put and get a file, disconnect, replay, stop, release. A second run uses a non-`agt_` handle, another environment namespace and another MCP name.

**Catches:** anything that only works if you are Dispatch. With a child, this client is also exactly how Dispatch uses local.
**Cannot:** prove every operation is pleasant to use.
**Cost:** inside T06. The existing consumer test uses a fake peer, so it does not prove this.

### E7. Local parity against main · CI, and locally per task

`scripts/runner-local-parity.mjs` builds `origin/main` at a pinned SHA and the head, starts each on an isolated database and state root with the fixture adapter, drives the same HTTP and MCP scenarios, and diffs normalised responses, stream rows, files and Git state. It includes a host started by main that the head attaches, drives, stops and archives; a protected update from main with idle and busy agents; an aborted update; and a rollback to main with a head-started host.

**Catches:** local regressions on the scenarios it drives. Its acceptance test is reproducing the seven in audit 4.3.
**Cannot:** see timing, real engines or UI pixels.
**Cost:** 1 task and an estimated 3–5 CI minutes. Intended changes need a named entry that cites an owner decision. The pinned SHA moves only in a main-merge commit.

### E8. Surface snapshot and vocabulary · `pnpm run check`

- `packages/runner-protocol/surface.json` is generated from the table and must be committed. After the first release an incompatible change fails unless the wire version changes.
- A test fails on Dispatch vocabulary (persona, review, owner review, task, board, Brain, chat, job, template, `DISPATCH_`, `.dispatch`, `agt_`) in protocol and runner identifiers and literals. Existing hits are R5 entries. Process and background "task" get narrow exceptions.

**Catches:** quiet protocol growth and product concepts arriving by name.
**Cannot:** catch a product concept with a neutral name. This is the one place judgement remains. E6 is the best test for it, and the snapshot diff makes it visible.

### E9. Caller parity · `pnpm run test` and CI

The same agent is created on the local child and on a remote runner. The test asserts:

- `tools/list` is identical: names, schemas, descriptions, on the agent and job routes, with and without a project
- a table of tool and route calls has the same accept or refuse result and message. It covers job and template create, update, list and run, `launch_agent` forms, `set_workspace`, post by path, `notify`, persona authoring, usage watches and repo tools
- a web component test finds the same actions enabled for both records
- a new tool without a row in the table fails.

Appendix D part 2 seeds R7. A call may differ only for a fact in 2.7.

**Catches:** "refuse for runner callers" and tools that vanish, which is the failure the owner corrected.
**Cannot:** judge a call nobody listed beyond its presence and schema.
**Cost:** inside T02 (the static list) and T06 (the runtime test), then a row per fix.

### Where each runs

|                | Pre-commit           | `check` | `test`        | CI only                     |
| -------------- | -------------------- | ------- | ------------- | --------------------------- |
| E1, E3, E4, E8 | yes, through `check` | yes     |               |                             |
| E2             | yes                  | yes     | self-test     | baseline history            |
| E5, E6         |                      |         | local lane    | remote lane, local on Linux |
| E7             |                      |         |               | yes, runnable locally       |
| E9             |                      |         | list coverage | both placements             |

None of it depends on the web-only ESLint setup or on a reviewer. ESLint can mirror E2 for editor feedback, but it is not the gate.

---

## 5. Migration plan

### 5.1 Fix now: P0–P7, then F2 and F3 (all landed)

F1 ("restore main exactly") became eight P slices. All landed; the oracle's known-regressions list is empty.

|     | Slice                                                                      | Status                                                     |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P0  | Intended entries: field-wide and feature consequence (D12)                 | **Landed** `237e84db5`                                     |
| P1  | Post, share and notify read the path as main                               | **Landed** `142343d7a`                                     |
| P2  | Metadata observation, main's worktree status and owner reviews             | **Landed** `3c91c0a9f`                                     |
| P3  | Checkout reads and Changes as main; wire limits only at the remote decoder | **Landed** `816e4ab62`, `9fd196ac2`                        |
| P4  | Repo tools and stop hooks run as `runCommand` did                          | **Landed** `731dddead`                                     |
| P5  | Persona catalog and tool texts as main                                     | **Landed** `7e4bc003f`                                     |
| P6  | Launch failure, base, icons, branch list                                   | **Landed** `c398ffbfb`                                     |
| P7  | Archive deletes what main deletes; main's dialog and diff error texts      | **Landed** `b4ea26382`, `03ce31d4b`                        |
| F2  | #2 sign-in changes the controller's account                                | **Done**, superseded by T28's one route taking a placement |
| F3  | #17 archive while offline leaves the host running                          | **Landed** `45325e933`                                     |

**F4 stays withdrawn.**

### 5.2 Rules for every task

- **No new behaviour.** A task may do three things only: what main does for local, the same on a runner, or what an owner decision says. Anything else goes back to the owner.
- **Local is main (D9).** Any behavioural difference a local user would see is restored to main, even where the branch looks safer. Direct consequences of the feature existing (its own migrations, fields it adds) are intended through P0's ledger shapes and need no question.
- **No restriction as a fix.** Never solve a gap by refusing, hiding, confining, capping or dropping a tool for runner callers. If the real fix is not ready, the gap stays a baseline entry.
- **Local proof:** E7 green, main's tests for the area unmodified and green, no new intended-difference entry except a P0 field or consequence entry under an existing decision.
- **Runner proof:** conformance on both lanes and E9 rows green. A real host only at milestone ends and with the owner's approval.
- **Ratchet:** the commit lowers one. Figures are `R1 / R2` after the task, from the `f7897bf7e` census, and T02 re-bases them. `N` numbers are restrictions in Appendix D.
- **A move and a change are separate commits.** Take main at each milestone and move the parity pin in that commit.
- Sizes: **S** under 400 changed lines, **M** 400–1,000, excluding pure moves.
- **Temporary adapters:** families still in the app until their task moves them into the child are R3 entries. Hosts move at T23, the last families at T33.

### M1. Lock it (serial)

**T01 · M · Take main, renumber migrations, keep its update fixes.** 86 / 94. **Done** (`c988476cf`, `b77bfa6fb`, `34b10cbe3`, `ade84050f`, `4c6094090`, `14ca07d44`)

- _Moves:_ merge main, branch migrations become 0053–0063, a documented reset for branch-migrated dev and trial databases.
- _Files:_ the conflicted files (29 in the first trial merge), `db/migrations/0052…0062`, `agents/acp/{host/main,host-client,host-protocol,runtime}.ts`, `update-recovery/**`, `server/update-recovery-runtime.ts`.
- _Local:_ acceptance, all required:
  1. A host given `shutdown {idleOnly: true}` during a turn stays alive and the turn completes. Idle, it exits. The parser and the branch's quiesced-shutdown case both preserve this.
  2. The app still has `stopIdleHostForRecovery` and uses it at the fence. It never falls back to a plain stop.
  3. Probation readiness quiesces idle surviving hosts and reports busy ones as `HOSTS_RUNNING`, as main does.
  4. The resume receipt merges within a transaction (`preserveTransactionAgents`, `stoppedForUpdate`). The branch's runner receipt schema coexists and the local receipt stays readable by main.
  5. Main's adapter capture, child-environment scrub on every spawn including the branch's new ones, and `catalogSource` learning survive.
  6. Main's tests for all five pass unmodified, plus main's client against the merged host and the merged client against v1.7.28 and main hosts.
  7. A main-schema database and a fresh one both migrate.
- _Runner:_ existing suites.
- _Risk:_ high. Resolving these conflicts in the branch's favour breaks upgrades with running agents. Check that no production database ran the branch's numbers before renaming.
- _Ratchet:_ none exists yet. This is the only task without one.

**T02 · M · Boundary and restriction gates.** 86 / 87, R7 set to 34. **Done** (`f3d9468cd`)

- _Moves:_ E2, the E9 static list, package tsconfigs, root check, baselines. Delete two modules with no importer (`personas/coverage.ts`, `shared/lib/clipboard-write.ts`).
- _Files:_ `scripts/check-runner-boundary.mjs`, baseline, `package.json`, packages, `.github/workflows/ci.yml`.
- _Local:_ no runtime change. _Runner:_ none.
- _Risk:_ false positives. The prototype's hit list is the starting baseline.

**T03 · M · Local parity oracle.** 86 / 87, parity regressions baseline set then 0. **Done** (`912320f2a`, `e40a792a8`). Its known-regressions list was burned to 0 by P0–P7 (5.1)

- _Moves:_ E7: upgrade with live hosts, protected update, abort, rollback.
- _Files:_ `scripts/runner-local-parity.mjs`, scenarios, CI.
- _Local:_ it must reproduce audit 4.3 on the pre-F1 commit, then pass after F1. _Runner:_ none.
- _Risk:_ normalising away a real difference. Keep the substitution list closed.

**T04 · M · The contract.** 86 / 87, R5 falls. **Done in a reduced scope** (`5b1b5c809`, `653e16915`, `c545c09ef`)

- _Landed:_ schema language, errors, opaque types, `RunnerDescription`, the 66-operation table, `Runner`/`Runners`/`RunnerHandlers`, surface snapshot and vocabulary test (`packages/runner-protocol/src/contract/**`), and the wire v1 codec (`packages/runner-client/src/v1/codec.ts`: 51 operations mapped, 15 in `NOT_ON_V1`).
- _Split out:_ host messages and events → **T04b**. Launcher schema → **L1**. Framing (`connection.ts`, `node.ts`) → **T05**, because the import gate allows `runner-client` only from `runners/local.ts` and `runners/enrolled/**`.
- **Corrections before T06** (each would be incompatible after it; landed):
  - **C1:** `workspace.release` is `{session, deleteBranch, originalBranch}` → `{removed}`, `retry: read`. v1's `expectedState` rides in codec `extras` until T20.
  - **C2:** `worktree.location` is `"sibling" | {nested: dir}`.
  - **C3:** `session.launch` deadline class is `default`.

**T04b · M · Host messages and events.** Split from T04

- _Status (r4):_ **Done.**
- _Moves:_ type the `session.attach` channel: `clientMessage` and `hostMessage` from `runner-protocol/src/session.ts` plus the extensions in `acp/host-protocol.ts:75-170`; `hostEvent` and `journalEntry` from `DriverEvent` (`acp/driver.ts`) with no `agentId`; `source` and ACP payloads opaque `json`; `welcome.replay_complete` optional. Schema only.
- _Files:_ `contract/{host,events,operations,index}.ts`, `runner-client/src/v1/host.ts`.
- _Local:_ no caller change; existing host fixtures round-trip. _Runner:_ same frames through the codec.
- _Order:_ not needed by T05; **before T06** (attach and alive scenarios). About 400 source + 300 test lines.
- _Risk:_ low. Typing from the TS types, not the tables.

**T05 · M · `Runners`, two adapters, first operation.** 83 / 85, R3 falls

- _Status (r4):_ **Done.**
- _Moves:_ `runners/{local,directory,controller-machine}`, a single temporary local adapter, `checkout.exec` through the interface.
- _Files:_ `agents/{manager,checkout-commands,local-runner}.ts`, `acp/runtime.ts:425`, `server.ts`, `runners/local.ts`, `runners/enrolled/**`, and `RunnerConnection`/`wireFrames` moved from `runner-protocol/src/{connection,node}.ts` to `runner-client/src/v1/`.
- _Forced by the built contract:_
  - Deadlines: `runner-client` maps `default` 20 s, `long` 300 s, `request` = `timeoutMs` + 5 s. On v1 the deadline is exactly `runnerReplyTimeoutMs(encodedFrame)`, never the class.
  - `extras.workspace` until T40: per session from the agent's stored `runner://` locator; runner-wide commands use the registration's workspace from `ready`. `extras.agentId` is the session handle.
  - `runner.describe` on v1 is derived from `ready` plus the registry, not a wire call.
  - Release (C1): the enrolled adapter fills `extras.expectedState` from its last observation until T20.
- _Local:_ repo tool and stop-hook transcripts. _Runner:_ the same, by scenario.
- _Risk:_ medium. The local adapter is in-app only until each family moves to the child. It may only delegate. Each is a baseline entry.

**T06 · M · Conformance, caller parity, reference client.** 83 / 85, R4 set and then falls for exec, attach, alive

- _Status (r4):_ **Done** (with T06b sessions on the remote lane, T06c runtime caller parity).
- _Moves:_ E5, E6, the E9 runtime test, the Docker lane. Child scenarios start as red baseline entries.
- _Files:_ `packages/runner-conformance/**`, CI, reuse of `e2e/remote-runner/setup.mjs` and the fixture adapter.
- _Local:_ none. _Runner:_ the remote lane launches for real. The local lane and reference client go green as L1, L2 and each family land.
- _Forced by the built contract:_ every response and event is validated against the contract schemas. On the remote lane the 15 `NOT_ON_V1` operations are imported from the codec as red baseline entries, not skips, until the native wire lands. Attach and alive scenarios start after T04b. Release cases use C1's shape.
- _Risk:_ CI time and Docker flakiness. No skips.

### M2. The model and the process (serial)

**T07 · M · Placement on every agent.** 69 / 85

- _Status (r4):_ **Done.**
- _Moves:_ one `runner_id` column (no workspace, D7), required type, one decoder, update, hold and force routing by equality. The record's new `placement` field is intended under the owner's 2026-11-22 approval: add a P0 field entry, no question.
- _Files:_ migration, `packages/shared/src/agent-record.ts`, `manager.ts` (8 hold and update sites), `server.ts`, `remote/force-sessions.ts`, `registry.ts` SQL.
- _Local:_ upgrade, downgrade to main, upgrade again. _Runner:_ held and forced update tests.
- _Risk:_ high blast radius. No behaviour change in this task.

**T08 · M · A runner on jobs, templates and triggers.** 58 / 83. Closes #16 except loop memory

- _Status (r4):_ **Done** for jobs and templates; triggers resolve through their template. A trigger's own location is left (in T38).
- _Moves:_ they store a `Location`: `{runner, path}` on the controller's runner, `{runner, projectId}` on any other runner (D7). The tools and routes gain an optional `runner`, the same for every caller.
  - **Accepted inputs do not narrow.** Every input accepted from a local agent is accepted from a runner agent: any path, `~`, a project, a folder, a legacy locator. There is no new existence, reachability or same-machine check at save. Saving with the target runner offline works unless the save names a persona that must be read there, which is the one read local saving does today. A folder resolves on the controller's runner; a saved target on another runner is its project (D7). A runner agent with no `directory` saves its own session's project.
  - **Defaults are symmetrical (confirmed by the owner):** no `runner` means the creator's machine, as no `directory` already means the caller's directory. For a local caller nothing changes. A runner agent names the controller's runner to target it.
  - The existing "project supplies the directory" rule and the project-template directory rule apply by `sameRunner` and not by "is remote".
  - Persona validation keeps `f7897bf7e`'s lookup and generalises it to the target location in T35.
  - Existing rows keep their current meaning: locators become that runner, paths stay on the controller's runner. No stored row is reinterpreted.
- _Files:_ `jobs/{service,store}.ts`, `templates/{service,store}.ts`, `tasks/service.ts:644`, `shared/mcp/crud-tools.ts`, `routes/mcp.ts` CRUD callbacks.
- _Local:_ main's create, update, list, get-by-name and run results. Every existing row round-trips. _Runner:_ the E9 accept set is equal. A job created with defaults runs in that checkout.
- _Risk:_ existing schedules moving machine. Migrate only the encoding.

**L1 · M · Local runner child and supervision.** 58 / 83, R4 falls

- _Status (r4):_ **Done.**
- _Moves:_ package skeleton, `local-runner` subcommand, `start`/`ready`, exact build handshake, lifeline, lock, backoff restart, scrubbed environment. It serves describe and health.
- _Launcher schema (moved from T04):_ `start`/`ready`, EOF lifeline, `freeze`/`thaw`, `import`, typed from the code L1 writes in `runner-client/src/launcher/schema.ts` and covered by the E8 snapshot.
- _Files:_ `packages/runner/src/{cli,local}`, `packages/runner-client/src/launcher`, `runners/local.ts`, `main.ts`, `server.ts` start and shutdown.
- _Local:_ no family moves yet. Dev watch restart leaves no orphan. _Runner:_ SIGKILL either side, two apps on one root, mismatch, leftover child.
- _Risk:_ high. The child outlives the app on both service managers unless the lifeline works. The macOS lock primitive is unproved.

**T10 · M · Byte streams with flow control.** 58 / 83, R4 falls. Before the socket carries anything

- _Status (r4):_ **Done.**
- _Moves:_ credit window in client and runner, chunked blobs.
- _Files:_ `runner-client` framing, the child, `remote/runner.ts`, `remote/service.ts`.
- _Local:_ describe and health only. _Runner:_ 100 MiB under a slow reader while attach stays live.
- _Risk:_ high, since every channel uses it.

**L2 · M · Local socket and reconnect rules.** 58 / 83, R4 falls

- _Status (r4):_ **Done.**
- _Moves:_ socket transport with nonce, channel framing, blob frame, retry-while-unavailable, the main-era host client mode (1.4), no connect-probing, one connection per host.
- _Files:_ `runner-client/{transport,session}`, `runner/local`, `agents/acp/host-client.ts`, `host/main.ts` (advertise replay), runtime unavailable path.
- _Local:_ v1.7.28 and main hosts attach, drive and replay. A child down for over 25 seconds records no exit and loses no queue. _Runner:_ the negotiated rules replace the remote-only mode.
- _Risk:_ high. A wrong readiness rule silently stops delivery. A second connection evicts.

**L3 · M · Updater fence and probation cover the child.** 58 / 83, R4 falls

- _Status (r4):_ **Done.**
- _Moves:_ `freeze`/`thaw`, unavailable defers, boundary from the frozen child, frozen probation start, abort.
- _Files:_ `update-recovery/maintenance.ts`, `server/update-recovery-runtime.ts`, `runners/local.ts`, runner admission, reconciler start order.
- _Local:_ main's recovery tests and E7's update scenarios: busy defers, idle stops and resumes with the same ID. No byte changes in backed-up paths between fence and exit. _Runner:_ remote fencing unchanged.
- _Contract (T04 #7):_ add optional `retained` to `session.list` entries only if update drain needs it.
- _Risk:_ high. A false empty host list would back up under a live writer. An unknown answer always defers.

**L4 · S · One-time binding import.** 58 / 83, R3 falls

- _Status (r4):_ **Done.**
- _Moves:_ `import` on the launcher pipe, replacing the first version's in-process legacy hook.
- _Files:_ `runners/local.ts`, an agent-row query, runner bindings.
- _Local:_ main-created worktree, plain folder, moved workspace, deleted directory, changed branch, pending archive, rollback then upgrade. _Runner:_ not reachable over socket or TLS.
- _Risk:_ high, data loss if ownership is inferred wrongly. Unknown means external.

**T09 · M · Workload port, first family in the child: checkout reads.** 53 / 75, N13 closed. **Smaller after P2–P3:** local reads, Changes, observation and status already match main with no caps. T09 is now a move plus deleting the remote-only validators P3 parked at the remote decoder (N13 anchors).

- _Status (r4):_ **Done.** N13 still has anchors (see T09c and the carry-overs in 0.4).
- _Moves:_ `Platform.workload`, one worker entry, views, inspect and watch.
- _Files:_ `checkout-{runner,view,inspection,watch,observers}.ts`, three CLI subcommands, response and diff-stat routes.
- _Local:_ Files, Changes and owner-review transcripts, large-diff timing. _Runner:_ same scenarios as workload UID.
- _Contract (T04 #19):_ the runner honours the caller's `exclude[]` in `checkout.stats`/`checkout.diff` and stops applying its own test rule.
- _Risk:_ medium. Watcher counts, socket cost of large diffs. No caps or stricter path rules than main.

### M3. Files and paths (serial, then useful on its own)

**T09c · S · The rest of checkout reads in the child.** Carry-over from T09. Lane A

- _Status (r4):_ **Done** (`a3dbb7498`). Capable peers stream image and default files; the watch still rides v1's `watchCheckout` channel, so N13's watch limit stays (carry-over).
- _Moves:_ `checkout.image`, `checkout.defaultFiles` and `checkout.watch` through the workload port, as T09 did for the other reads.
- _Local:_ image diff, default files and the Files pane's live refresh. _Runner:_ the same.

**T11 · S · One `files.get`.** 51 / 72. Closes #5 properly, #6, #7, N10. **Smaller after P1:** local already reads the path as main. What is left is the runner side: delete the supervisor's roots, exclusion, link and 20 MiB bounds (N10) and route both through one operation.

- _Status (r4):_ **Done.**
- _Moves:_ post, share and notify use one operation under D4: no roots, other-session exclusion, hard-link or symlink refusal, or size cap. Slack's own 5 MB stays.
- _Files:_ `local-runner.ts:221-261`, `session-supervisor.ts` sessionFile, `manager.ts:935-968`, `mcp-handlers.ts`, `slack-images.ts`.
- _Local:_ child file, task attachment, hard link, 21 MiB, symlink, as on main. _Runner:_ the same list, plus `/tmp`. Only what the OS denies the account fails.
- _Risk:_ security. Read as the workload, never root.

**T12 · M · One `files.put`, real paths in prompts.** 47 / 71. Closes #24, #25, N11, N20, N21

- _Status (r4):_ **Done.**
- _Moves:_ blob resolver, main's file-name rules, initial files, prompt files, steering rule.
- _Files:_ `manager.ts:971-1025,2620-2680`, `chat/service.ts:5336`, `acp/runtime.ts:1069`.
- _Local:_ path text byte-identical, no copy, missing-file warning kept. _Runner:_ Read tool opens the path, text attachment steers.
- _Risk:_ a missing file fails differently. Use main's warn-and-continue for both.

**T13 · M · Fetchable references.** 47 / 71, R4 falls. Closes #3, #4

- _Status (r4):_ **Done in part** (`cbf373f34`): `list_files` and family reads deliver references to the requesting session. Task briefings and task attachments did not move (→ T13b).
- _Moves:_ `list_files`, family reads, task briefings and attachments call put before emitting a path.
- _Files:_ `server/mcp-handlers.ts:910-921`, `tasks/service.ts:230-238,1622-1627`, split attachment store.
- _Local:_ same paths. _Runner:_ parent reads child's report, builder opens a task image.
- _Risk:_ cost of copying. Every listed path must open. Reuse by digest. Add no limit beyond main's 100-row listing.

### M4. Checkouts (T14–T17 and T21 can run in parallel)

**T13b · S · Task briefings and attachments.** Carry-over from T13. Lane C

- _Moves:_ task briefings and task attachments put a file on the agent's runner before emitting its path, as `list_files` and family reads already do (`cbf373f34`). Deletes R3 `collectSessionFile` and `deliverSessionFile`.
- _Files:_ `tasks/service.ts` (`buildTaskBriefing`), the task attachment store, `files/session-file.ts`.
- _Local:_ same paths and bytes as main. _Runner:_ a builder opens a task image.
- _Risk:_ copy cost. Reuse by digest. No limit beyond main's.

**T14 · S · Commands complete, delete `repo`.** 44 / 69. Closes #28, N14, N15. **Smaller after P4:** the local executor already runs as `runCommand` did. Left: the runner's caps and gate (N14, N15), the request shape, and deleting `repo`

- _Status (r4):_ **Done** with T14b. The legacy `repo` variant and N14's legacy-peer anchors stay until T40.
- _Moves:_ limits and manifest path into the request, remove `repo_runner_workspace`, the 32-command cap and the runner-only execution gate. A runner agent's tools run on the same rule as local's.
- _Files:_ `checkout-command*`, `mcp-checkout.ts`, `shared/mcp/{repo-tools,server}.ts`, `agents/remote/runner.ts:1139`, `agents/remote/service.ts:520`.
- _Local:_ no timeout or truncation unless main had one, direct spawn. _Runner:_ same.
- _Contract (T04 #21):_ `timeoutMs`, `maxOutput`, `shell` and `env` on `checkout.exec` stop being v1-implied.
- _Risk:_ login versus direct shell changes runner PATH. The workload base environment must supply the login PATH.

**T15 · M · Git context.** 40 / 63. Closes #8, #33, #34, N22, N31. P6 restores main's icon 404 for local, so T15 only routes the probe

- _Status (r4):_ **Done.** Icons split off (→ T15b).
- _Moves:_ turn and start refresh, icon, stream relativisation use `git.context` and bindings.
- _Files:_ `manager.ts:1346,1608-1663`, `workspace-target.ts:49-55`, crud and project icon routes, `directory-icon-cache.ts`.
- _Local:_ same writes and cadence. _Runner:_ branch switch shows after a turn.
- _Risk:_ an RPC per turn. Best effort, stale on failure, as today.

**T15b · S · Repository icons.** Carry-over from T15. Lane C

- _Status (r4):_ **Done for the agent route** (`bcaca7143`, `01d232a45`, `a47fa2895`): icons read through `checkout.list`/`checkout.read` on the agent's runner, main's 404 and 400 kept. The project icon route and the create-time warm-up still read the controller's disk (→ T15c).
- _Moves:_ the icon probe through the runner, keeping P6's main-era 404 for local.

**T15c · S · Project icons through the runner.** Carry-over from T15b. Lane C

- _Moves:_ the project icon route and the create-time warm-up (`getDirectoryIconPath` callers in `agents/manager.ts` and `routes/agents/crud-routes.ts`; the warm-up is skipped today when a runner engine is used) read through `checkout.list`/`checkout.read` on the project's runner, as the agent route does.
- _Local:_ main's cache, 404 and 400. _Runner:_ a repository-only project shows its icon.
- _Risk:_ low. Delete the runner-engine skip; do not add a new one.

**T16 · M · Select and base.** 36 / 58. Closes #29, N9

- _Status (r4):_ **Done** (`50674a45a`). Remote default branch and `git.branches`/`git.base` landed with T19c.
- _Moves:_ one `set_workspace`, one base policy in Dispatch, resolution in the runner. Any directory the account can use, on every runner, as main (owner decision: the agent choosing its own folder is not a user-named folder, and runner agents' tools are not restricted). Dispatch records the new path as the agent's `cwd`. The workspace confinement and runner-storage disjointness code is deleted, not generalised.
- _Files:_ `manager.ts:1695-1830`, `effective-base.ts`, `workspace-target.ts`.
- _Local:_ main's base matrix (moved, same repository, no base). _Runner:_ the same matrix.
- _Risk:_ owner reviews compare against another branch. Table tests first.

**T17 · M · Projects record their repository (D7, D8).** 35 / 55. Closes the server half of #20 and N28

- _Status (r4):_ **Done.**
- _Moves:_
  - **Schema, in one migration:**
    - `projects.repository text` (nullable), with a unique index on it.
    - `repo_root` becomes nullable, for a repository-only project.
    - `projects.extra_roots text[] NOT NULL DEFAULT '{}'`.
  - **Create route:**
    - A folder, as main. `resolveProjectRoot` is unchanged, and `repository` is filled from the folder's origin.
    - Or a repository alone, for use on runners.
    - A second project for a recorded repository gets 409 "This repository already has a project.", the same shape as main's "This folder already has a project."
  - **Repository identity:**
    - `remote.origin.url` only, through the existing `inferRepositoryUrl` and `repositoryUrl` rules: SSH becomes HTTPS, credentials are stripped, the host is lowercased. A trailing `.git` and `/` are also stripped.
    - A fork is its own repository, and other remotes are ignored.
    - No origin, a non-HTTPS origin, or more than one origin URL means no repository, so the project stays local only, as main.
    - The value is stored at create time and never rewritten silently.
  - **Matching:** `matchingProjects` checks `repo_root` and every `extra_roots` entry. With one root it is byte-for-byte main's.
  - **One-time merge, as a startup step after migrations** (SQL cannot read Git config):
    - For each project with `repository` null, read the origin.
    - If no other project has that repository, set it.
    - If one does, merge into the oldest by `created_at`, in one transaction.
    - Offline or origin-less folders stay null and are retried at the next start.
    - **Plain re-point:** `agents`, `templates` (jobs follow their backing template), `tasks` and `message_shares` (no foreign key).
    - **Not a blind update:**
      - `task_columns` (unique on project and key): a loser column whose key the winner has is dropped, and its tasks move into the winner's column. Other columns are appended with their triggers.
      - `task_labels` (unique by name): match by name, re-point assignments, drop the duplicate.
      - `task_board_watches` (unique on project and agent): delete the loser's row when it collides.
    - The loser's `repo_root` is appended to the winner's `extra_roots`. Both folders stay working local checkouts of one project, and the "Multiple projects match" 409 disappears for them.
    - Brain keys are untouched, since they are per folder.
    - The loser project is deleted.
  - **Branches:**
    - `{path}` on the controller's runner, as main (P6 restores no `defaultBranch`).
    - `{repository}` for a project on another runner, through that runner's `git.branches`.
  - `path-info` and completion stay controller-machine probes (D7).
- _Files:_
  - the migration
  - `projects/{store,matching}.ts` and a new `projects/repository-backfill.ts`
  - `routes/projects.ts` (the branch-only `/:id/repository` route becomes a reader of the stored value)
  - `routes/system.ts` (branches)
  - the startup hook in `server.ts`
- _Local:_
  - A user with no duplicates sees nothing change. The cost is one `git config` read per project, once.
  - Existing projects, icons and matching are unchanged.
  - Duplicates merge with the losses listed below.
  - **One change from main, by D8:** creating a project for a second clone of an already-recorded repository is refused.
- _Runner:_ a project created from a repository URL. A runner launch names it (T25).
- _Lost in a merge:_
  - the loser's name, colour and icon
  - the settings (name, trigger, capacity, done flag) of a column whose key collides
  - its duplicate label colours
  - duplicate board watches
- _Contract (T04 #23):_ add optional `origin: nullable(string)` to `gitContext` (so on `path.resolve` and `git.context`). The runner reports `remote.origin.url` raw; Dispatch normalises it. Additive, compatible after T06.
- _Risk:_ a data change, done once. Size about 15 SQL + 70 TS for the backfill and merge + 10 matching + 80 tests. Test the merge against fixtures only, and never against a production database.

**T18 · M · Prepare from a directory.** 34 / 50. Closes N6

- _Status (r4):_ **Done.**
- _Moves:_ bind, prepare, resume, copy list, dependencies and intent helpers to core on both platforms. A user's folder reaches only the controller's runner (D7). On any runner, an independent worktree of an agent's own folder uses this source with the session's current path (its checkout or a folder it moved into) and needs no origin.
- _Files:_ `workspace*.ts`, `checkout-intent.ts`, `manager.ts:2170,2557,3196`, launch progress.
- _Local:_ receipts from this branch, worktrees from main, nested location, resume after a crash. _Runner:_ an independent worktree of the agent's own checkout, with tags. The copy list runs as on local; a runner-made clone usually has nothing ignored to copy.
- _Risk:_ high, it creates and reuses real worktrees.

**T19 · M · Prepare from a repository.** 34 / 50, R4 falls. Closes #10 with T18, N12.

- _Status (r4):_ **Done** (core). Served remotely by T19b. N12 (Git hardening on the runner) still anchored: carry-over.
- _Moves:_ cache, plans and journal from `session-storage.ts` into the same core. This is the source for every new checkout on a runner other than the controller's (D7). The cache is keyed by the normalised repository (D8's identity). N5 closes because the workspace check is deleted. The account's own Git config, transports and hooks. Main's branch rules. Tags on.
- _Files:_ `remote/{session-storage,repository}.ts`.
- _Local:_ not exposed in UI. _Runner:_ every checkout kind, resumed plan, `git describe`.
- _Risk:_ credentials. Git always runs as the workload and never as root, and URLs are stored without credentials.

**T19b · M · The runner serves `workspace.prepare`.** Split from T19. Lane A

- _Status (r4):_ **Done** (`b1d6b4738`, `e26609be5`). The binding adapter (`platform/linux-privsep/bindings.ts`) is still the store (→ T23b).
- _Location comes from the platform._ `RepositoryPort` gains `location(session)` and `remove(session)`. On linux-privsep, `location` creates or repairs `sessions/<key>` (supervisor uid, workload gid, 0751) and an empty workload-owned `checkout`, and returns `sessions/<key>/checkout`, which is today's path, so running agents' `cwd` does not move. `remove` keeps `discardManagedCheckout`'s order: the checkout as the workload, then the protected parent. posix-user keeps the core's sibling layout. The core never creates or removes anything under `sessions/` and writes its receipt where the platform says.
- **Invariant, enforced in `packages/runner/src/platform/linux-privsep/`:** every path the supervisor touches as root (rm/rmdir, chown/chmod, state writes, the `realpath` check before handing a path to a host) is reached only through directories the workload cannot write. Every ancestor from `<state>` to `sessions/<key>` passes `checkoutParentIsProtected`; bindings, receipts and plans are in a root-only 0700 directory. The clone cache may be workload-owned, because Git runs only as the workload.
- _Bindings use an adapter until T23._ linux-privsep implements the core's `Pick<BindingStore, "get" | "origin" | "bindPrepared" | "select">` over the supervisor's existing files (`bindings/<key>`, `.repository`, `.cwd`, `.selected`, `.borrowed`). There is no data migration, so old and new builds read the same files and probation rollback and live hosts are untouched. Sessions with an existing `<key>.repository` or legacy plan finish on the legacy path; only new sessions use the core.
- _Wire:_ served behind a `ready` capability flag. The legacy launch-embedded prepare stays byte-identical for old peers.
- _Files:_ `packages/runner/src/{core/workspace,platform/**}`, `session-supervisor.ts`, `session-storage.ts`, `agents/remote/runner.ts`, `runner-client/src/v1/**`.
- _Local:_ none. _Runner:_ every checkout kind, a resumed legacy plan across the update, rollback during probation, the symlink-swap tests kept.
- _Risk:_ high, privilege boundary. About 700 lines including tests.

**T19c · M · Launch by project on any runner.** Split from T19. Closes N5, N6. Lane B, after T19b

- _Status (r4):_ **Done** (`1e05a1247`, `84e2a6278`; migration 0067 `runner_preparation`).
- _Moves:_ a launch on a non-controller runner names its project and sends `{repository}` (D7, T25's admission rule). Delete the workspace check (N5). An independent worktree of the session's own folder is `{directory}` with the session's current path and needs no origin (N6). T16's leftover remote default-branch leg and remote `git.branches`/`git.base` (needed by the branch picker) land here.
- _Files:_ `manager.ts` launch phase, `launch-admission.ts`, `routes/{projects,system}.ts`.
- _Local:_ unchanged. _Runner:_ launch by project, branch list, own-folder worktree.
- _Risk:_ medium. About 400 lines.

**T20 · M · Release and archive.** 29 / 50. Closes #17, #32 branch deletion, N35. Lane A, directly after T19b (it shares the supervisor and the binding adapter); kept separate for its data-loss review

- _Status (r4):_ **Done** (local `039d51284`; remote as T20b `abf46530a`). N35's anchor remains only in the legacy `checkoutRelease` wire handler and goes with v1 (T40).
- _Moves:_
  - **The decision is Dispatch's, and it is main's (made local by P7):**
    - Main's co-owner query is checked first in every mode.
    - `keep` removes nothing. `force` removes. `auto` removes when status is clean, where a failed status, an unknown base and net-empty history all count as clean.
  - **`workspace.release {session, deleteBranch, originalBranch}` → `{removed}` (contract set by T04's C1) only executes main's removal:**
    - `git worktree remove --force`.
    - `git branch -D` on the checkout's current branch when Dispatch owns the branch.
    - `-d` on the original branch only if it is 0 ahead of its upstream.
  - There is no `expectedState` (the codec `extras` entry is deleted here), no state recheck and no `inUse`. The runner's recheck and borrower deferral (N35) are deleted, and so is the runner's own `releaseFile` "retained" receipt for that case.
  - **Offline:** release stays `pending` and is retried on reconnect (F3), the same mechanism as D10.
  - Bindings and ownership come from L4. Unknown means external, and an external checkout is never removed.
  - `archive_checkout_state` and the route's `checkoutState` query are deleted. The column stays unused; migrations are immutable.
- _Files:_ `archive{,-policy,-checkout}.ts`, `local-runner-checkout.ts`, the supervisor's `releaseCheckout`, `packages/runner-protocol/src/checkout.ts`, `routes/agents/crud-routes.ts`.
- _Local:_ P7's oracle cases stay green with no new entry: main-created agent, dirty, co-owner, cascade, switched branch, base gone, status fails, stale force.
- _Runner:_ the same matrix, plus offline pending.
- _Risk:_ **highest, data loss.** It removes exactly what main removes and nothing else. The only added safety is L4's "unknown ownership is external".

**T21 · S · Terminal.** 27 / 49. Closes N16

- _Status (r4):_ **Done** with T21b. N16 remains only for legacy uncredited peers (T40).
- _Moves:_ both PTY paths to one handler. Main's limits only.
- _Files:_ `terminal/{manager,remote,runner-worker}.ts`, `local-runner.ts:185`.
- _Local:_ resize, detach, reap. _Runner:_ same, plus update close reason.
- _Risk:_ orphaned shells.

### M5. One session program (serial)

**T22 · M · Extract a generic host.** 27 / 49, R5 falls

- _Status (r4):_ **Done** (`eeb097f6c` goldens, `394a0e60e`, `6f0316dc8`). Some host files still import Dispatch (→ T22b).
- _Moves:_ host, driver, client, protocol extensions. Remove persona, PromptSource and TLS imports.
- _Files:_ `agents/acp/**`, `main.ts` subcommand.
- _Local:_ argv, files, system and first prompt bytes identical, main host to head client and main client to head host, `idleOnly` included. _Runner:_ reference client reads typed events.
- _Risk:_ high for live hosts. Move first, change second.

**T23 · M · One session core, hosts move into the child.** 27 / 49, R3 and R4 fall

- _Status (r4):_ **Done** (`a105b5d85` linux-privsep core; T23c `b192de08d`, `0e9f6a1fa` read side; T23d `c0f314498`: the local child is the only spawner and stopper of local hosts). The binding store was not unified (→ T23b).
- _Moves:_ launch records, attach, alive, stop, discard, logs. Platform process and layout ports. The child becomes the spawner and cleans descendants of exited hosts after its own restart.
- _Files:_ `local-runner.ts`, `session-supervisor.ts`, `session-processes.ts`.
- _Local:_ live main host, stale PID, NFC path, kill grace. _Runner:_ pidfd, socket swap, restart, launch reconcile.
- _Risk:_ **highest with T20.** Land as two commits, `linux-privsep` first.

**T22b · S · The host imports nothing from Dispatch.** Carry-over from T22. Lane B

- _Moves:_ the four remaining R5 "runner to Dispatch" imports in `acp/driver.ts`, `acp/host-env.ts` (3), `acp/host/main.ts` and `acp/opencode-instructions.ts` become inputs, as T22 did for persona, source and TLS.
- _Local:_ T22's host goldens unchanged. _Runner:_ the reference client still drives the host.
- _Risk:_ live hosts. Move first, change second.

**T23b · M · One binding store.** Carry-over from T19b/T23. Lane A

- _Moves:_ the linux-privsep adapter over `bindings/<key>`, `.repository`, `.cwd`, `.selected-cwd`, `.borrowed-cwd` is replaced by the core's store, with an L4-style one-time import that leaves the old files readable until T40 (probation rollback must still find them). Sessions an older build prepared finish on their path. Deletes R3 `bindWorkspace`, `checkoutRelease`, `requestedWorktree`, `resolveLaunchDirectory` and `runners/local.ts`'s in-process checkout reads.
- _Files:_ `packages/runner/src/{core/workspace,local/bindings,platform/linux-privsep/bindings}.ts`, `session-supervisor.ts`, `session-storage.ts`, `local-runner.ts`, `runners/local.ts`.
- _Local:_ L4's import cases, archive and select unchanged. _Runner:_ rollback during probation reads the same session; the symlink-swap tests kept.
- _Risk:_ high, privilege boundary and rollback. Keep the invariant in T19b.

**T24 · M · One launch environment.** 26 / 48. Closes #1 residual, #11, #30, half of N27

- _Status (r4):_ **Done** (`a7b4e6af6`; PATH golden strengthened in `10813fa11`). Three R5 entries tagged T24 remain (`DISPATCH_` in `acp/host-command.ts` and the supervisor, `personaContext` in `execution.ts`), and the remote conformance `session.launch/environment` stays red because v1 drops caller environment values.
- _Moves:_ env bindings, runner-owned bins and prefixes, overflow text, same relaunch retention, helper commands on PATH.
- _Files:_ `launch-env.ts`, `host-env.ts`, `persona-context.ts`, `manager.ts:2958-3000`, supervisor launch.
- _Local:_ environment and PATH golden per engine. _Runner:_ files and journal survive restart, 1 MiB first text.
- _Risk:_ MCP trust per CLI, not verified on a runner.

**T25 · M · One create path.** 23 / 44. Closes #14 at launch, N3, N7

- _Status (r4):_ **Done** (`ed9632610`, `bdc14a9bf`). **Order changed from this text:** create is intent → insert → prepare → launch (durable intent, so a restart can prove no host launch was sent), not resolve → admit → prepare → insert. A child's source is `{session}`.
- _Moves:_ resolve → admit → prepare → insert, for every placement. Local project match stays path-only, as main, across a project's roots (D8). A launch on another runner names its project; there is no origin search. Dispatch's admission never sends a folder to a non-controller runner: the only path such a launch carries is the parent's current folder (its checkout or a folder it moved itself into), through `{session}` (D7). Jobs, projects, parents, worktrees and personas are accepted on every runner. P6 already restored main's launch failure and base, so those cases are no longer in this task.
- _Files:_ `manager.ts:1917-2260,2419`, `launch-admission.ts` manager phase, `projects/matching.ts`, crud route.
- _Local:_ main's create matrix, errors and phase order. _Runner:_ same matrix by source.
- _Risk:_ high. Insert-before-prepare crash recovery must hold.

**T26 · M · One lifecycle.** 22 / 43. Closes #31, N33

- _Status (r4):_ **Done** (`0488474f9`; migration 0068 `pending_agent_stops`): one lifecycle; a stop while the runner is unreachable is recorded and retried, scoped to the launch id (D10).
- _Moves:_ remove runtime placement branches: failure, stop, shutdown, unavailable, holds, remote-only prompts file.
- _Files:_ `acp/runtime.ts` (about 26 conditions), `manager.ts:3717`, reconciler.
- _Local:_ stop, failure tail, recovery transcripts. _Runner:_ offline stop converges after reconnect. **Approved (D10):** a stop while the runner is unreachable is recorded and retried on reconnect; it never fails the stop.
- _Risk:_ high, the prompt pump. Do not touch queue semantics.

**T27 · M · Inventory, sweep, resources.** 21 / 40. Closes #17 sweep, #23, #32 quiesce

- _Status (r4):_ **Done** (`18646ab60`): `session.list`, `session.sample` and the orphan sweep through runners.
- _Moves:_ `session.list` and `session.sample`.
- _Files:_ `reconciler.ts`, `acp/runtime.ts:1870`, `service-resources.ts`, `update-recovery-runtime.ts`, `server.ts:620`.
- _Local:_ same list and numbers. _Runner:_ non-zero CPU, stray host swept.
- _Risk:_ killing a wanted host. Sweep only this owner's sessions with a known ended row, never an unknown one.

**L5 · S · Signed-Mac and systemd validation.** 21 / 40, R4 falls

- _Status (r4):_ **Left.** Needs the owner's approval for a signed build and a machine or VM.
- _Moves:_ nothing. A scripted acceptance run and a written result, after hosts move to the child.
- _Files:_ `docs/vm-release-validation.md`, a smoke script, installer tests.
- _Local:_ signed build with folder privacy prompts, Keychain usage and sign-in, Stop Server, Quit, crash, a Sparkle update from the current release with busy and idle agents. systemd: restart, SIGKILL, protected update. No orphan child, hosts survive. _Runner:_ not applicable.
- _Risk:_ it needs the owner's approval for a signed build and a machine or VM. The same-identity assumption is inferred until this passes.

### M6. Engines and GitHub (about three lanes in parallel)

**T28 · M · Inventory and sign-in.** 21 / 34. Closes #2 properly, half of #26

- _Status (r4):_ **Done** (`eb9ff660b`, `e286db053`, `69e452861`). `engine.list` takes an optional `include`; the sign-in route asks only for `signIn`, as main.
- _Moves:_ both login executors, one route taking a placement. Old routes are aliases to the local placement.
- _Files:_ `engine-login.ts`, `engine-runner-executor.ts`, `engine-manager.ts`, both route sets.
- _Local:_ old responses identical. _Runner:_ fixture CLI login under workload.
- _Contract (T04 #28):_ add an optional engine `path` to `engine.list` only if the engine UI needs it.
- _Risk:_ touching the user's real credentials. Tests use fixture homes only.

**T29 · M · Install, update, plugins.** 21 / 30. Closes the rest of #26, N34

- _Status (r4):_ **Left.**
- _Moves:_ one engine manager, detected and configured commands as strategies, both on every platform.
- _Files:_ `engine-updates.ts`, executor, `plugin-status.ts`, plugin route.
- _Local:_ still no automatic install, same update detection. _Runner:_ same scenarios.
- _Risk:_ package-manager variations.

**T30 · M · Catalog and learning.** 19 / 29. Closes N30

- _Status (r4):_ **Left.**
- _Moves:_ learning in Dispatch keyed by runner, catalog through the interface.
- _Files:_ `engine-models.ts`, `manager.ts:829`, `shared/agent-models.ts`.
- _Local:_ old key read, main's offered-model settings. _Runner:_ a learned model appears.
- _Risk:_ collides with main's #1531. Needs T01.

**T31 · M · Usage, watches, reset.** 17 / 22. Closes #22, N17

- _Status (r4):_ **Left.**
- _Moves:_ one cached reporter per runner, same tool registration, no runner-only concurrency cap.
- _Files:_ `provider-plans.ts`, `local-runner-engine.ts`, MCP and usage routes, `usage-watches.ts`.
- _Local:_ cache and snapshot presentation. _Runner:_ same tools listed.
- _Contract (T04 #31):_ the codec stops refusing non-Codex `engine.quota.reset` once v1 is retired.
- _Risk:_ reset spends a credit. Fixture transport only.

**T32 · M · GitHub reads and PR tracking.** 16 / 20. First half of #27

- _Status (r4):_ **Done** (`3d5dfad7d`, `65449e517`). Remote PR watches are deleted; a local call the child never answers falls back in process.
- _Moves:_ one executor, one refresher cadence, delete watches.
- _Files:_ `pull-request-{reader,refresher}.ts`, GitHub executor, watches, PR route.
- _Local:_ five-minute cadence and fallback as main. _Runner:_ same cadence and shape.
- _Risk:_ rate limits per account.

**T33 · M · Merge-risk evidence.** 16 / 17. Closes #27. Last in-app adapter deleted, R3 0

- _Status (r4):_ **Done** (`51a073170`). Local records keep main's empty scope; runners key by (runner, credential). **R3 is not 0:** 15 `local-runner*.ts` method entries remain (see 0.4).
- _Moves:_ evidence reads through the runner, one history rule.
- _Files:_ `merge-risk/{sources,github-source,explanation-diff,assessor}.ts`.
- _Local:_ grades and cache keys for recorded evidence. _Runner:_ same evidence gives same grade.
- _Risk:_ invalidating saved assessments.

### M7. Dispatch's rules stop caring (parallel where files allow)

**T34 · M · Repository identity.** 11 / 14. Closes #13, #14, loop half of #16, N18, N19

- _Status (r4):_ **Left.**
- _Moves:_ one identity per D5 for Brain, tasks, agent list, history, telemetry, loop handoff. With D8 a runner session's key is its project's: the primary root's path key when the project has a folder, else the project's repository key. No origin search.
- _Files:_ `routes/mcp.ts:73-100`, `tasks/agent-scope.ts`, `server/mcp-handlers.ts:200`, `jobs/service.ts:528`, activity SQL.
- _Local:_ every key byte-identical. _Runner:_ tools present without a project, successor reads the handoff.
- _Risk:_ orphaning Brain memory. Never rewrite an existing local key.

**T35 · M · Personas.** 9 / **0**. Closes #12, #19, N23, N24. **Smaller after P5:** local catalog caps, warnings and tool texts are main's again. Left: runner discovery and authoring.

- _Status (r4):_ **Left.**
- _Moves:_ discovery, owners and authoring use checkout operations and pre-launch targets. Pre-launch on another runner reads `{repository}` at the base ref from the runner's cache, as main's catalog reads the origin's default branch; `{path}` stays local (D7). Parsing stays in Dispatch.
- _Files:_ `personas/**`, persona routes and tools, templates, jobs.
- _Local:_ catalog order, sources, warnings, symlinks. _Runner:_ repository personas before launch, upsert writes there.
- _Contract (T04 #17, #18):_ `checkout.read` fills `digest`; `checkout.write` is served by the runner.
- _Risk:_ writes as the workload, with a digest guard.

**T36 · M · `launch_agent`, children, reviews.** 1 / 0. Closes #9, #18, N1, N2, N4

- _Status (r4):_ **Left.**
- _Moves:_ one admission: local's rules, with a location. The existing access ceiling, equal for all. On another runner, an agent's own checkout path works through `{session}`, and so does any runner the UI offers with a project (D7). P5 restored main's tool descriptions, so only the runner-only sentence remains to delete.
- _Files:_ `launch-admission.ts`, `server/mcp-handlers.ts:369-565`, `mcp-persona-handlers.ts`.
- _Local:_ local targets unchanged, behaviour unchanged with no remote runner enrolled. _Runner:_ own path accepted, same default as local.
- _Risk:_ access escalation. Re-run the ceiling tests.

**T37 · M · One agent view.** 1 / 0, R6 falls. Closes #21, N25, N32

- _Status (r4):_ **Left.** Includes removing the agent card's runner-only branch (see the task).
- _Moves:_ branch, directory, change workspace, copy, files header, usage read the same fields. P7 restores main's delete dialog. IDE follows main's one rule, "the browser is on the machine holding the checkout", with main's message and no runner message; Open in IDE for runner agents stays a known gap (D11).
- _Files:_ `web:` agent card and details, files pane, composer meta, history, delete dialog.
- _Local:_ screenshots at 390 px and desktop match main. _Runner:_ same controls.
- **Remove the runner-only card branch** (`6c2d1deb1`, `web:` `agent-card{,-details,-header,-status}.tsx`): a runner agent shows "Runs on" instead of its branch and loses Change workspace and the copy action. Show the same branch row and actions as local. Open in IDE follows main's rule only (D11), not a runner check.
- _Risk:_ visual regression.

**T38 · M · One launch and automation form.** 1 / 0, R6 to 0. Closes #20, N8

- _Status (r4):_ **Left.** Includes T08's trigger location.
- _Moves:_ branch, path, model, persona and engine inputs take a placement. For a placement other than the controller's runner, the folder input is a required project picker and branches come from the project's repository (D7). The local form is main's.
- _Files:_ `web:` create form, branch select, automation and trigger dialogs, engine settings.
- _Local:_ main's flows. _Runner:_ a saved automation is accepted as offered.
- _Risk:_ main changed these files. Needs T01.

**T39 · M · Ports (D6).** **0** / 0. Closes #15, screencast, N26, the rest of N27

- _Status (r4):_ **Left.**
- _Moves:_ `port.connect` as baseline, preview proxy, screencast through it. The runner listener forwards the stream route `bin/dispatch-stream` calls, under that agent's token.
- _Files:_ `stream-manager.ts`, streaming and preview routes, `agents/remote/service.ts` forward, `bin/dispatch-stream`.
- _Local:_ URLs and helper unchanged, no proxy inserted. _Runner:_ loopback preview, screencast, helper start and stop.
- _Risk:_ SSRF. Authenticated user, bound to the session, loopback only, connected as the workload. No port allowlist beyond that.

**T40 · M · Seal v1.** 0 / 0, all ratchets 0. Closes N29. The migration count is no longer an owner question (P0's consequence entry).

- _Status (r4):_ **Left.** Last.
- _Moves:_ delete the codec, locator, flags, adapters, capability refusals, legacy runner config (configured workspaces included, D7) and prototype bindings. Turn baselines into absolute bans. Build the standalone artifact.
- _Files:_ all boundary packages, `docs/remote-runner-linux.md`, README.
- _Local:_ full oracle. _Runner:_ all lanes, install test, one approved real-host pass.
- _Risk:_ The trial runner host is drained and reinstalled once (D2). Main-era host mode stays after this.

### 5.3 Dependencies

- Order is the table in 0.4. IDs are stable from the first version, so T10 runs inside M2.
- **T10 before L2:** one slow channel would otherwise disconnect every local agent, because all share one socket.
- **L3 before anything that writes moves into the child**, so no intermediate commit breaks a protected update.
- **L4 before T09:** the child needs a binding to resolve any session target.
- T23 needs L2, L3 and L4. L5 needs T23. T25 needs T15, T17, T18 and T19. T26 needs T23 and T24. T36 needs T25 and T35. T38 needs T17. T40 is last.
- **P slices:** P5 after P4 (same protocol file). P7 after P2 (landed). P0 and P6 any time. All before T04.
- Main is taken, and the parity pin moved, at the end of each milestone (D3).

---

## 6. Decisions: made

**D1. Separate process.**

- The owner's decision, against my in-process recommendation. Consequences: 2.2–2.4, L1–L5, T10 earlier, no in-process composition.
- It costs five tasks, serialisation on local reads and one more process to supervise. It buys local using exactly the remote code path and client, so a second local implementation has nowhere to live.
- I overstated the macOS identity cost in the first version. It is the same signed binary under the same launchd job, to be confirmed in L5.

**D2. v1 may change incompatibly until first ship.** The trial runner host is reinstalled once, at T40. Compatibility with main-era local hosts is separate and permanent enough to outlive that: those are users' running agents.

**D3. One PR after T40.** Main at each milestone.

**D4. Any regular file the agent's OS account can read,** on every placement. No roots, no other-session exclusion, no size cap of our own.

**D5. Shared across machines, revised by D8.** Roots on the controller's machine keep their path as the key, exactly as today. A runner session takes its project's key: the primary root's path key when the project has a folder, else a key from the project's repository. With one project per repository there is no origin search.

**D6. Authenticated, session-bound loopback port forwarding.** Ports are baseline, not optional.

**D7. Projects, Option A.**

- A project keeps its local folder, plain folders included, and records its repository when the folder has an origin.
- A project can be created from a repository alone.
- Runners never take a user-named folder: they make their own checkout from the repository.
- Consequences:
  - no workspaces, so `Placement` is `{runner}`
  - `{path}` targets and user folders go only to the controller's runner
  - Dispatch never _sends_ a user-named path to another runner, but it does record the folder an agent moved itself into there (`set_workspace`, any directory its account can use)
  - a launch on another runner names a project
  - forms show a project picker there

**D8. One project per repository.**

- Existing duplicates merge once into the oldest (T17), and new ones are refused.
- The owner expects duplicates to be rare and asked for the simplest safe handling, so there are no options and no general merge.
- Over time projects may become repository-only. That is not now.

**D9. Local is main.**

- Applied by P0–P7.
- Answers to the earlier open questions, all restored to main by P7:
  - unknown base during archive: delete
  - force after a stale dialog state: delete
  - auto-archive when status fails: remove
  - main's diff error texts
- The unchanged-file diff was already restored by P3.

**D10. Offline stop** is recorded and retried on reconnect (T26).

**D11. Known gaps, not built:**

- `login_link` from a runner agent when Dispatch listens only on loopback
- Open in IDE for runner agents (main's one machine rule)

**D12. Approved intended differences** (P0):

- `runnerManaged`, and later `placement`, on agent records
- `ownership`, `borrowers` and `checkoutState` on worktree status
- the migration count

**Readings from revision 2, now settled:**

- **T08:** confirmed by the owner. No `runner` means the creator's machine.
- **T17:** superseded by D7. A runner repository becomes a project through its URL, not a runner path.

- **T16 (settled after r3's first post):** `set_workspace` on any runner takes any directory the agent's account can use, as local. The agent choosing its own folder is not a user-named folder, and runner agents' tools are not restricted.

---

## 7. Risks

### To local users

| Risk                                                                                    | Control                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live hosts from main lost on upgrade                                                    | Keep state paths, file names, socket and argv. E7 attaches a main host                                                                                                                                                                                  |
| Worktree deleted differently from main when ownership moves to the runner               | P7 makes local remove exactly what main removes; T20 keeps that and adds no guard. L4 imports once and proves ownership with Git; unknown ownership means external, so an imported row is never removed by inference. T20 tested on main-created agents |
| Project merge (D8) loses a duplicate's name, colour, icon and colliding column settings | One-time, only for projects sharing a repository; nothing changes without duplicates. T17 lists what is lost; count duplicates on dev data only                                                                                                         |
| A "parity" fix changes local                                                            | Where they differ, remote moves. Source-specific rules attach to the source                                                                                                                                                                             |
| Hard-to-see hardening regressions (caps, no-follow, timeouts)                           | This already happened seven times. E7, and any new limit is an explicit request value                                                                                                                                                                   |
| Socket cost of large reads                                                              | Diff, index and watch timing in E7 at T09, flow control first                                                                                                                                                                                           |
| Orphan child runs an old build after an update                                          | Lifeline, lock, exact handshake, SIGKILL scenarios, L5                                                                                                                                                                                                  |
| Child crash shows as every agent dying                                                  | Unavailable is never an exit. Hosts are detached                                                                                                                                                                                                        |
| Update backs up under a live writer                                                     | L3: freeze, fresh boundary list, unknown defers                                                                                                                                                                                                         |
| A wrong build or lock failure leaves local unavailable                                  | Backoff and the existing reconnecting state. No silent fallback                                                                                                                                                                                         |
| Rollback to main                                                                        | Additive columns with defaults, `cwd` unchanged, mirrors still written                                                                                                                                                                                  |
| Branch migration collision                                                              | T01, and verify no production database ran the branch numbers                                                                                                                                                                                           |
| Learned models, Brain keys, schedules orphaned                                          | Fallback reads, never rewrite local keys. The D8 merge leaves Brain keys per folder                                                                                                                                                                     |
| macOS privacy or Keychain identity                                                      | Same signed binary and launchd job [inferred]. L5 proves it before ship. `restricted` is preserved                                                                                                                                                      |

### To the existing runner on a real host

| Risk                                                     | Control                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Root follows a workload-planted link once core is shared | Core has no raw filesystem access to workload paths. Only `Platform.workload` does, and the remote lane attacks it |
| `resetHost` and retention (the #1 class)                 | An explicit owned-file list, never a recursive delete at launch. Files and journal scenarios                       |
| Retained hosts break across the handoff                  | Keep handoff formats until T40, then drain before the one reinstall                                                |
| Self-update cannot cross the v1 break                    | A version mismatch closes the socket, so it cannot update itself across it. Announce a manual reinstall            |
| Wider file collection, Git config and hooks              | Everything runs as the workload account, never root. The agent's shell can already do it. D4 is explicit           |
| Port forwarding                                          | Off until T39, with the controls listed there                                                                      |
| Flow control regression kills every channel              | T10 lands alone with slow-reader and disconnect tests                                                              |
| The remote lane differs from systemd                     | Installer test stays. L5 for the local child, approved host check at M2, M5 and T40                                |
| Sweep kills another controller's sessions                | `owner` on launch and list, unknown rows are never swept                                                           |

### To the programme

- **The branch is over 360 commits and diverges fast.** Main moved three times during this work. Main merges are scheduled work, and moves wait for T01.
- **"Parity" becomes a gate.** The quick fix for a fork is a refusal, as my own F4 was. E9 and rule 5.2 exist for that.
- **Adapters become permanent.** Each has a baseline entry and a deleting task, and T40 cannot pass with any left.
- **The gate protects structure, not meaning.** A neutral-named product rule can still enter the runner. E6 and the snapshot diff narrow that and do not remove it. A separate process does not change this.
- **M5 is where the goal is achieved.** Stopping at M3 or M4 leaves better plumbing and still two programs.

---

## Appendix A. Where the audit and the code disagree

| Audit says                                                              | Code says                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 81 placement checks in 29 server files                                  | At the audited commit, 80 calls in 29 files. Three raw `runner://` prefix tests make 83 in 30 files. It is 86 at `f7897bf7e`. Derived conditions like `if (placement)` number about 159, which is why the gate bans the source **[ran]** |
| Views, inspection and watch are "through the protocol" (table)          | Its own section 4.1 is right: local calls the modules directly (`checkout-runner.ts:27-43,185`, `checkout-observers.ts:83`). Under "same interface", fewer than 18 rows qualify **[code]**                                               |
| "Submodules are empty" as a runner difference (#10)                     | A local `git worktree add` also leaves them empty. The tag difference is real **[ran]**                                                                                                                                                  |
| #1 is the files directory                                               | Also the journal and prompt receipts, which local keeps. The fix in `479db4da2` retains only files **[code]**                                                                                                                            |
| Local runner is created twice                                           | The local engine runner also has up to five construction sites: `server.ts`, engine manager, MCP, system and usage routes **[code]**                                                                                                     |
| Remote shares "only leaf helpers"                                       | True for orchestration. It also shares the whole agent host and driver, which is why extraction is feasible **[code]**                                                                                                                   |
| Project create, icon and origin inference are controller-only by nature | Folders are, by D7: a user names folders only on the controller's machine. Projects also record their repository, and a project can be created from a repository alone (T17), which is how runners get projects                          |
| Job crash diagnostics is controller-only                                | It is dead on both, reading a log with no writer. Delete it or point it at `session.logs`, as a follow-up outside this plan **[audit]**                                                                                                  |
| PR cadence differs by constant                                          | The shared constant claims five minutes "on local and runner placements" (`packages/runner-protocol/src/github.ts:16`), while the runner watch samples every 30 seconds per its README **[code]**                                        |

I found no finding among #1–#34 that is wrong in substance. I re-read #1–#5, #8–#10, #12, #16, #17, #19, #22–#25, #31 and #32 in code. The rest are **[audit]**.

## Appendix B. Every audit row has a task

All 29 forks, 19 bypasses and 4 refusals from the audit's table:

| Class                                              | Capability → task                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fork: lifecycle**                                | Create → T25 · Preparation → T18, T19 · Spawn and environment → T24 · Files directory on restart → landed, T24 · Stop and discard → T23, T26 · Launch failure → T26 · Update quiesce → T27 |
| **Fork: conversation**                             | Steering with attachments → T12 · Tool locations → T15                                                                                                                                     |
| **Fork: files**                                    | Post by path → T11 · Attachment delivery → T12 · Attachment path → T12                                                                                                                     |
| **Fork: workspace**                                | Comparison base → T16 · `set_workspace` → T16 · Agent card and Files header → T37                                                                                                          |
| **Fork: repo tools**                               | Fixed operation → T14                                                                                                                                                                      |
| **Fork: GitHub**                                   | Launch lookup → T25, T32 · Branch picker → T17, T38 · PR status → T32 · Merge risk → T33                                                                                                   |
| **Fork: orchestration**                            | Shared or independent checkout → T36 · Persona launch → T24, T36 · Agent list and PR-risk visibility → T34                                                                                 |
| **Fork: engines**                                  | Settings → T28, T29 · Plugins → T29 · Catalog → T30 · Installed check → T24, T28 · Usage → T31, T37                                                                                        |
| **Fork: archive**                                  | Status and release → T20                                                                                                                                                                   |
| **Bypass: lifecycle**                              | Orphan sweep → T27                                                                                                                                                                         |
| **Bypass: files**                                  | `list_files` → T13 · Task briefing → T13 · Slack images → landed, T11                                                                                                                      |
| **Bypass: workspace**                              | Git context → T15 · Icon → T15 · Previews → T39                                                                                                                                            |
| **Bypass: orchestration**                          | Persona discovery → T35 · Authoring tools → T35 · Brain → T34 · Task scope → T34                                                                                                           |
| **Bypass: jobs**                                   | CRUD → T08, F4 withdrawn · Loop handoff → T34 · Forms → T17, T30, T38                                                                                                                      |
| **Bypass: engines**                                | Inline sign-in → F2, T28 · Watches and reset → T31                                                                                                                                         |
| **Bypass: archive**                                | Offline configured → F3 (landed), T20                                                                                                                                                      |
| **Bypass: observability**                          | Resources → T27 · History by project → T15, T34                                                                                                                                            |
| **Refused**                                        | Change workspace → T37 · Screencast → T39 · `launch_agent` target → T36 · Open in IDE → T37, main's one rule for every checkout                                                            |
| **Local regressions, 4.3 and the oracle baseline** | P0–P7 (was F1), proved by T03                                                                                                                                                              |

## Appendix C. Method and limits

- **Read in code:** the protocol package and README, all local runner modules, the remote runner, the supervisor's launch, files, checkout and lifecycle paths, the relevant runtime and manager paths, admission, archive, base, the MCP context, and CI and check configuration. Not every line of `manager.ts`, the update subsystem, the web app or the test suites.
- **Ran, on exports and fixtures:** the placement and host-access census, import closures, the scanner prototype with planted violations, five typecheck experiments, an ESLint experiment, hoisting resolution, a submodule and tag fixture, and a trial merge (`git merge-tree`, which left the index and worktree untouched and wrote only unreferenced objects to the Git object store).
- **Migration collision:** read in node-pg-migrate's `checkOrder` and this repo's runner options. Not run against a database.
- **Revision 2 also read,** at pinned commits: `f7897bf7e`'s job and template change, admission, MCP routes and tool registration, the runner listener's forward rule, runner limits, IDE and create-form conditions, the helper script, main's updater, launchd plist and server launcher.
- **Ran for D1:** v1.7.28, main (`55a8c6fc8`) and branch host code, with the engine and socket replaced in memory, driven by the branch client. No real update, engine, signed app or systemd.
- **Not read:** the merge now in progress. `03d4592b7` was checked only for its subject and migration list.
- **The restriction sweep** was a search for refusals, caps, gates and conditional UI, then reading each hit. A restriction expressed some other way can be missed. E9's runtime comparison is the backstop.
- **R2 is a prototype's count.** It sees direct imports and a fixed list of host modules. T02's real scanner may differ by a few entries, and its first output becomes the baseline.
- **R5's starting number is not given**, because the edge list depends on T02's final package cut.
- **Not verified:** production databases' migration state, behaviour on any real runner, engine CLI trust on runners, Docker lane timing, and effort estimates.

---

## Appendix D. Every "runner can do less" rule found

### Part 1: in the first version of this plan, now replaced

|     | What I had written                                                                                     | Replaced with                                                                        |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| P1  | F4: refuse runner paths in jobs and templates until T08                                                | Withdrawn. T08 stores the runner and narrows nothing                                 |
| P2  | Workspaces marked `confined` or `none`, with per-workspace sources                                     | Revision 2: a workspace is a default location. Revision 3: no workspaces at all (D7) |
| P3  | T17 treated browsing outside a confined workspace as a risk to block                                   | The OS account is the only boundary                                                  |
| P4  | `forbidden` could mean "runner policy"                                                                 | OS refusal only                                                                      |
| P5  | Per-runner `limits`, "limits can differ", `busy` for concurrency caps                                  | No runner limits. Only limits the caller passes, equal to main's                     |
| P6  | HTTPS-only and hardened Git, justified as attached to the URL source                                   | The account's Git. An agent's own worktree uses the directory source                 |
| P7  | `ports`, `engineInstall` and `health` optional                                                         | Baseline                                                                             |
| P8  | T39 could become "one honest `unsupported`"                                                            | Port forwarding, decided                                                             |
| P9  | T36 allowed "any permitted runner"                                                                     | Any runner the UI offers, with no new permission                                     |
| P10 | T37 disabled IDE with a runner reason                                                                  | Main's single rule and message                                                       |
| P11 | T13 would "bound" file materialisation, and projects from runner repositories were left as a follow-up | Every listed path opens. Projects are in T17, by repository (D7)                     |

### Part 2: in the code at `f7897bf7e`, which seeds R7

|     | Rule today                                                                                                                              | Non-restricting fix                                                                   | Task     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| N1  | `launch_agent` refuses a runner agent's real path, other runners and other folders (`mcpTarget`). A local caller cannot target a runner | Local's rules, with a location                                                        | T36      |
| N2  | The caller's `cwd` and a template's directory are overwritten with the caller's locator                                                 | Use what was given, as local                                                          | T36      |
| N3  | `runnerStorage`: no parent, job, project, worktree or persona on some runner workspaces                                                 | Accept them on every runner; workspaces are deleted (D7)                              | T25      |
| N4  | Child and independent binding rules that apply only to runner parents                                                                   | One admission                                                                         | T36      |
| N5  | Repository checkout only in a managed workspace                                                                                         | The repository is every runner's checkout source; the workspace check is deleted (D7) | T19      |
| N6  | An independent worktree needs an HTTPS origin                                                                                           | Worktree from the agent's own directory, as local                                     | T18      |
| N7  | Cross-project task launch is refused only for managed runners                                                                           | Main's rule for all                                                                   | T25      |
| N8  | Forms force a worktree, or offer branch, PR and task options only on some runners                                                       | Same options                                                                          | T38      |
| N9  | `set_workspace` is confined to the workspace or kept disjoint from runner storage                                                       | Any directory the account can use, on every runner, as main                           | T16      |
| N10 | Attach by path: two roots, no links, 20 MiB                                                                                             | D4                                                                                    | T11      |
| N11 | Delivery names are ASCII-only, with stricter path characters                                                                            | Main's rules                                                                          | T12      |
| N12 | URL checkouts: HTTPS only, hooks and user Git config off, extra branch refusals, no tags                                                | The account's Git and main's branch rules                                             | T19      |
| N13 | Checkout reads: 16 MiB replies, 512 watches, extra metadata and path limits                                                             | Main's limits only, chunked transport                                                 | T09      |
| N14 | Repo tools: 32 at once, 5 minutes, 64 KiB, 256 KiB manifest                                                                             | Main's limits only                                                                    | T14      |
| N15 | Repo tool execution has a runner-only credential gate                                                                                   | Local's rule, the listener already authenticates                                      | T14      |
| N16 | 16 terminals per runner, on top of the app's limit                                                                                      | Main's limit only                                                                     | T21      |
| N17 | No usage watch or reset tools, and a capability concurrency cap                                                                         | Same tools and rule                                                                   | T31      |
| N18 | No Brain, and no task board, without a project                                                                                          | D5 key                                                                                | T34      |
| N19 | Agent list and PR-risk visibility need a project                                                                                        | Same repository rule                                                                  | T34      |
| N20 | A text attachment cannot steer                                                                                                          | Same rule                                                                             | T12      |
| N21 | A missing attachment fails the whole prompt                                                                                             | Main's warn and continue                                                              | T12      |
| N22 | No Git context refresh                                                                                                                  | Same cadence                                                                          | T15      |
| N23 | `persona_upsert` and `persona_validate` are not registered                                                                              | Register, write there                                                                 | T35      |
| N24 | Launch-time personas fall back to built-ins or another repository                                                                       | Read the target                                                                       | T35      |
| N25 | Change workspace and Copy are hidden                                                                                                    | Same controls                                                                         | T37      |
| N26 | Screencast returns 409                                                                                                                  | Port forwarding (D6)                                                                  | T39      |
| N27 | Helper commands are off PATH, and the listener does not forward the route they call                                                     | Same helper works                                                                     | T24, T39 |
| N28 | A runner repository cannot be a project                                                                                                 | A project records its repository and can be created from one (D7, D8)                 | T17      |
| N29 | Per-flag "update the runner" refusals                                                                                                   | Baseline protocol                                                                     | T40      |
| N30 | Model learning is local only, so saves refuse models the UI offers                                                                      | Learn per runner                                                                      | T30      |
| N31 | Repository icons are switched off                                                                                                       | Same probe                                                                            | T15      |
| N32 | Open in IDE has a runner-only refusal                                                                                                   | Main's one machine rule                                                               | T37      |
| N33 | Stop fails while the runner is offline                                                                                                  | Record and retry, as the child needs too                                              | T26      |
| N34 | Engine update only where commands were configured                                                                                       | Detection on every platform                                                           | T29      |
| N35 | Release rechecks the observed state and defers to borrowers on the runner only (recorded by P7)                                         | `workspace.release {force}`, main's removal                                           | T20      |

Evidence is the first version's finding for that area plus this revision's reading of the code at `f7897bf7e`. Rows from audit findings I did not re-read keep their **[audit]** status.

### Part 3: differences kept, and why they are not restrictions on runner callers

- **A revoked registration loses MCP access.** That is revoking the machine.
- **The access ceiling** (a restricted agent cannot create full-access work) is identical for local callers.
- **The OS boundary:** supervisor state is root-owned, so the workload account cannot read it.
- **Connection state:** an unreachable runner cannot act. The local child has the same state.

### Part 4: found with no fix that avoids new behaviour. Decided: left as known gaps (D11)

- **`login_link` from a runner agent** gives a path on Dispatch's origin. If the app listens only on loopback, an agent on another machine cannot open it. Fixing it would expose the web origin through the runner listener, which is new behaviour and wider access. The owner left it as a known gap.
- **Open in IDE for a checkout on another machine** stays unavailable under main's existing rule, as it is for a local agent viewed from a phone. The owner left it as a known gap.

### Part 5: what D7 changes in this list

D7 is an owner decision about where folders come from, not a refusal added to close a gap:

- Folders a user names exist only on the controller's machine. Dispatch never sends one to another runner, but it records a folder an agent moves itself into there.
- Every runner accepts every launch kind a project allows.

N3, N5, N9 and N28 now read through D7, and N35 is new (P7 → T20). No runner caller loses a tool or an input that a local caller has for the same project.
