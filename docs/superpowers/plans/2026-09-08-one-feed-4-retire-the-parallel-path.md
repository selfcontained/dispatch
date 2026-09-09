# One feed, plan 4 of 4: retire the parallel path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the second reader of a dispatch agent's turns, so the chat feed is the only one: the `/harness/turns` endpoint, `loadTurns`, the `HarnessTurn` wire types, the `use-harness-turns` query and every coarse invalidation that propped that query up, and close the client-cache gap the earlier plans left behind.

**Architecture:** Stage 3 of `docs/superpowers/specs/2026-09-08-harness-turns-in-chat-feed-design.md`. Plans 1 to 3 built the `turn` feed entry, moved the renderer into `chat/turn/`, and made `ChatPane` the dispatch agent's pane, while `/harness/turns` and its client query kept running in parallel. This plan removes them. One consequence has to be handled rather than deleted: a streamed chunk no longer refetches the feed, so the chat row a turn claims as its prompt must be dropped from the cached pages when the turn arrives.

**Tech Stack:** TypeScript, Fastify, Postgres (node-pg-migrate), React 18, Vite, TanStack Query, Vitest (node and jsdom + Testing Library), Playwright.

## Global Constraints

- Worktree `/home/nii/.dispatch/server-dsh-harness`, branch `dsh-harness-deploy`. Never touch `/home/nii/.dispatch/server` (production) or `127.0.0.1:6767`.
- American spelling. No em-dashes anywhere: prose, comments, UI copy, commit messages. Engine names come from `HARNESS_ENGINES[i].label`. Nothing mentions the harness's earlier child process by name, DeepSeek, or "provider key".
- Comments earn their place. Write one only where the reason is not visible in the code; never restate what the line does, and do not add a doc comment to a self-evident function. Keep the ones already in code you move.
- Prefer shadcn/ui primitives over hand-rolled UI. State stays colocated; React Query for server state; Jotai only for the persisted flag hint atoms that already follow that pattern.
- Motion inside a turn uses tokens from `apps/web/src/components/app/chat/turn/motion.ts`; the entry's arrival uses Brad's `animate-chat-enter`; reduced motion drops both (`useReducedMotion`, `motion-reduce:animate-none`).
- Commit messages: `type(scope): imperative subject`, lowercase after the colon, body wrapped at 72 that leads with the failure mode or effect, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Scopes in use: `server`, `web`, `shared`, `e2e`, `docs`.
- Each task ends green: `pnpm run check` passes and the task's own tests pass. Tests use the existing fixtures; a test that asserts nothing is a defect.
- Type check: `pnpm run check` from the worktree root. Web-only: `pnpm run check:web`. Web production gate: `pnpm run finalize:web`.
- Server unit tests need Docker Postgres and are run through the isolated script: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run <test files>`. Server test files are **not** type-checked (`apps/server/tsconfig.json` includes only `src/**`), so a wrong type there surfaces only when vitest runs the file.
- Web unit tests: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run <files>`. jsdom plus Testing Library; there is no jest-dom, so use plain matchers (`expect(el).not.toBeNull()`, `expect(el?.textContent).toContain(...)`), never `toBeInTheDocument`. Framer tests render under `MotionConfig reducedMotion="always"`.
- E2E: `pnpm run test:e2e` (isolated DB and server, agents inert). The live harness spec runs through `pnpm run test:e2e:live` against `e2e/fixtures/fake-acp-agent.mjs`; it needs `tmux` on PATH, which this host has at `/bin/tmux`.
- Do not run `git push`. Do not cut a release or change the version.
- **Plan 2 owns the collapsed rail's fold verb.** `TurnEntryView` passes `entry.label ?? turnLabelFromSteps(trace.steps)` to `ActivityBlock`, so a turn whose agent sent no `dispatch_event` still folds to a step-derived phrase; this plan only relies on that and never deletes `turnLabelFromSteps`.
- **This plan starts from the tree plans 1 to 3 produce.** Plan 1 is `docs/superpowers/plans/2026-09-08-one-feed-1-harness-flag.md`, plan 2 is `.../2026-09-08-one-feed-2-turn-entries.md`, plan 3 is `.../2026-09-08-one-feed-3-chat-pane.md`. Where a step names a file plan 2 or plan 3 created or moved, it says so. Every edit quotes the code it replaces verbatim rather than citing a line number, because plans 2 and 3 shift the line numbers in `apps/web/src/hooks/use-sse.ts`, `apps/server/src/chat/turns.ts` and `packages/shared/src/harness-types.ts`.

---

## File structure

| Path                                                                                                 | Responsibility after this plan                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/routes/agents/harness-routes.ts`                                                    | Config, queue, interrupt, commands, usage, paths. **No turns route**, no `DEFAULT_LIMIT`/`MAX_LIMIT`, no `loadTurns` import, no `HarnessTurnsResponse` import.                                                                                                                                                                                       |
| `apps/server/src/chat/turns.ts`                                                                      | Moved here by plan 2. `groupTurnRows`, `assembleTurns` (returning the new local `AssembledTurn[]`), `toTurnEntry`, `listTurnEntries`, `loadLatestTurnEntry`, `loadQueued`, `locationsFromInput`. **No `loadTurns`.** Steps and plan entries are typed `ChatTurnStep` / `ChatTurnPlanEntry`.                                                          |
| `apps/server/test/chat-turns.test.ts`                                                                | **Renamed** from `apps/server/test/harness-turns.test.ts`. Unchanged content: 20 cases over `assembleTurns` and `loadQueued`.                                                                                                                                                                                                                        |
| `apps/server/test/harness-routes.test.ts`                                                            | The turns `describe` deleted; one case asserts the route is gone while the queue route on the same prefix still answers.                                                                                                                                                                                                                             |
| `packages/shared/src/harness-types.ts`                                                               | The harness wire types that are not feed entries. **`HarnessTurn`, `HarnessTurnsResponse`, `HarnessStep`, `HarnessStepStatus`, `HarnessPlanEntry` deleted.** `HarnessQuestion` stays: `assembleTurns` still produces it.                                                                                                                             |
| `packages/shared/src/index.ts`                                                                       | Those five names dropped from the `./harness-types.js` type export list.                                                                                                                                                                                                                                                                             |
| `apps/web/src/components/app/harness/use-harness-turns.ts`                                           | **Deleted**, with `use-harness-turns.test.tsx`.                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/hooks/use-sse.ts`                                                                      | No `harnessTurnsQueryKey` import, no `invalidateHarnessTurns`, no `invalidateHarness`, no `invalidateChatFeedAndHarness`. The five coarse sites invalidate the chat feed only. `harness.changed` keeps the queue and the conditional config, and no longer refetches the feed. The reconnect snapshot sweeps the queue key in the turns key's place. |
| `apps/web/src/hooks/use-chat.ts`                                                                     | `upsertFeedEntry` prunes the chat row a `turn` entry claims as its prompt before placing the entry, through a new private `withoutTurnPrompt`.                                                                                                                                                                                                       |
| `apps/web/src/components/app/chat/turn/registry.ts`                                                  | Moved here by plan 2. Untouched: `turnLabelFromSteps` keeps `TurnEntryView` as its consumer, so it is on no delete list.                                                                                                                                                                                                                             |
| `apps/web/src/components/app/chat/turn/result-turn.tsx`                                              | Moved here by plan 2. `ResultText` stops being exported.                                                                                                                                                                                                                                                                                             |
| `packages/shared/src/chat-types.ts`                                                                  | `HarnessChangedEvent`'s doc comment says the event no longer refetches the feed. The type is unchanged.                                                                                                                                                                                                                                              |
| `apps/server/src/chat/service.ts`, `apps/server/src/agents/harness/supervisor.ts`                    | The same correction to `publishHarnessChanged`'s and `publishHarness`'s doc comments.                                                                                                                                                                                                                                                                |
| `apps/web/src/components/app/usage-budget-settings.tsx`, `apps/web/src/hooks/use-agent-pane-view.ts` | One line of Settings copy and one doc comment stop naming a view this work deletes.                                                                                                                                                                                                                                                                  |
| `release-notes/current.md`                                                                           | The Dispatch Harness bullet names the Chat feed and the Dispatch Harness setting; a new bullet records the fold.                                                                                                                                                                                                                                     |
| `docs/10-operations-runbook.md`                                                                      | Two clauses that name a view this work deletes now name the Chat feed.                                                                                                                                                                                                                                                                               |

---

### Task 1: The turns query and every invalidation that fed it

`use-harness-turns.ts` is the second cache over `agent_stream_events`. After plan 3 its only consumers are `use-sse.ts` and its own test. Deleting it takes with it `HARNESS_TURNS_LIMIT`, `harnessTurnsQueryKey`, `mediaFileUrl` (`chat-entries.tsx` has its own private copy), `toPromptKitTurns`, `promptHistoryOf` and `useHarnessTurns`.

It also removes one importer of `turnLabelFromSteps` from `chat/turn/registry.ts`. **That function is not dead and must not be deleted here:** plan 2's `TurnEntryView` calls it for the collapsed activity rail's verb, so it keeps a consumer and keeps its own test cases.

Everything in `use-sse.ts` that invalidated `["harness-turns", id]` goes with it. That is more than the one helper: `invalidateHarness` bundled the turns key with the session config key, and `invalidateChatFeedAndHarness` bundled that with the feed, so five coarse sites were refetching `/harness/config` as collateral. A media upload, a review change and a cross-agent message cannot change an engine's model, effort or running state, so those five sites keep the feed invalidation they exist for and drop the config one. The reconnect snapshot's `["harness-turns"]` sweep becomes `["harness-queue"]`: the queue rode on the turns response, so that key is what a reconnect after a gap actually needs to re-read.

**Files:**

- Delete: `apps/web/src/components/app/harness/use-harness-turns.ts`, `apps/web/src/components/app/harness/use-harness-turns.test.tsx`
- Modify: `apps/web/src/hooks/use-sse.ts` (plan 2, Task 10 added a `harnessQueueQueryKey` import and an `invalidateHarnessQueue` helper to this file, so its line numbers have shifted)
- Modify: `apps/web/src/hooks/use-sse.test.ts`
- Modify: `apps/web/src/components/app/agent-pane.test.tsx` (only if plan 3, Task 4, Step 1 left its `use-harness-turns` mock behind)

**Interfaces:**

- Consumes: `harnessQueueQueryKey(agentId)` returning `["harness-queue", agentId]` and `invalidateHarnessQueue(queryClient, agentId)`, both from plan 2, Task 10.
- Produces: `apps/web/src/hooks/use-sse.ts` exports `applyChatEntry`, `applyDiffStateChanged`, `applyAgentUpsert`, `applyReviewCreated` and `useSSE`, unchanged. `invalidateChatFeed`, `invalidateHarnessConfig` and `invalidateHarnessQueue` remain private. `invalidateHarnessTurns`, `invalidateHarness` and `invalidateChatFeedAndHarness` no longer exist.

- [ ] **Step 1: Rewrite the seven assertions in the SSE suite**

`apps/web/src/hooks/use-sse.test.ts` asserts through `expectInvalidatedSet`, which checks `expect(keys).toHaveLength(expected.length)`, so each list is the exact set and not a subset. Seven of them name `["harness-turns", …]`.

In `apps/web/src/hooks/use-sse.test.ts`:

**(a)** In `refetches the state a snapshot does not carry and drops injection holds`, replace:

```tsx
      ["chat"],
      ["harness-turns"],
      ["harness-config"],
```

with:

```tsx
      ["chat"],
      ["harness-queue"],
      ["harness-config"],
```

**(b)** In `marks the reviewer submitted and refreshes review state on review.created`, replace:

```tsx
      // The Chat feed carries a card per review.
      ["chat", "author"],
      ["harness-turns", "author"],
      ["harness-config", "author"],
    ]);
  });

  it("still refreshes review state when no reviewer is attributed", () => {
```

with:

```tsx
      // The Chat feed carries a card per review.
      ["chat", "author"],
    ]);
  });

  it("still refreshes review state when no reviewer is attributed", () => {
```

**(c)** In `still refreshes review state when no reviewer is attributed`, replace the same three lines (this is the second occurrence, and it is the last `expectInvalidatedSet` in that case):

```tsx
      // The Chat feed carries a card per review.
      ["chat", "author"],
      ["harness-turns", "author"],
      ["harness-config", "author"],
    ]);
```

with:

```tsx
      // The Chat feed carries a card per review.
      ["chat", "author"],
    ]);
```

**(d)** In `puts a chat.entry straight into the cached feed without a refetch`, replace:

```tsx
// An agent's post moves the sidebar badge and is a turn change for the
// Harness; the feed itself is not refetched.
expectInvalidatedSet(invalidateQueries, [
  ["chat-unread"],
  ["harness-turns", "agt_1"],
]);
```

with:

```tsx
// An agent's post moves the sidebar badge; the feed itself is patched,
// not refetched.
expectInvalidatedSet(invalidateQueries, [["chat-unread"]]);
```

**(e)** In `refetches an agent's chat feed and the sidebar unread summary on chat.changed`, replace:

```tsx
expectInvalidatedSet(invalidateQueries, [
  ["chat", "agt_1"],
  ["chat-unread"],
  ["harness-turns", "agt_1"],
  ["harness-config", "agt_1"],
]);
```

with:

```tsx
expectInvalidatedSet(invalidateQueries, [["chat", "agt_1"], ["chat-unread"]]);
```

**(f)** Replace the whole case `refetches the feed, the harness turns and the queue on harness.changed, and the config only when told` (plan 2, Task 10, Step 5 wrote it) with:

```tsx
it("refetches the feed and the queue on harness.changed, and the config only when told", () => {
  const { emit, invalidateQueries } = renderMessages();
  emit({ type: "harness.changed", agentId: "agt_1" });
  expectInvalidatedSet(invalidateQueries, [
    ["chat", "agt_1"],
    ["harness-queue", "agt_1"],
  ]);
  invalidateQueries.mockClear();
  emit({ type: "harness.changed", agentId: "agt_1", config: true });
  expectInvalidatedSet(invalidateQueries, [
    ["chat", "agt_1"],
    ["harness-queue", "agt_1"],
    ["harness-config", "agt_1"],
  ]);
});
```

**(g)** Replace the whole case `refetches the harness turns for a chat row a feed never fetched, not for a status row` with the same body under a name that says what is left of it, and with its one assertion narrowed:

```tsx
it("moves the unread badge for a chat row a feed never fetched, not for a status row", () => {
  const { emit, invalidateQueries } = renderMessages();
  emit({
    type: "chat.entry",
    agentId: "agt_1",
    entry: {
      type: "chat",
      id: "q1",
      at: "2026-09-02T10:00:02.000Z",
      message: {
        id: "q1",
        agentId: "agt_1",
        authorKind: "agent",
        kind: "question",
        text: "Ship it?",
        replyTo: null,
        question: { options: [] },
        answer: null,
        attachments: [],
        delivered: null,
        readAt: null,
        createdAt: "2026-09-02T10:00:02.000Z",
        updatedAt: "2026-09-02T10:00:02.000Z",
      },
    } as unknown as ChatFeedEntry,
  });
  // No cache to patch, so the row is left to the first fetch; the badge
  // still moves.
  expectInvalidatedSet(invalidateQueries, [["chat-unread"]]);
  invalidateQueries.mockClear();
  emit({
    type: "chat.entry",
    agentId: "agt_1",
    entry: {
      type: "status",
      id: "event:9",
      eventType: "working",
      message: "x",
      at: "2026-09-02T10:00:03.000Z",
    },
  });
  expect(invalidateQueries).not.toHaveBeenCalled();
});
```

**(h)** In `invalidates both ends of a created message and only one on read`, replace:

```tsx
      ["chat", "sender"],
      ["chat", "recipient"],
      ["harness-turns", "sender"],
      ["harness-turns", "recipient"],
      ["harness-config", "sender"],
      ["harness-config", "recipient"],
    ]);
```

with:

```tsx
      ["chat", "sender"],
      ["chat", "recipient"],
    ]);
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-sse.test.ts`

Expected: FAIL, seven failures, each an `expectInvalidatedSet` length mismatch: the code still invalidates the turns key (and, at the coarse sites, the config key) that the assertions no longer list.

- [ ] **Step 3: Take the turns key out of `use-sse.ts`**

In `apps/web/src/hooks/use-sse.ts`:

**(a)** Delete the import line:

```ts
import { harnessTurnsQueryKey } from "@/components/app/harness/use-harness-turns";
```

**(b)** Delete `invalidateHarnessTurns` and its doc comment entirely:

```ts
/**
 * The Harness view assembles its turns from the stream rows and from the
 * chat rows (prompts, agent questions and their answers), so it refetches
 * on every stream write (`harness.changed`), on a chat row event, and on
 * the coarse chat changes reviews, messages, and media announce with.
 */
