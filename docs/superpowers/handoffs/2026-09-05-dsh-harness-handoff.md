# Dispatch Harness — session handoff (2026-09-05)

Written by the session that built the Dispatch Harness line so the next
session can continue without the conversation. Read this, the two specs and
plans under `docs/superpowers/`, and `release-notes/current.md` first.

## Where things stand

- Branch `agt_683b115bc1e9/dispatch-harness-research`, worked in the worktree
  `/Users/daemon-ai/src/dispatch-agt-683b115bc1e9-dispatch-harness-research`.
  Seventeen local tags `v0.38.7-dsh.1` … `v0.38.7-dsh.17`, none pushed, no
  PR yet. Production (`127.0.0.1:6767`, launchd `com.dispatch.server`) runs
  `v0.38.7-dsh.17` (commit `05ba2aa`). Nii wants a PR to `main` at some point;
  ask before opening it.
- A whole-branch review (#294, persona `code-review`) found 8 lifecycle
  issues; all were fixed and verified (dsh.12/dsh.13).
- Nii's UX decisions so far (do not revisit without asking): the agent type
  is labelled **Dispatch** in menus and **Dispatch Harness** in settings with
  the Dispatch brand mark; the Harness view _is_ the agent's Chat (toggle is
  Chat | Console, the Chat feed pane is not mounted for dsh); no nested
  scrollbars anywhere (blocks wrap and expand); Dispatch-injected prompts
  render as notices; OpenAI models limited to gpt-5.6\*; default model
  `openai/gpt-5.6-sol`; turns are labelled with the agent's own status
  message.

## What the harness is

- Agent type `dsh`: DeepSeek Harness (`dsh` binary, `DISPATCH_DSH_BIN`) driven
  over the Agent Client Protocol. Server module `apps/server/src/agents/dsh/`
  (driver, supervisor, stream-store/recorder, turns, overlay, persona, skills,
  command-log, prompt-source, usage-recorder). Routes in
  `apps/server/src/routes/agents/harness-routes.ts`: turns, skills,
  config (model/effort GET+PUT).
- Web `apps/web/src/components/app/harness/`: PromptKit port (contracts,
  reduce, primitives), `harness-pane.tsx` (composer, chip, picker, drops,
  questions), `use-harness-*.ts` hooks, `code-block.tsx` (wrapping,
  highlighted, expandable blocks), `question-card.tsx`, `model-picker.tsx`.
- The Console pane for a dsh agent tails `<DSH_HOME>/logs/<agent>.log`
  (every settled shell command) in a tmux split above a login shell.
- Dispatch's plugin skills were copied by hand into `~/.dispatch/dsh/skills/`
  on this machine so the `/` menu has entries; shipping that from the server
  is an open follow-up.

## How to run checks and ship

- `pnpm run check`; web tests `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`;
  server tests need `TEST_DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:54329/postgres`
  (a scratch Postgres 16 cluster; if it is down, start it with
  `LC_ALL=C pg_ctl -D <scratch>/pg/data -o "-p 54329 -k /tmp/dsh-pg-sock" start`,
  or `initdb -U dispatch --auth=trust` a new one). No Docker on this machine:
  `test/dispatch-dev.test.ts` fails for that reason only.
- Live dsh E2E: create a DB, then
  `DATABASE_URL=… E2E_PORT=6899 MEDIA_ROOT=… DISPATCH_AGENT_RUNTIME=tmux DISPATCH_SESSION_PREFIX=… DISPATCH_DSH_BIN=$PWD/e2e/fixtures/fake-dsh.mjs DISPATCH_DSH_HOME=… E2E_SKIP_WEB_BUILD=1 pnpm exec playwright test --project serial --no-deps --grep "dsh agent"`
  (build the web first with `pnpm run finalize:web`).
- Release: bump the six manifests (root, apps/server, apps/web,
  packages/shared, apps/browser-extension + its public/manifest.json; not
  apps/site), add a line to `release-notes/current.md`, commit
  `Release v0.38.7-dsh.N`, tag, `DISPATCH_BUN_TARGETS=bun-darwin-arm64 pnpm run build:bun`,
  copy `dist/bun/dispatch-<ver>-bun-darwin-arm64` over `~/.dispatch/server/dispatch`
  (keep the previous binary as `dispatch.dshN`), set `tag`/`deployedAt` in
  `~/.dispatch/release.json`, `launchctl kickstart -k gui/$(id -u)/com.dispatch.server`,
  poll `/api/v1/health`, check the "Restored dsh agents" log line in
  `~/.dispatch/logs/dispatch.log`. Delete stray `.*.bun-build` files at the
  repo root after building.
- Browser checks: `dispatch_login_link` gives a 60-second login URL; the
  Chrome MCP tab is hidden, so the app's SSE stays off there — hard-reload to
  see updates, and never type into the Name field (1Password hijacks it).

## The task in flight: a visible message queue (not started in code)

Problem (Nii, with screenshot): sending a message while the agent is mid-turn
seems to make it disappear. It is actually queued — `DshSupervisor.enqueuePrompt`
chains turns one at a time — but nothing shows it until its turn starts.

Design agreed with myself, not yet reviewed by Nii:

1. Supervisor: replace the promise-chain queue with an explicit per-agent
   FIFO: `pending: Map<agentId, Pending[]>` where
   `Pending = { chatMessageId: string | null; text; started/settled deferreds }`
   (`chatMessageId` from `parsePromptSource(text)`), a `running` map, and a
   `pump()` that starts the next item when nothing runs. Keep
   `enqueuePrompt` returning `{ started, settled }`; `isBusy` = running or
   pending; `runTurn`'s `isLastQueued` = pending empty. Add
   `listQueued(agentId)`, `removeQueued(agentId, chatMessageId)` (resolve
   `started` with a rejection so the chat row settles `delivered=false`, or
   delete the row), `promoteQueued(agentId, chatMessageId)` (move to front),
   and `interrupt(agentId)` (= `driver.cancel`; the running turn settles
   `cancelled` and the pump continues).
2. Routes: `GET /harness/turns` gains `queued: { id, text, createdAt }[]`
   (text from the chat message); `POST /api/v1/agents/:id/harness/queue/:messageId/send-now`
   (promote + interrupt); `DELETE /api/v1/agents/:id/harness/queue/:messageId`.
3. Web: `TurnStream` renders queued items after the live turn as dimmed
   prompt lines with a "Queued" chip and two actions: **Send now** and
   **Remove**. While a turn is running the composer hint reads
   "Agent is working · Enter queues your message". Refetch turns after
   either action (the SSE path already invalidates on chat.changed).
4. Tests: supervisor (order, remove, promote+interrupt), turns route
   (queued list), harness-pane (queued rendering + actions).

Keep the existing supervisor tests green (`test/dsh-supervisor.test.ts`),
especially "runs overlapping prompts one at a time" and the review-fix tests.

## Second task in flight: slash menu mid-prompt (not started in code)

Nii (with screenshot): typing `/` in the middle of a message ("lets do this /")
should open the skills autocomplete; today `slashQuery()` in
`apps/web/src/components/app/chat/chat-composer.tsx` only matches when the
whole field is `/<partial>`. Wanted: a `/` at a word boundary at the caret
opens the menu; picking an item replaces that token with `/<name> ` at the
caret and keeps focus; Escape dismisses for that token only. Command items
(`/model`) should stay start-of-message only. Tests live in
`chat-composer.test.tsx` ("ChatComposer slash menu"). Track the caret with
`selectionStart` on change/keyup; keep the menu keyboard handling as is.

## Follow-ups Nii has not asked for yet

- Ship Dispatch plugin skills into `<DSH_HOME>/skills` from the server.
- Retention/pruning for `agent_stream_events`; no token counts from dsh over ACP.
- Older turns (before dsh.4) have no tool input recorded, so their labels
  fall back to generic phrases.
- The job-run lookup in `DshSupervisor.start` queries the active run at
  completeSetup time; if that ordering ever tightens, pass `jobRunId` on the
  agent record instead (reviewer caveat).

## Housekeeping

- Test agents I created on production and left running: `Repo Snapshot`
  (`agt_7d1a4e4ac0cc`). Archive when convenient.
- Memory notes for this work live at
  `~/.claude/projects/-Users-daemon-ai-src-dispatch/memory/project-dsh-harness-evaluation.md`
  and `project-dispatch-local-env-quirks.md`.

## Update, later on 2026-09-05: both tasks shipped as v0.38.7-dsh.18

Done by the successor session (commit `eca9e00`, release `9ab737c`, tag
`v0.38.7-dsh.18`, deployed 23:22Z; rollback binary
`~/.dispatch/server/dispatch.dsh17`).

- The queue is the explicit FIFO described above: `DshSupervisor` keeps
  `pending` and `running` per agent with a `pump()`. `listQueued`,
  `removeQueued` (rejects `started`, so the chat row settles
  `delivered=false`), `promoteQueued`, `interrupt`, and `sendQueuedNow`
  (promote + interrupt). `stop()` flushes the queue the same way. A chat
  prompt queues under its chat message id; anything else gets `q_<uuid>`.
  `enqueuePrompt` publishes `chat.changed` when the prompt has to wait, so
  the view lists it without a stream write.
- `GET /harness/turns` carries `queued: HarnessQueuedPrompt[]`;
  `POST /harness/queue/:id/send-now` and `DELETE /harness/queue/:id` (204,
  or 404 "no longer queued"). `loadQueued` in `turns.ts` joins chat text.
- Web: `queued-prompt.tsx` rows after the live turn, `use-harness-queue.ts`
  mutations, `ChatComposer` takes a `hint` prop; the pane sets it while a
  turn runs or anything is queued.
- `DshDriver.prompt` races the ACP call against the child's exit. Before
  this a crash mid-turn left the promise pending for ever, which with the
  explicit running slot would have wedged the agent's queue.
- Slash menu: `slashTokenAt(text, caret)` in `chat-composer.tsx`; the caret
  is tracked on change, keyup, click, and select. A pick replaces the token
  in place and reuses an existing following space. Command items are
  offered only when the slash is at index 0.
- E2E: `fake-dsh.mjs` sleeps on `sleep:<ms>` and honours cancel;
  `dsh-agent.spec.ts` has a second scenario covering queue, Remove, and
  Send now. Run it the same way as before.

Browser gotcha found while verifying: the PWA service worker serves the
previous bundle after a deploy. The "Server updated" toast's Reload fixes
it; from the MCP tab, unregister the service worker and delete the workbox
cache, then navigate again.

Next up, from Nii: a usage popup for the provider API keys the harness
uses (tokens or dollars left, one bar per key). Recorded in the brain
(`dsh-harness` collection).