function invalidateHarnessTurns(
  queryClient: QueryClient,
  agentId: string
): void {
  void queryClient.invalidateQueries({
    queryKey: harnessTurnsQueryKey(agentId),
    exact: true,
  });
}
```

**(c)** Delete both bundles:

```ts
function invalidateHarness(queryClient: QueryClient, agentId: string): void {
  invalidateHarnessTurns(queryClient, agentId);
  invalidateHarnessConfig(queryClient, agentId);
}

function invalidateChatFeedAndHarness(
  queryClient: QueryClient,
  agentId: string
): void {
  invalidateChatFeed(queryClient, agentId);
  invalidateHarness(queryClient, agentId);
}
```

**(d)** In the `snapshot` branch, replace:

```ts
void queryClient.invalidateQueries({ queryKey: ["harness-turns"] });
void queryClient.invalidateQueries({ queryKey: ["harness-config"] });
```

with:

```ts
// The queue is in-memory server state with no event replay, so a
// reconnect after a gap has to read it again. Prefix match: one
// key per agent.
void queryClient.invalidateQueries({ queryKey: ["harness-queue"] });
void queryClient.invalidateQueries({ queryKey: ["harness-config"] });
```

**(e)** In the `chat.entry` branch, delete the turns invalidation and its comment, so the branch reads:

```ts
if (payload.type === "chat.entry") {
  applyChatEntry(queryClient, payload.agentId, payload.entry);
  // Only an agent's post can move the sidebar's unread badges.
  if (
    payload.entry.type === "chat" &&
    payload.entry.message.authorKind === "agent"
  ) {
    void queryClient.invalidateQueries({
      queryKey: CHAT_UNREAD_QUERY_KEY,
    });
  }
  return;
}
```

**(f)** In the `harness.changed` branch, delete the turns invalidation and rewrite the comment, so the branch reads:

```ts
if (payload.type === "harness.changed") {
  // A stream write: the feed reads the stream rows, the queue is
  // server-side. The session config is read again only when the
  // write says it changed (a start, a settle, a switch).
  invalidateChatFeed(queryClient, payload.agentId);
  invalidateHarnessQueue(queryClient, payload.agentId);
  if (payload.config) {
    invalidateHarnessConfig(queryClient, payload.agentId);
  }
  return;
}
```

**(g)** Replace each of the five `invalidateChatFeedAndHarness` calls with `invalidateChatFeed`. They are, in file order:

In the `chat.changed` branch:

```ts
if (payload.type === "chat.changed") {
  invalidateChatFeed(queryClient, payload.agentId);
  void queryClient.invalidateQueries({
    queryKey: CHAT_UNREAD_QUERY_KEY,
  });
  return;
}
```

In the `media.changed` branch, replacing `invalidateChatFeedAndHarness(queryClient, payload.agentId);` with:

```ts
invalidateChatFeed(queryClient, payload.agentId);
```

In the review branch, keeping its comment:

```ts
// The Chat feed renders reviews as cards, with their live status
// and counts — so a new review, and every later change to one,
// has to reach the feed too.
invalidateChatFeed(queryClient, payload.agentId);
```

and rewriting that comment's em-dash out while you are in it, since this plan's copy rule bans them:

```ts
// The Chat feed renders reviews as cards, with their live status
// and counts, so a new review and every later change to one has
// to reach the feed too.
invalidateChatFeed(queryClient, payload.agentId);
```

In the `message.created` branch, both calls:

```ts
invalidateChatFeed(queryClient, payload.senderAgentId);
invalidateChatFeed(queryClient, payload.recipientAgentId);
```

- [ ] **Step 4: Delete the module and its test**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git rm apps/web/src/components/app/harness/use-harness-turns.ts \
       apps/web/src/components/app/harness/use-harness-turns.test.tsx
```

- [ ] **Step 5: Clear the stale mock, if plan 3 left one**

Run: `git grep -n "use-harness-turns" -- apps`

Expected: no output. If `apps/web/src/components/app/agent-pane.test.tsx` still carries this block, plan 3's Task 4 Step 1 did not delete it, and it must go now: a `vi.mock` factory for a module that no longer resolves fails the whole file at collection time.

```tsx
vi.mock("@/components/app/harness/use-harness-turns", () => ({
  harnessTurnsQueryKey: (agentId: string | null) => ["harness-turns", agentId],
  useHarnessTurns: () => ({
    turns: [],
    liveTrace: null,
    liveText: "",
    liveQuestions: [],
    streaming: false,
    queued: [],
    loading: false,
    error: null,
  }),
}));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks src/components/app/harness src/components/app/agent-pane.test.tsx`

Expected: PASS, no failed collections. `use-sse.test.ts` passes all its cases with the seven rewritten sets.

Run: `pnpm run check:web`

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/hooks/use-sse.ts apps/web/src/hooks/use-sse.test.ts apps/web/src/components/app/agent-pane.test.tsx
git commit -m "$(cat <<'EOF'
refactor(web): delete the harness turns query and its invalidations

The turns query was a second cache over agent_stream_events, and five
coarse events refetched it plus the session config alongside the chat
feed. The turn entries in the feed replaced it, so the module goes and
each of those events now invalidates only the feed it actually changed. A
reconnect sweeps the queue key in the turns key's place, since the queue
rode on the turns response.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: A turn's arrival drops the chat row it claims as its prompt

This is the plan's one behavioral change, and the gap plan 2 recorded as its concern 1.

Plan 2, Task 4 stopped `listChatEntries` emitting a chat row that a `turn` row names as its prompt, because the turn renders it. The client, though, already holds that row as a `chat` entry: `useSendChatMessage` appends an optimistic entry under the id it minted, and the send's own `chat.entry` confirms it, both before any turn exists. The turn's `chat.entry` gives `upsertFeedEntry` no reason to remove it. In stages 1 and 2 that self-healed within one flush, because `harness.changed` still refetched the whole feed; Task 3 removes that refetch, so the removal has to happen here or the prompt renders twice, once inside the turn and once above it, until the next unrelated refetch.

The removal belongs inside `upsertFeedEntry` rather than beside it in `applyChatEntry`. `upsertFeedEntry` is the one writer of the cached pages for a `chat.entry`, and its contract is to make those pages agree with the entry; the server's rule that a claimed prompt row is not an entry of its own is part of that agreement. Doing it in `applyChatEntry` would mean two `setQueryData` calls for one event, and would leave a `placed: false` entry (the millisecond-tie and below-the-head bails) with a half-applied cache instead of an untouched one.

**Files:**

- Modify: `apps/web/src/hooks/use-chat.ts`
- Test: `apps/web/src/hooks/use-chat.test.tsx`, `apps/web/src/hooks/use-sse.test.ts`

**Interfaces:**

- Consumes: `ChatTurnEntry` from `@dispatch/shared` (plan 2, Task 2).
- Produces: `upsertFeedEntry(cache: FeedCache, entry: ChatFeedEntry): FeedUpsert`, same signature and same `FeedUpsert` shape. New behavior: when `entry.type === "turn"` and `entry.prompt.chatMessageId` is set, any `chat` entry with that id is removed from every cached page before the turn is placed. `withoutTurnPrompt` and `placeEntry` are private.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/hooks/use-chat.test.tsx`, add `ChatTurnEntry` to the type import block at the top:

```tsx
import type {
  ChatAnswerResponse,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMessage,
  ChatTurnEntry,
} from "@dispatch/shared";
```

Inside `describe("upsertFeedEntry", ...)`, add this fixture beside the existing `status` helper:

```tsx
const turnEntry = (
  chatMessageId: string | undefined,
  when: string
): ChatTurnEntry => ({
  type: "turn",
  id: "turn:12",
  agentId: "agt_1",
  at: when,
  updatedAt: when,
  prompt: {
    source: "chat",
    text: "read the readme",
    ...(chatMessageId ? { chatMessageId } : {}),
    attachments: [],
  },
  trace: { startedAt: when, steps: [] },
  result: null,
  settled: false,
  interrupted: false,
});
```

and add these three cases at the end of the same describe:

```tsx
it("drops the chat row a turn claims as its prompt", () => {
  const prompt = chat(
    message({ id: "p1", authorKind: "user", createdAt: at(1) })
  );
  const other = status("event:2", at(2));
  const cache: FeedCache = {
    pageParams: [undefined],
    pages: [page([prompt, other])],
  };
  const result = upsertFeedEntry(cache, turnEntry("p1", at(3)));
  expect(result.placed).toBe(true);
  expect(result.cache.pages[0]!.entries.map((e) => e.id)).toEqual([
    "event:2",
    "turn:12",
  ]);
});

it("drops a prompt row from an older page as its turn grows", () => {
  const prompt = chat(
    message({ id: "p1", authorKind: "user", createdAt: at(1) })
  );
  const live = turnEntry("p1", at(3));
  const cache: FeedCache = {
    pageParams: [undefined, "c1"],
    pages: [page([live], { hasMore: true, nextCursor: "c1" }), page([prompt])],
  };
  const result = upsertFeedEntry(cache, {
    ...live,
    updatedAt: at(9),
    result: { text: "It documents the CLI.", streaming: false },
  });
  expect(result.placed).toBe(true);
  expect(result.cache.pages[1]!.entries).toEqual([]);
  const grown = result.cache.pages[0]!.entries[0]!;
  expect(grown.type === "turn" ? grown.result?.text : null).toBe(
    "It documents the CLI."
  );
});

it("leaves every other chat row alone, and a turn with no chat prompt", () => {
  const keep = chat(
    message({ id: "p2", authorKind: "user", createdAt: at(1) })
  );
  const cache: FeedCache = {
    pageParams: [undefined],
    pages: [page([keep])],
  };
  const injected = upsertFeedEntry(cache, {
    ...turnEntry(undefined, at(3)),
    prompt: {
      source: "system",
      text: "Rename yourself to match the work you are doing.",
      attachments: [],
    },
  });
  expect(injected.cache.pages[0]!.entries.map((e) => e.id)).toEqual([
    "p2",
    "turn:12",
  ]);
});
```

In `apps/web/src/hooks/use-sse.test.ts`, add this case immediately after `falls back to a refetch for a chat.entry it cannot place`:

```tsx
it("drops a turn's prompt row from the cache when the turn arrives", () => {
  const { queryClient, emit, invalidateQueries } = renderMessages();
  queryClient.setQueryData(["chat", "agt_1"], {
    pageParams: [undefined],
    pages: [
      {
        entries: [
          {
            type: "chat",
            id: "11111111-1111-4111-8111-111111111111",
            at: "2026-09-02T10:00:01.000Z",
            message: {
              id: "11111111-1111-4111-8111-111111111111",
              agentId: "agt_1",
              authorKind: "user",
              kind: "reply",
              text: "read the readme",
              replyTo: null,
              question: null,
              answer: null,
              attachments: [],
              delivered: true,
              readAt: null,
              createdAt: "2026-09-02T10:00:01.000Z",
              updatedAt: "2026-09-02T10:00:01.000Z",
            },
          },
        ],
        hasMore: false,
        nextCursor: null,
        unreadCount: 0,
      },
    ],
  });

  emit({
    type: "chat.entry",
    agentId: "agt_1",
    entry: {
      type: "turn",
      id: "turn:12",
      agentId: "agt_1",
      at: "2026-09-02T10:00:02.000Z",
      updatedAt: "2026-09-02T10:00:02.000Z",
      prompt: {
        source: "chat",
        text: "read the readme",
        chatMessageId: "11111111-1111-4111-8111-111111111111",
        attachments: [],
      },
      trace: { startedAt: "2026-09-02T10:00:02.000Z", steps: [] },
      result: null,
      settled: false,
      interrupted: false,
    } as unknown as ChatFeedEntry,
  });

  // The turn renders the prompt, so the row it claimed is gone and the
  // feed is patched rather than refetched.
  const cache = queryClient.getQueryData<{
    pages: { entries: { id: string }[] }[];
  }>(["chat", "agt_1"]);
  expect(cache?.pages[0]?.entries.map((e) => e.id)).toEqual(["turn:12"]);
  expect(invalidateQueries).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-chat.test.tsx src/hooks/use-sse.test.ts`

Expected: FAIL, three failures. `drops the chat row a turn claims as its prompt` reports `["p1", "event:2", "turn:12"]`; `drops a prompt row from an older page as its turn grows` reports one entry on page 1 instead of none; `drops a turn's prompt row from the cache when the turn arrives` reports `["11111111-1111-4111-8111-111111111111", "turn:12"]`. `leaves every other chat row alone` already passes.

- [ ] **Step 3: Prune before placing**

In `apps/web/src/hooks/use-chat.ts`, replace the whole exported `upsertFeedEntry` declaration line and its doc comment:

```ts
/**
 * Put one feed row (from a `chat.entry` event) into the cached pages: in
 * place when its id is already here, otherwise into the newest page at its
 * position by time. The unread count follows agent messages that arrive
 * unread. Identity is preserved everywhere the data did not change, so the
 * rows that did not move do not re-render.
 */
export function upsertFeedEntry(
  cache: FeedCache,
  entry: ChatFeedEntry
): FeedUpsert {
  const newest = cache.pages[0];
```

with:

```ts
/**
 * The chat row a turn names as its prompt is rendered by the turn, and the
 * server stops listing it as a `chat` entry once the turn row exists. A
 * client that saw the row first, from its own send, holds both, so the
 * turn's arrival is where the duplicate goes. The unread count is left
 * alone: a prompt row is the user's own and was never counted.
 */
function withoutTurnPrompt(cache: FeedCache, entry: ChatFeedEntry): FeedCache {
  if (entry.type !== "turn") return cache;
  const promptId = entry.prompt.chatMessageId;
  if (promptId === undefined) return cache;
  let changed = false;
  const pages = cache.pages.map((page) => {
    const entries = page.entries.filter(
      (existing) => !(existing.type === "chat" && existing.id === promptId)
    );
    if (entries.length === page.entries.length) return page;
    changed = true;
    return { ...page, entries };
  });
  return changed ? { ...cache, pages } : cache;
}

/**
 * Put one feed row (from a `chat.entry` event) into the cached pages: in
 * place when its id is already here, otherwise into the newest page at its
 * position by time. The unread count follows agent messages that arrive
 * unread. Identity is preserved everywhere the data did not change, so the
 * rows that did not move do not re-render.
 */
export function upsertFeedEntry(
  cache: FeedCache,
  entry: ChatFeedEntry
): FeedUpsert {
  return placeEntry(withoutTurnPrompt(cache, entry), entry);
}

function placeEntry(cache: FeedCache, entry: ChatFeedEntry): FeedUpsert {
  const newest = cache.pages[0];
```

Nothing else in the function body changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-chat.test.tsx src/hooks/use-sse.test.ts`

Expected: PASS, every case in both files.

Run: `pnpm run check:web`

Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/hooks/use-chat.ts apps/web/src/hooks/use-chat.test.tsx apps/web/src/hooks/use-sse.test.ts
git commit -m "$(cat <<'EOF'
fix(web): drop a turn's prompt row from the cached feed

The server stops listing a chat row a turn claims as its prompt, but the
client already held that row from its own send, so the prompt rendered
twice until some later event refetched the feed. upsertFeedEntry now
prunes the claimed row before placing the turn. Nothing can put it back:
the send's success path only replaces rows the cache already holds.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: A streamed chunk costs one row, not a page

With Task 2 in place, the `harness.changed` feed invalidation is the last thing making a streamed chunk refetch the whole feed. The turn's own `chat.entry`, published once per recorder flush by `ChatService.publishTurnEntry` (plan 2, Task 6), carries the whole entry, and `applyChatEntry` places it. The branch keeps its two other duties: the queue, and the session config when the write says it changed.

**Files:**

- Modify: `apps/web/src/hooks/use-sse.ts`
- Modify: `packages/shared/src/chat-types.ts` (the event's doc comment)
- Modify: `apps/server/src/chat/service.ts` (`publishHarnessChanged`'s doc comment)
- Test: `apps/web/src/hooks/use-sse.test.ts`

**Interfaces:**

- Consumes: `invalidateHarnessQueue` and `invalidateHarnessConfig`, both private in `use-sse.ts`.
- Produces: no exported change. `HarnessChangedEvent`'s shape is untouched; `harness.changed` no longer invalidates `chatFeedQueryKey(agentId)`.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/hooks/use-sse.test.ts`, replace the whole case Task 1 Step 1(f) left behind:

```tsx
it("refetches the feed and the queue on harness.changed, and the config only when told", () => {
  const { emit, invalidateQueries } = renderMessages();
  emit({ type: "harness.changed", agentId: "agt_1" });
  expectInvalidatedSet(invalidateQueries, [
    ["chat", "agt_1"],
    ["harness-queue", "agt_1"],
  ]);
  invalidateQueries.mockClear();
  emit({ type: "harness.changed", agentId: "agt_1", config: true });
  expectInvalidatedSet(invalidateQueries, [
    ["chat", "agt_1"],
    ["harness-queue", "agt_1"],
    ["harness-config", "agt_1"],
  ]);
});
```

with:

```tsx
it("leaves the feed alone on harness.changed, refetching the queue and the config only when told", () => {
  // The turn the write changed arrives as its own `chat.entry`, which is
  // one row upsert; refetching the feed per streamed chunk is what this
  // event used to cost.
  const { emit, invalidateQueries } = renderMessages();
  emit({ type: "harness.changed", agentId: "agt_1" });
  expectInvalidatedSet(invalidateQueries, [["harness-queue", "agt_1"]]);
  invalidateQueries.mockClear();
  emit({ type: "harness.changed", agentId: "agt_1", config: true });
  expectInvalidatedSet(invalidateQueries, [
    ["harness-queue", "agt_1"],
    ["harness-config", "agt_1"],
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-sse.test.ts`

Expected: FAIL, one failure: `leaves the feed alone on harness.changed` reports two keys where one was expected, the extra being `["chat", "agt_1"]`.

- [ ] **Step 3: Stop refetching the feed**

In `apps/web/src/hooks/use-sse.ts`, replace the whole `harness.changed` branch:

```ts
if (payload.type === "harness.changed") {
  // A stream write: the feed reads the stream rows, the queue is
  // server-side. The session config is read again only when the
  // write says it changed (a start, a settle, a switch).
  invalidateChatFeed(queryClient, payload.agentId);
  invalidateHarnessQueue(queryClient, payload.agentId);
  if (payload.config) {
    invalidateHarnessConfig(queryClient, payload.agentId);
  }
  return;
}
```

with:

```ts
if (payload.type === "harness.changed") {
  // A stream write. The turn it changed arrives as its own
  // `chat.entry` carrying the whole entry, so the feed is patched
  // and not refetched. The queue is in-memory server state, and
  // the session config is read again only when the write says it
  // changed (a start, a settle, a switch).
  invalidateHarnessQueue(queryClient, payload.agentId);
  if (payload.config) {
    invalidateHarnessConfig(queryClient, payload.agentId);
  }
  return;
}
```

- [ ] **Step 4: Say what the event costs, on both sides of the wire**

Three doc comments describe the duties this step removed. Neither plan 2 nor plan 3 touches any of them.

In `packages/shared/src/chat-types.ts`, replace `HarnessChangedEvent`'s comment:

```ts
/**
 * A Dispatch Harness stream write: an assistant chunk, a tool call, a
 * turn boundary, a queue change. The feed and the Harness turns refetch;
 * `config` marks the writes that also change the session's model,
 * effort, or running state (a session start, a settle, a switch), so a
 * client refetches that only then, not on every chunk.
 */
```

with:

```ts
/**
 * A Dispatch Harness stream write: an assistant chunk, a tool call, a
 * turn boundary, a queue change. The turn it changed is published as its
 * own `chat.entry`, so this event only refetches the queue; `config`
 * marks the writes that also change the session's model, effort, or
 * running state (a session start, a settle, a switch), so a client
 * refetches that only then, not on every chunk.
 */
```

In `apps/server/src/chat/service.ts`, replace `publishHarnessChanged`'s comment:

```ts
/**
 * A Dispatch Harness stream write. The feed reads the stream rows and the
 * Harness view its turns; `config` also refreshes the session's model,
 * effort, and running state, which a chunk does not change.
 */
```

with:

```ts
/**
 * A Dispatch Harness stream write. The turn itself travels as a
 * `chat.entry` from `publishTurnEntry`; this event carries the queue,
 * and `config` also refreshes the session's model, effort, and running
 * state, which a chunk does not change.
 */
```

In `apps/server/src/agents/harness/supervisor.ts`, replace the `publishHarness` field's comment:

```ts
/**
 * ChatService.publishHarnessChanged: the feed and the Harness view re-read
 * after each stream write; `config` marks a session start, settle, or
 * option switch, when the session config is worth re-reading too.
 */
```

with:

```ts
/**
 * ChatService.publishHarnessChanged: the queue is re-read after each
 * stream write, and the turn itself is published separately as a feed
 * row; `config` marks a session start, settle, or option switch, when
 * the session config is worth re-reading too.
 */
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks`

Expected: PASS, every case.

Run: `pnpm run check`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/hooks/use-sse.ts apps/web/src/hooks/use-sse.test.ts packages/shared/src/chat-types.ts apps/server/src/chat/service.ts apps/server/src/agents/harness/supervisor.ts
git commit -m "$(cat <<'EOF'
perf(web): stop refetching the chat feed per streamed chunk

harness.changed fires on every recorder flush, up to ten times a second
during a turn, and each one refetched the whole feed page. The turn it
changed now arrives as its own chat.entry carrying the whole entry, so a
chunk costs one row upsert. The event keeps the queue and the conditional
session-config reads, which no row event covers.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `GET /api/v1/agents/:id/harness/turns` and `loadTurns` go

The route is the only caller of `loadTurns`, `loadTurns` is the only user of `DEFAULT_LIMIT` and `MAX_LIMIT` in `harness-routes.ts`, and the route body is the only user of the `HarnessTurnsResponse` type import. `loadChatMessages` stays: `loadQueued` and `listTurnEntries` both call it.

**Files:**

- Modify: `apps/server/src/routes/agents/harness-routes.ts`
- Modify: `apps/server/src/chat/turns.ts` (moved there by plan 2, Task 2)
- Test: `apps/server/test/harness-routes.test.ts`

**Interfaces:**

- Consumes: `GET /api/v1/agents/:id/harness/queue` returning `200 { queued: HarnessQueuedPrompt[] }` (plan 2, Task 5), which the new case uses as the control.
- Produces: `apps/server/src/chat/turns.ts` no longer exports `loadTurns`. `apps/server/src/routes/agents/harness-routes.ts` registers nine routes and no others: `GET /harness/config`, `PUT /harness/config`, `GET /harness/queue`, `POST /harness/queue/:queuedId/send-now`, `DELETE /harness/queue/:queuedId`, `POST /harness/interrupt`, `GET /harness/commands`, `GET /harness/usage`, `GET /harness/paths`.

- [ ] **Step 1: Write the failing test**

In `apps/server/test/harness-routes.test.ts`, replace the whole first block, from `describe("GET /api/v1/agents/:id/harness/turns", () => {` through its closing `});` (it is the block whose second case is `returns assembled turns with the chat prompt joined`), with:

```ts
describe("the retired turns route", () => {
  // The turns endpoint was the second reader of agent_stream_events; the
  // chat feed's `turn` entries replaced it. The queue route is the control:
  // it proves the 404 is this route's absence and not a broken prefix.
  it("404s where the queue route on the same prefix still answers", async () => {
    const turns = await authedGet(`/api/v1/agents/${agentId}/harness/turns`);
    expect(turns.statusCode).toBe(404);
    const queue = await authedGet(`/api/v1/agents/${agentId}/harness/queue`);
    expect(queue.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-routes.test.ts`

Expected: FAIL, one failure in `the retired turns route`: the turns request answers `200`, not `404`.

- [ ] **Step 3: Delete the route**

In `apps/server/src/routes/agents/harness-routes.ts`:

**(a)** Drop `HarnessTurnsResponse` from the type import, leaving (plan 2, Task 5 added `HarnessQueueResponse` to this list):

```ts
import type {
  HarnessCommandsResponse,
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
  HarnessPathsResponse,
  HarnessQueueResponse,
} from "@dispatch/shared";
```

**(b)** Change the runtime import from:

```ts
import { loadQueued, loadTurns } from "../../chat/turns.js";
```

to:

```ts
import { loadQueued } from "../../chat/turns.js";
```

**(c)** Delete the two now-unused constants:

```ts
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
```

**(d)** Replace the file's one doc comment:

```ts
/** The Harness view's routes: turns and the queue, session config, commands, usage, paths. */
```

with:

```ts
/** A Dispatch Harness agent's routes: the queue, session config, commands, usage, paths. */
```

**(e)** Delete the whole handler:

```ts
app.get("/api/v1/agents/:id/harness/turns", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  const raw = (request.query as { limit?: string }).limit;
  let limit = DEFAULT_LIMIT;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return reply.code(400).send({ error: "limit must be a number." });
    }
    limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
  }
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  const response: HarnessTurnsResponse = {
    turns: await loadTurns(deps.pool, id, limit),
    queued: await loadQueued(deps.pool, deps.harness.listQueued(id)),
  };
  return response;
});
```

The `GET /harness/queue` handler plan 2 added sits immediately below it and keeps `loadQueued` and `deps.harness.listQueued` in use.

- [ ] **Step 4: Delete `loadTurns`**

In `apps/server/src/chat/turns.ts`, delete the whole function, from its doc comment (plan 2, Task 3, Step 3 gave it the second paragraph) through the closing `}` immediately above `/** The chat messages behind chat-sourced prompts, by id. */`:

```ts
/**
 * The newest `limit` turns for an agent, with their chat prompts joined.
 *
 * Only `GET /api/v1/agents/:id/harness/turns` still reads this; the feed
 * reads {@link listTurnEntries}. Plan 4 of the one-feed work deletes both.
 */
export async function loadTurns(
```

Everything through that function's closing brace goes. Leave `loadChatMessages`, `loadQueued`, `locationsFromInput`, `groupTurnRows`, `assembleTurns`, `toTurnEntry`, `listTurnEntries` and `loadLatestTurnEntry` alone.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-routes.test.ts test/chat-feed.test.ts test/harness-turns.test.ts`

Expected: PASS, all three files. `harness-routes.test.ts` reports the new `the retired turns route` case and plan 2's two `GET /api/v1/agents/:id/harness/queue` cases.

Run: `pnpm --filter @dispatch/server check`

Expected: no output, exit 0. A `TS6133` or `TS2304` here means one of (a) to (d) was missed.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/routes/agents/harness-routes.ts apps/server/src/chat/turns.ts apps/server/test/harness-routes.test.ts
git commit -m "$(cat <<'EOF'
refactor(server): delete the harness turns endpoint

Two readers walked agent_stream_events and produced different shapes: the
chat feed's turn entries and this endpoint's HarnessTurn objects. The feed
serves a dispatch agent's turns now, so the route and loadTurns go and
loadQueued keeps the queue route it was already sharing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The assembler's shape stops being a wire type

With `loadTurns` gone, `HarnessTurn` has exactly two users left: `assembleTurns`'s return type and `toTurnEntry`'s parameter, both inside `apps/server/src/chat/turns.ts`. Nothing crosses the wire in that shape any more.

**The decision, and why.** `assembleTurns` keeps an intermediate type, and that type becomes a local `AssembledTurn` in `chat/turns.ts` rather than a shared one. It does not produce `ChatTurnEntry` directly, because it cannot: `ChatTurnEntry` needs `agentId`, `at`, `updatedAt`, `settled` and `interrupted`, all of which `toTurnEntry` derives from the group's rows and the caller's agent id, and one of which (`interrupted`) depends on the restart-marker rule. Folding that into a 140-line loop that shapes view data would put two responsibilities in one function and rewrite the 20-case suite that guards it. Keeping the shape and moving it costs one type declaration and eight identifier swaps, and the existing suite stays a valid gate. Its questions also stay `HarnessQuestion[]`: `toTurnEntry` reads `answer !== null` off them to build each `ChatTurnQuestionRef`, so the full question is what the assembler has to produce.

`HarnessQuestion` therefore stays in `@dispatch/shared` even though no wire message carries it after this task. It is still a live function's parameter and return type (`toQuestion`), so it is not dead code; moving it into the server would be a tidiness change with no behavior, and the brief's delete list does not name it. Its doc comment is corrected instead.

`HarnessStepStatus` has no user at all outside `harness-types.ts` itself, so it goes with the alias plan 2 made of it.

**Files:**

- Modify: `apps/server/src/chat/turns.ts`
- Modify: `packages/shared/src/harness-types.ts`, `packages/shared/src/index.ts`
- Rename: `apps/server/test/harness-turns.test.ts` to `apps/server/test/chat-turns.test.ts` (plan 2's concern 6)

**Interfaces:**

- Consumes: `ChatTurnStep`, `ChatTurnPlanEntry`, `ChatTurnEntry`, `ChatTurnQuestionRef`, `HarnessPrompt`, `HarnessQuestion`, `HarnessQueuedPrompt` from `@dispatch/shared`.
- Produces, from `apps/server/src/chat/turns.ts`:

```ts
export type AssembledTurn = {
  id: string;
  prompt: HarnessPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error" | "interrupted";
    steps: ChatTurnStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
  questions?: HarnessQuestion[];
  label?: string;
  plan?: ChatTurnPlanEntry[];
  usage?: { used: number; size: number; costUsd: number | null };
};

export function assembleTurns(
  rows: TurnSourceRow[],
  chat: Map<string, ChatMessage>,
  questions?: ChatMessage[]
): AssembledTurn[];

export function toTurnEntry(
  turn: AssembledTurn,
  group: TurnGroup,
  agentId: string
): ChatTurnEntry;
```

- Produces, from `@dispatch/shared`: `HarnessTurn`, `HarnessTurnsResponse`, `HarnessStep`, `HarnessStepStatus` and `HarnessPlanEntry` no longer exist. Every other harness type is unchanged.

**This task changes no behavior, so there is no failing test to write first.** Its gates are `pnpm run check` and the renamed 20-case assembly suite, which must pass unchanged.

- [ ] **Step 1: Prove nothing outside `chat/turns.ts` still names the five types**

Run:

```bash
cd /home/nii/.dispatch/server-dsh-harness
git grep -n "HarnessTurn\b\|HarnessTurnsResponse\|HarnessStep\b\|HarnessStepStatus\|HarnessPlanEntry" -- apps e2e packages
```

Expected, and nothing else:

- `apps/server/src/chat/turns.ts`: the `HarnessPlanEntry`, `HarnessStep` and `HarnessTurn` type imports, and their eight uses (`toolStep`'s return, `noteStep`'s return, `nestSteps`'s parameter, its `byKey` map, its `top` array, `planEntriesOf`'s return, the `flat` array's `step` field, `assembleTurns`'s return, `HarnessTurn["result"]`, `HarnessTurn["trace"]`, `toTurnEntry`'s parameter)
- `packages/shared/src/harness-types.ts`: the five declarations and their internal references
- `packages/shared/src/index.ts`: the five export entries

Any other hit is a name still in use. Stop and report it rather than deleting the type: the most likely candidate is `apps/web/src/components/app/chat/turn/registry.ts`, which imports `HarnessPlanEntry` for `latestPlanItems` and should have lost that import when plan 3's Task 1 deleted that function. If it did not, change its import to `ChatTurnPlanEntry` from `@dispatch/shared` in this task and say so in the commit body.

- [ ] **Step 2: Rename the assembly suite to match its module**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git mv apps/server/test/harness-turns.test.ts apps/server/test/chat-turns.test.ts
```

Its contents need no edit: plan 2, Task 2 already pointed its import at `../src/chat/turns.js`, and it names none of the five types.

- [ ] **Step 3: Run the renamed suite to verify the rename is clean**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-turns.test.ts`

Expected: PASS, 20 tests across `assembleTurns`, `assembleTurns with agent questions`, `assembleTurns labels`, `loadQueued` and `assembleTurns thinking`.

- [ ] **Step 4: Give the assembler its own type**

In `apps/server/src/chat/turns.ts`:

**(a)** Replace the `@dispatch/shared` type import (plan 2, Task 2, Step 8 wrote this block):

```ts
import type {
  ChatMessage,
  ChatTurnEntry,
  ChatTurnQuestionRef,
  HarnessPlanEntry,
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQuestion,
  HarnessStep,
  HarnessTurn,
} from "@dispatch/shared";
```

with:

```ts
import type {
  ChatMessage,
  ChatTurnEntry,
  ChatTurnPlanEntry,
  ChatTurnQuestionRef,
  ChatTurnStep,
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQuestion,
} from "@dispatch/shared";
```

**(b)** Immediately after the `TurnSourceRow` declaration, add:

```ts
/**
 * A turn as the assembler shapes it, on the way to the feed entry
 * `toTurnEntry` frames from it. Not a wire type: `toTurnEntry` is its only
 * reader, and it carries each question whole because the entry needs the
 * answer state off it.
 */
export type AssembledTurn = {
  id: string;
  prompt: HarnessPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    /** `interrupted`: the turn was cancelled (Stop, Ctrl+C, Send now). */
    finalResult?: "ok" | "error" | "interrupted";
    steps: ChatTurnStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
  /** Questions the agent asked during this turn, oldest first. */
  questions?: HarnessQuestion[];
  /**
   * What the turn did, in the agent's own words: the message of the last
   * dispatch_event it sent during the turn ("Answered README question").
   * Absent when the agent sent none.
   */
  label?: string;
  /** The task list as the engine last published it during this turn. */
  plan?: ChatTurnPlanEntry[];
  /** Context used and, where the engine reports it, cost so far in this session. */
  usage?: { used: number; size: number; costUsd: number | null };
};
```

**(c)** Swap the eight identifiers. `HarnessStep` becomes `ChatTurnStep`:

```ts
function toolStep(row: TurnSourceRow): ChatTurnStep | null {
```

```ts
): ChatTurnStep {
```

```ts
  flat: { step: ChatTurnStep; key: string | null; parent: string | null }[]
): ChatTurnStep[] {
  const byKey = new Map<string, ChatTurnStep>();
```

```ts
const top: ChatTurnStep[] = [];
```

```ts
step: ChatTurnStep;
```

`HarnessPlanEntry` becomes `ChatTurnPlanEntry`:

```ts
function planEntriesOf(row: TurnSourceRow): ChatTurnPlanEntry[] {
  const p = row.payload as Partial<PlanPayload>;
  return (p.entries ?? []).map((e) => ({
    content: e.content,
    status: e.status as ChatTurnPlanEntry["status"],
    priority: e.priority as ChatTurnPlanEntry["priority"],
  }));
}
```

```ts
let plan: ChatTurnPlanEntry[] | undefined;
```

`HarnessTurn` becomes `AssembledTurn`:

```ts
): AssembledTurn[] {
```

```ts
let result: AssembledTurn["result"] = null;
```

```ts
const trace: AssembledTurn["trace"] = { startedAt, steps };
```

```ts
export function toTurnEntry(
  turn: AssembledTurn,
```

- [ ] **Step 5: Delete the five shared names**

In `packages/shared/src/harness-types.ts`:

**(a)** Replace line 1 (plan 2, Task 2, Step 4 grew it to five names):

```ts
import type {
  ChatAttachment,
  ChatQuestionOption,
  ChatTurnPlanEntry,
  ChatTurnStep,
  ChatTurnStepStatus,
} from "./chat-types.js";
```

with:

```ts
import type { ChatAttachment, ChatQuestionOption } from "./chat-types.js";
```

**(b)** Replace the file's header comment:

```ts
/**
 * The Harness view's wire types: a stream-driven agent's activity cut into
 * turns. Assembled server-side from `agent_stream_events`; the web maps
 * them onto the PromptKit turn model it renders.
 */
```

with:

```ts
/**
 * A Dispatch Harness agent's wire types that are not feed entries: the
 * prompt and queue shapes, the engine table, session config, the engine's
 * slash commands, usage and the "@" path picker. A turn itself is a
 * `ChatTurnEntry` in `chat-types.ts`.
 */
```

**(c)** Delete the step aliases plan 2 left, comment and all:

```ts
/**
 * The step and plan shapes now live in `chat-types.ts`, because a `turn`
 * feed entry carries them and `chat-types.ts` must not depend on this
 * file. These aliases keep the Harness view's names working; plan 4 of
 * the one-feed work removes them with `HarnessTurn`.
 */
export type HarnessStepStatus = ChatTurnStepStatus;
export type HarnessStep = ChatTurnStep;
```

**(d)** Replace `HarnessQuestion`'s doc comment, which describes a pane this work deleted:

```ts
/**
 * A question the agent posted through dispatch_chat_post during the turn:
 * it lives in the Chat feed, which a harness agent's pane does not show,
 * so the Harness view carries it on the turn with its answer state.
 */
```

with:

```ts
/**
 * A question the agent posted through dispatch_chat_post during a turn, as
 * the server's assembler carries it. The card renders as a `chat` entry in
 * time order; the turn entry keeps only a `ChatTurnQuestionRef`, whose
 * answered flag comes off this shape.
 */
```

**(e)** Delete the whole `HarnessTurn` declaration, from `export type HarnessTurn = {` through its closing `};`. It sits between `HarnessQuestion` and `HarnessQueuedPrompt`'s doc comment.

**(f)** Delete the plan-entry alias plan 2 left:

```ts
/** One entry of the agent's task list; see `ChatTurnPlanEntry`. */
export type HarnessPlanEntry = ChatTurnPlanEntry;
```

**(g)** Delete the turns response, whose route Task 4 removed:

```ts
export type HarnessTurnsResponse = {
  turns: HarnessTurn[];
  /** What waits behind the live turn, first to run first. */
  queued: HarnessQueuedPrompt[];
};
```

In `packages/shared/src/index.ts`, remove the five entries from the `from "./harness-types.js"` type export list, leaving it as (plan 2, Task 5 added `HarnessQueueResponse`):

```ts
export type {
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQueueResponse,
  UsageBudgets,
  UsageBudgetsResponse,
  HarnessQuestion,
  HarnessPath,
  HarnessPathsResponse,
  HarnessConfigChoice,
  HarnessConfigGroup,
  HarnessConfigOption,
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
  HarnessEngineId,
  HarnessEngine,
  HarnessCommand,
  HarnessCommandsResponse,
  HarnessUsageAgent,
  HarnessUsageEngine,
  HarnessUsageReport,
} from "./harness-types.js";
```

- [ ] **Step 6: Type check and run the affected suites**

Run: `pnpm run check`

Expected: exit 0. A `TS2305` ("Module '@dispatch/shared' has no exported member") names an importer Step 1's grep missed; fix that importer rather than restoring the type.

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-turns.test.ts test/chat-feed.test.ts test/harness-routes.test.ts`

Expected: PASS, all three files, 20 tests in `chat-turns.test.ts`.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/chat/turns.ts apps/server/test/chat-turns.test.ts apps/server/test/harness-turns.test.ts packages/shared/src/harness-types.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
refactor(shared): delete the HarnessTurn wire types

No wire message carries a turn in the HarnessTurn shape since the turns
endpoint went: the feed carries ChatTurnEntry. The assembler keeps an
intermediate shape because toTurnEntry derives the entry's agent id,
timestamps and settled state from the group, but that shape is now a local
AssembledTurn, and the step and plan aliases go with it. The assembly
suite is renamed after the module it tests.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The last leftovers

`ResultText` was exported for `turn-stream.tsx`, which rendered a live turn's growing text outside `ResultTurn`. Plan 3 deleted that file, and plan 2's `TurnEntryView` renders the live text through `ResultTurn` itself, so the only callers left are the two inside `result-turn.tsx`. This is plan 3's concern 7.

**`turnLabelFromSteps` in `chat/turn/registry.ts` is not a leftover.** It lost an importer when Task 1 deleted `use-harness-turns.ts`, but plan 2's `TurnEntryView` calls it for the collapsed activity rail's verb. Deleting it would make every unlabeled turn's fold read "done", so it and its test cases stay exactly as they are.

**Files:**

- Modify: `apps/web/src/components/app/chat/turn/result-turn.tsx` (moved there by plan 2, Task 7)

**Interfaces:**

- Produces: `apps/web/src/components/app/chat/turn/result-turn.tsx` exports only `ResultTurn`. `ResultText` becomes private.

- [ ] **Step 1: Prove nothing outside the file imports it**

Run:

```bash
cd /home/nii/.dispatch/server-dsh-harness
git grep -n "ResultText" -- apps
```

Expected, and nothing else: `apps/web/src/components/app/chat/turn/result-turn.tsx`, three hits (the two call sites in `ResultTurnImpl` and the declaration). Any other hit means it still has a consumer; leave the export and record it.

- [ ] **Step 2: Unexport it**

In `apps/web/src/components/app/chat/turn/result-turn.tsx`, replace:

```tsx
export function ResultText({
```

with:

```tsx
function ResultText({
```

- [ ] **Step 3: Run the turn suite and the lint**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat`

Expected: PASS, every file under `chat/` and `chat/turn/`.

Run: `pnpm run lint:web`

Expected: exit 0, no `no-unused-vars` for `ResultText` (it has two callers in the file).

- [ ] **Step 4: Confirm the parallel path is gone**

Run:

```bash
cd /home/nii/.dispatch/server-dsh-harness
git grep -n "harnessTurnsQueryKey\|use-harness-turns\|HarnessTurn\b\|HarnessTurnsResponse\|HarnessStep\b\|HarnessStepStatus\|HarnessPlanEntry\|harness/turns\|loadTurns" -- apps e2e packages bin scripts
```

Expected: **no output.** Every one of those names is gone from the shipping tree. Hits under `docs/` are the specs and the four plans describing the work and are expected; the command above does not search them.

Run:

```bash
git grep -n "invalidateHarnessTurns\|invalidateChatFeedAndHarness\|invalidateHarness(" -- apps
```

Expected: **no output.**

Run:

```bash
git grep -n "harness-turns" -- apps e2e
```

Expected: **no output.** A hit in `apps/web/src/hooks/use-sse.test.ts` means Task 1 Step 1 missed one of its seven assertions.

- [ ] **Step 5: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/components/app/chat/turn/result-turn.tsx
git commit -m "$(cat <<'EOF'
refactor(web): stop exporting ResultText

Its only outside caller was the turn stream that rendered a live turn's
text beside the rail. TurnEntryView renders that text through ResultTurn,
so the helper is private to its own file again.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The release note, the runbook, and the last "Harness view"

`release-notes/current.md` describes the Dispatch Harness as an unreleased feature under a `### Dispatch Harness` heading. Two clauses in its first bullet describe surfaces this work replaced: the feature no longer renders in a "Harness view", and it is no longer opted into through Settings, Agent types. The runbook has two more of the same kind, one sentence of Settings copy names the view, and one hook's doc comment says the pane picks the view from the agent type, which plan 3 ended. Nothing here changes the version or cuts a release.

**Files:**

- Modify: `release-notes/current.md`
- Modify: `docs/10-operations-runbook.md`
- Modify: `apps/web/src/components/app/usage-budget-settings.tsx`
- Modify: `apps/web/src/hooks/use-agent-pane-view.ts`

**Interfaces:** none. No component, prop, testid or export changes.

- [ ] **Step 1: Correct the harness bullet and add the fold**

In `release-notes/current.md`, replace this bullet:

```markdown
- **Dispatch Harness**: a `dispatch` agent type that runs a coding agent as a child process over the Agent Client Protocol and renders the session as turns in the new **Harness** view: prompt line, a collapsible activity rail per turn (tool calls with output, diffs, locations, live timers, nested subagent steps), the result, a visible queue with Send now and Remove, Stop and Ctrl+C, a tasks strip, a slash menu of the engine's commands, and a `/usage` dialog. Opt-in via Settings, Agent types.
```

with these two:

```markdown
- **Dispatch Harness**: a `dispatch` agent type that runs a coding agent as a child process over the Agent Client Protocol and renders the session as turns in the Chat feed: prompt, a collapsible activity rail per turn (tool calls with output, diffs, locations, live timers, nested subagent steps), the result, a visible queue with Send now and Remove, Stop and Ctrl+C, a tasks strip, a slash menu of the engine's commands, and a `/usage` dialog. Opt-in via Settings, **Dispatch Harness (beta)**.
- **One feed for every agent type.** A dispatch agent's turns are entries in the same Chat feed every other agent type reads, so reviews, pins, the presence strip, the unread badge, day dividers, copy and the child-agent filter all work for it. There is no second view and no second endpoint, and a streamed chunk updates one row instead of refetching the page.
```

- [ ] **Step 2: Correct the runbook's two clauses**

In `docs/10-operations-runbook.md`, replace:

```markdown
- At shutdown the running turn is marked `interrupted by restart`; the Harness
  view shows it as interrupted.
```

with:

```markdown
- At shutdown the running turn is marked `interrupted by restart`; the Chat
  feed shows that turn as interrupted.
```

and replace:

```markdown
What each engine publishes over ACP differs, and the view says so where it
matters: Gemini CLI publishes no plan, no usage, and no model option (its
```

with:

```markdown
What each engine publishes over ACP differs, and the Chat feed says so where
it matters: Gemini CLI publishes no plan, no usage, and no model option (its
```

- [ ] **Step 3: Correct the one line of Settings copy that names the view**

In `apps/web/src/components/app/usage-budget-settings.tsx`, replace:

```tsx
        A monthly amount in USD per engine. The Harness view&apos;s usage dialog
        (<span className="font-terminal">/usage</span>) draws each engine&apos;s
        spend this month against it. No budget, no bar.
```

with:

```tsx
        A monthly amount in USD per engine. A Dispatch Harness agent&apos;s
        usage dialog (<span className="font-terminal">/usage</span>) draws each
        engine&apos;s spend this month against it. No budget, no bar.
```

No test pins that sentence: `apps/web/src/components/app/usage-budget-settings.test.tsx` asserts the rows and the testid, not the paragraph. Step 5 confirms it.

- [ ] **Step 4: Correct the pane-view hook's comment**

In `apps/web/src/hooks/use-agent-pane-view.ts`, replace:

```ts
/**
 * Which of Chat / Console the Agent pane shows for `agentId`, remembered per
 * agent across reloads. Defaults to Chat. With no agent in focus the value
 * is an unpersisted placeholder so nothing is written under a bogus key.
 * For a Dispatch Harness agent "chat" is the Harness view; the pane decides
 * that from the agent type, not from a third view value.
 */
```

with:

```ts
/**
 * Which of Chat / Console the Agent pane shows for `agentId`, remembered per
 * agent across reloads. Defaults to Chat. With no agent in focus the value
 * is an unpersisted placeholder so nothing is written under a bogus key.
 */
```

Plan 3 made "chat" the same chat pane for every agent type, so the last sentence describes a branch that no longer exists.

- [ ] **Step 5: Check the formatting and the two web files**

Run: `pnpm run format`

Expected: exit 0. If prettier reports a file, run `pnpm run format:write` and re-run the check.

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/usage-budget-settings.test.tsx src/components/app/agent-pane.test.tsx`

Expected: PASS. A failure naming the budget paragraph means a test does pin that sentence after all; update the test's expected string to the new copy.

Run: `pnpm run check:web`

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add release-notes/current.md docs/10-operations-runbook.md apps/web/src/components/app/usage-budget-settings.tsx apps/web/src/hooks/use-agent-pane-view.ts
git commit -m "$(cat <<'EOF'
docs(release): note the harness folding into the Chat feed

The release notes, the runbook and one line of Settings copy described a
Harness view and an Agent-types opt-in, neither of which ships: a dispatch
agent reads in the Chat feed, behind the new Dispatch Harness setting.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The stage gate

Stage 3 of the spec is shippable when the whole gate passes. This task adds no code.

**Files:** none.

- [ ] **Step 1: Type check the whole workspace**

Run: `pnpm run check`

Expected: exit 0. If the final `tsc -p tsconfig.scripts.json` step fails for want of root `@types/node`, that is a pre-existing gap unrelated to this work: record it and take `pnpm --filter @dispatch/shared check && pnpm --filter @dispatch/server check && pnpm run check:web && pnpm run check:site` as the gate instead. Every one of those must pass. Plan 1's implementer found the full `pnpm run check` passing in this worktree, so a failure here is more likely a real error than the known gap.

- [ ] **Step 2: Run the whole server suite**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run`

Expected: PASS, every file. `test/chat-turns.test.ts` runs under its new name and `test/harness-turns.test.ts` no longer exists. A suite that fails at collection with `Cannot find module '../src/agents/harness/turns.js'` means a test file kept the pre-plan-2 import path.

- [ ] **Step 3: Build the web app**

Run: `pnpm run finalize:web`

Expected: exit 0, with a Vite build summary. A failure on an unresolved import from `@/components/app/harness/use-harness-turns` means something still reaches the deleted module; fix the importer rather than restoring the file.

- [ ] **Step 4: Run the whole web suite**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`

Expected: PASS, no failed collections. This is the run that catches a `vi.mock` factory for the deleted module.

- [ ] **Step 5: Run the default E2E suite**

Run: `pnpm run test:e2e`

Expected: PASS. `e2e/harness-agent.spec.ts` skips itself here (`test.skip(!live, ...)`), which is expected and not a failure.

- [ ] **Step 6: Run the live harness spec**

Run: `pnpm run test:e2e:live`

Expected: PASS, `e2e/terminal-live.spec.ts` plus `e2e/harness-agent.spec.ts`. This host can run it: `tmux` is at `/bin/tmux`, and no engine CLI is needed, because `scripts/e2e-isolated.sh` points all four of `DISPATCH_CLAUDE_HARNESS_BIN`, `DISPATCH_CODEX_HARNESS_BIN`, `DISPATCH_GEMINI_BIN` and `DISPATCH_OPENCODE_BIN` at `e2e/fixtures/fake-acp-agent.mjs`. It is the only automated run that drives an ACP turn through the retargeted chat-pane selectors, so a failure here is reported, never recorded as a green.

- [ ] **Step 7: Start an isolated stack with a real engine**

`--live` sets `DISPATCH_AGENT_RUNTIME=tmux` and sources the worktree's `.env`, which holds the engine binaries (`DISPATCH_CLAUDE_HARNESS_BIN`, `DISPATCH_CODEX_HARNESS_BIN`, `DISPATCH_GEMINI_BIN`, `DISPATCH_CLAUDE_BIN`). It also skips the demo seed, so the stack starts empty.

```bash
cd /home/nii/.dispatch/server-dsh-harness
./bin/dispatch-dev up --live --suffix onefeed4 --cwd /home/nii/.dispatch/server-dsh-harness
```

Expected: `Dev environment ready (suffix: onefeed4):` with a web URL, an API URL and a DB port. Use the printed web URL for every step below.

If an engine reports `auth_required` later, log it in as the service user from a terminal on this host: `claude /login` for Claude Code, `codex login --device-auth` for Codex. The runbook's Dispatch Harness engines table is the reference for both.

- [ ] **Step 8: Turn the Dispatch Harness setting on and create an agent**

1. Open the printed web URL and sign in.
2. Settings, then the **Dispatch Harness (beta)** card. Check its toggle (`data-testid="dispatch-harness-toggle"`).
3. Create an agent: type **Dispatch Harness**, model `claude/default` or `codex/default` (whichever this host is logged into), cwd `/home/nii/.dispatch/server-dsh-harness`, no worktree.

Look for: the type is offered only while the setting is on, and the created agent's pane opens on the Chat segment with the chrome above the composer (the model chip, the usage chip and Stop) and no `Harness` segment in the pill.

- [ ] **Step 9: Watch a live turn stream, and count the requests**

1. Open the browser's developer tools, Network tab. Filter on `chat`.
2. Note the number of `GET /api/v1/agents/<id>/chat?limit=100` request rows. Opening the pane costs one.
3. Send a prompt that runs for several seconds: `read README.md and summarize it in three bullets, then run pnpm --version`.
4. Watch the feed while it runs.

**How to tell a row upsert from a refetch.** A refetch is a **new request row** in the Network list for `chat?limit=100`. An upsert is a **frame inside the already-open `/api/v1/events` connection**, with no new request row at all: select that row and open its EventStream tab (Chrome) or Response tab (Firefox) to read the frames.

Look for:

- The activity rail appears inside one feed entry, above the growing result, and grows in place. The entry does not re-fade as it grows.
- The `/api/v1/events` row's frames include a stream of `{"type":"chat.entry", …, "entry":{"type":"turn", …}}`, roughly ten per second while the engine is producing output.
- The `chat?limit=100` request count **does not grow with those frames**. Before this plan it grew by one per frame. One or two extra requests over the whole turn are the existing out-of-order fallback in `applyChatEntry` and are acceptable; a count that tracks the frame count is a failure of Task 3.
- The prompt text appears **once**, inside the turn's user post, and not a second time as a row of its own. That is Task 2.

- [ ] **Step 10: Watch it settle**

Let the turn finish.

Look for:

- The rail collapses to its one-line summary. Its verb is the agent's own last status message, or, when it sent none, a phrase derived from the steps such as `read README.md` or `ran pnpm --version`. A summary reading `done` for a turn with steps means plan 2's step-derived fallback in `TurnEntryView` is missing; report it against plan 2 rather than patching it here.
- The result renders as an agent post with the feed's own header and time.
- `document.querySelector('[data-testid="chat-turn"]').dataset.settled` is `"true"` in the browser console.
- Still no burst of `chat?limit=100` requests.

- [ ] **Step 11: Interrupt a turn, and queue behind one**

1. Send another long prompt: `list every file under apps/server/src and describe each directory`.
2. While it runs, type a second message and press Enter. It queues: a queued row appears in the chrome above the composer with **Send now** and a remove control.
3. Press **Stop** in the chrome (`data-testid="harness-stop"`).

Look for:

- `POST /api/v1/agents/<id>/harness/interrupt` returns `204`.
- The interrupted turn's entry says `Interrupted mid-turn: the agent was stopped before it finished.` and its rail summary reads `interrupted`.
- The queued prompt starts as the next turn, and its own entry appears below the interrupted one.
- Press ArrowUp in an empty composer while a turn runs and the queued message is recalled into the draft.
- The browser console holds no errors.

- [ ] **Step 12: Record the result and tear the stack down**

Note in the task's report: the engine used, the web URL, whether the request count stayed flat through the turn, and anything the console said.

```bash
cd /home/nii/.dispatch/server-dsh-harness
./bin/dispatch-dev down --suffix onefeed4
```

Expected: `Dev environment torn down (suffix: onefeed4).`

- [ ] **Step 13: Commit anything the gate caught**

There is nothing to commit unless a gate step needed a fix. If one did, commit that fix on its own:

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add -A
git commit -m "$(cat <<'EOF'
fix(web): <what the gate caught>

<The failure the gate reported, then what changed.>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage.** Section 5's stage 3 row: `/harness/turns` (Task 4), `use-harness-turns` (Task 1), the second cache (Task 1), the `harness.changed` feed invalidation (Task 3), and the gate of `pnpm run check`, `pnpm run test`, `pnpm run test:e2e` plus a manual pass on an isolated stack watching a live turn stream, settle and interrupt (Task 8). Section 3's live-updates paragraph names the coarse invalidations at `use-sse.ts:381`, `:429`, `:497` and `:528`: all four are Task 1 Step 3(g), which finds five calls rather than four (`message.created` invalidates both ends), and keeps the feed half of each while dropping the turns and config halves. Section 6's stage-3 deletions: the turns route and `use-harness-turns.ts`. The spec does not name `HarnessTurn`, `HarnessTurnsResponse` or plan 2's three aliases in section 6, but section 3 says `harness-types.ts` "re-exports them under their current names until stage 3 removes `HarnessTurn` and `HarnessTurnsResponse`", which is Task 5. Plan 2's concern 1 is Task 2, its concern 2 is answered below, and its concern 6 is Task 5 Step 2. Plan 3's concern 7 is Task 6.

**Plan 2's concern 2, for the record.** `loadChatMessageEntry` returns null for a chat row a turn claims as its prompt, so `ChatService.publishEntry` falls back to the coarse `publishChanged` for a late write to such a row: left as it is, because that fallback is the only thing that keeps a client correct in the reverse ordering (a turn already rendered, then the prompt row's delivery stamp lands), the refetch it triggers drops the row exactly as the server no longer lists it, and a second read path would have to reproduce that removal to gain anything.

**Prose no plan owned.** Six comments and one line of UI copy describe a view or a refetch this work removes, and none of plans 1 to 3 touches them. The three that Task 3 itself makes wrong (`HarnessChangedEvent`, `ChatService.publishHarnessChanged`, the supervisor's `publishHarness` field) are corrected there; the Settings sentence in `usage-budget-settings.tsx` and the stale half of `use-agent-pane-view.ts`'s comment are Task 7. Three more are left alone on purpose, because what they describe still exists under a new home: `prompt-source.ts`'s "the Harness view's prompt", `paths.ts`'s "the Harness composer's '@' path picker", and `chat/turn/contracts.ts`'s "what the Harness view renders". Editing those is churn, and the last of them is in a file plan 2 moved.

**Placeholders.** None. Every step that changes code carries the code, and every command carries its expected output. Two steps are conditional by design and say so: Task 1 Step 5 deletes a mock only if plan 3 left it, and Task 5 Step 1 stops rather than deleting if the grep finds an importer plan 3 should have cleared.

**Every task ends green.** Tasks 2 and 3 are red-first with their failing output named. Task 1 is red-first through the seven rewritten assertion sets. Task 4 is red-first through the route's `200`. Task 5 changes no behavior and says so; its gates are `pnpm run check` and the 20-case suite. Tasks 6, 7 and 8 are verification and documentation.

**Ordering is load-bearing.** Task 2 before Task 3, so no window exists where a streamed chunk neither refetches the feed nor prunes the prompt row. Task 1 before Task 5, because `use-harness-turns.ts` imports four of the five types Task 5 deletes. Task 4 before Task 5, because `loadTurns` returns `HarnessTurn`.

**Type consistency.** `AssembledTurn` is the name in Task 5's interface block, its declaration, all four of its uses inside `assembleTurns` and `toTurnEntry`, and the commit body. `withoutTurnPrompt` and `placeEntry` are the two names Task 2 introduces, and `upsertFeedEntry` keeps its exported signature and its `FeedUpsert` return, which `applyChatEntry` and `use-chat.test.tsx` both depend on. `harnessQueueQueryKey` and `invalidateHarnessQueue` are plan 2's names, used unchanged.

**What this plan deliberately does not do.** It does not restore the collapsed rail's step-derived fold verb: plan 2 owns that fallback in `TurnEntryView`, and this plan only relies on it, which is why `turnLabelFromSteps` is not on any delete list here. It does not move `HarnessQuestion` out of `@dispatch/shared`, though nothing on the wire carries it after Task 5: it is still a live function's type, the brief's delete list does not name it, and moving it would be tidiness with no behavior. It does not add a second read path for a prompt row's late writes. It does not touch the pane, the flag, the E2E retarget, or anything in the engines spec.
