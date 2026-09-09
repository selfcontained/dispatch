# One feed, plan 2 of 4: turn entries in the chat feed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Brad's Chat feed a `turn` entry kind that carries one harness turn whole (prompt, activity rail, plan, usage, result), composed on the server beside the other feed sources and rendered by `TurnEntryView` inside the feed, so the flat `assistant` and `activity` entries can go.

**Architecture:** `apps/server/src/agents/harness/turns.ts` moves to `apps/server/src/chat/turns.ts` and grows `listTurnEntries`, one more source in `composeChatFeed` windowed by the existing composite cursor. A turn anchors on its `turn` stream row and grows in place, so it belongs wholly to one page. The supervisor's per-flush publish hook composes the newest turn and publishes it as a single `chat.entry`, which the existing `upsertFeedEntry` path places without a refetch. On the web, the harness turn components move from `components/app/harness/` to `components/app/chat/turn/` and compose into `TurnEntryView`, which `chat-feed.tsx` dispatches for `case "turn"`. `HarnessPane`, `/harness/turns` and `use-harness-turns` keep working unchanged in this plan; plan 3 deletes the pane and plan 4 deletes the endpoint.

**Tech Stack:** TypeScript, Fastify, Postgres (`pg`), Vitest (server, DB-backed); React 18, Tailwind, shadcn/ui, TanStack Query, `framer-motion@^12`, Vitest + Testing Library (jsdom).

## Global Constraints

- Worktree `/home/nii/.dispatch/server-dsh-harness`, branch `dsh-harness-deploy`. Never touch `/home/nii/.dispatch/server` (production) or `127.0.0.1:6767`. Do not run dev servers.
- The spec is `docs/superpowers/specs/2026-09-08-harness-turns-in-chat-feed-design.md`. This plan is stage 1's turn-entry half. The flag half is plan 1 (`docs/superpowers/plans/2026-09-08-one-feed-1-harness-flag.md`) and is independent: the two can land in either order.
- Copy: American spelling; no em-dashes anywhere (prose, comments, UI copy, commit messages); engine names come from `HARNESS_ENGINES[i].label`; nothing mentions the harness's earlier child process by name, DeepSeek, or "provider key".
- Comments earn their place. Write one only where the reason is not visible in the code; never restate what the line does, and do not add a doc comment to a self-evident function. Keep the ones already in code you move.
- Prefer shadcn/ui primitives over hand-rolled UI. State stays colocated; React Query for server state; Jotai only for the persisted flag hint atoms that already follow that pattern.
- Motion inside a turn uses tokens from `motion.ts` (moved to `chat/turn/motion.ts` in Task 7); the entry's arrival uses Brad's `animate-chat-enter`; reduced motion drops both (`useReducedMotion`, `motion-reduce:animate-none`). No ad-hoc `duration-*` or `ease-*` class and no new `@keyframes`.
- Each task ends green: the type check passes and the task's own tests pass. Tests use the existing fixtures; a test that asserts nothing is a defect.
- Type check gates, run from the worktree root:
  - `pnpm --filter @dispatch/shared check`
  - `pnpm --filter @dispatch/server check`
  - `pnpm run check:web`
  - `pnpm run check` runs all of them plus the site and `bin/`; use it as the final gate for the plan. If its last step (`tsc -p tsconfig.scripts.json`) fails on missing root `@types/node`, that is a pre-existing gap unrelated to this plan: the three scoped checks above are the real gates.
- Server tests: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run <test files>` (it provisions its own Postgres). Web tests: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run <files>`.
- Web tests have no `jest-dom`: use plain matchers (`expect(el).not.toBeNull()`, `expect(el?.textContent).toContain(...)`), never `toBeInTheDocument`. Framer components render under `MotionConfig reducedMotion="always"`.
- E2E: `pnpm run test:e2e` (isolated DB and server, agents inert). One spec: `bash scripts/e2e-isolated.sh e2e/<spec>`. `e2e/harness-agent.spec.ts` keeps targeting `harness-pane` in this plan; it runs through `pnpm run test:e2e:live`.
- Commit messages: `type(scope): imperative subject`, lowercase after the colon, body wrapped at 72 that leads with the failure mode or effect, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Scopes in use: `server`, `web`, `shared`, `e2e`, `docs`. Do not push.

---

## File structure

| Path                                                                                   | Responsibility after this plan                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/chat-types.ts`                                                    | `ChatTurnStep`, `ChatTurnPlanEntry`, `ChatTurnPrompt`, `ChatTurnQuestionRef`, `ChatTurnEntry`; `ChatFeedEntry` gains `turn` and loses `assistant` and `activity`, whose types are deleted                                                                                                                                          |
| `packages/shared/src/harness-types.ts`                                                 | `HarnessStep` and `HarnessPlanEntry` become re-exports of the `chat-types.ts` originals; `HarnessQueueResponse` added                                                                                                                                                                                                              |
| `apps/server/src/chat/feed-cursor.ts`                                                  | **New.** The feed's ordering primitives: `FeedCursor`, `SOURCE_RANK`, `AT_KEY_SQL`, `cursorClause`, `Keyed`, `intKey`, `compareNewestFirst`, cursor encode/decode, the limit clamp                                                                                                                                                 |
| `apps/server/src/chat/turns.ts`                                                        | **Moved** from `apps/server/src/agents/harness/turns.ts`. `assembleTurns`, `groupTurnRows`, `toTurnEntry`, `listTurnEntries`, `loadLatestTurnEntry`, `loadQueued`, `loadTurns` (until plan 4)                                                                                                                                      |
| `apps/server/src/chat/feed.ts`                                                         | Composes the feed from seven sources including `listTurnEntries`; `listStreamEntries` deleted; a chat row that opened a turn is filtered out; re-exports the cursor primitives it used to own                                                                                                                                      |
| `apps/server/src/chat/service.ts`                                                      | `publishTurnEntry(agentId)`: the newest turn as one `chat.entry`                                                                                                                                                                                                                                                                   |
| `apps/server/src/server.ts`                                                            | The supervisor's `publishHarness` hook also publishes that turn entry                                                                                                                                                                                                                                                              |
| `apps/server/src/routes/agents/harness-routes.ts`                                      | `GET /api/v1/agents/:id/harness/queue`; imports the moved turns module                                                                                                                                                                                                                                                             |
| `apps/web/src/components/app/chat/turn/`                                               | **New directory.** The turn renderer: `turn-entry-view.tsx`, `turn-context.tsx`, `diff-block.tsx`, plus `activity-block`, `contracts`, `motion`, `prompt-line`, `queued-prompt`, `registry`, `result-turn`, `shortcut-row`, `step-detail`, `step-row`, `tasks-strip`, `todo-list`, `trace`, `turn-shortcuts` moved from `harness/` |
| `apps/web/src/components/app/chat/chat-feed.tsx`                                       | `case "turn"` renders `TurnEntryView`; a turn is its own author group; `entryGrowthKey` and `latestOpenFreeformQuestion` know turns; the `assistant` and `activity` cases go                                                                                                                                                       |
| `apps/web/src/components/app/chat/chat-pane.tsx`                                       | Provides `TurnContext` around the feed                                                                                                                                                                                                                                                                                             |
| `apps/web/src/components/app/chat/stream-entries.tsx`                                  | Deleted (its diff helpers move to `chat/turn/diff-block.tsx`)                                                                                                                                                                                                                                                                      |
| `apps/web/src/components/app/harness/use-harness-queue.ts`                             | `useHarnessQueued(agentId)` over `["harness-queue", agentId]`; the mutations invalidate that key                                                                                                                                                                                                                                   |
| `apps/web/src/hooks/use-sse.ts`                                                        | `harness.changed` also invalidates the queue key; `chat.entry` needs no new handler                                                                                                                                                                                                                                                |
| `apps/web/src/components/app/harness/{turn-stream,harness-pane,use-harness-turns}.tsx` | Unchanged behavior; imports point at `chat/turn/`                                                                                                                                                                                                                                                                                  |

---

### Task 1: Split the feed's ordering primitives into their own module

`apps/server/src/chat/turns.ts` (Task 2) needs `cursorClause`, `Keyed`, `AT_KEY_SQL` and `intKey`, and `apps/server/src/chat/feed.ts` needs `listTurnEntries` from `turns.ts`. Importing both ways is a runtime cycle, so the primitives move down into a module both can depend on. This task changes no behavior: the existing feed tests are the test.

**Files:**

- Create: `apps/server/src/chat/feed-cursor.ts`
- Modify: `apps/server/src/chat/feed.ts:1-190`, `:629-636`
- Test: `apps/server/test/chat-feed.test.ts` (unchanged, run as a regression), `apps/server/test/pin-events.test.ts` (unchanged)

**Interfaces:**

- Consumes: nothing.
- Produces, all from `apps/server/src/chat/feed-cursor.ts`:
  - `CHAT_FEED_DEFAULT_LIMIT = 200`, `CHAT_FEED_MAX_LIMIT = 500`
  - `type FeedCursor = { at: string; type: ChatFeedEntry["type"]; id: string }`
  - `const SOURCE_RANK: Record<ChatFeedEntry["type"], number>`
  - `const AT_KEY_SQL: string`
  - `type Keyed<E extends ChatFeedEntry> = { entry: E; atKey: string; rawId: string; idKey: string }`
  - `function cursorClause(type: ChatFeedEntry["type"], idCast: "int" | "uuid", cursor: FeedCursor | null, params: unknown[], alias?: string): string`
  - `function intKey(id: number): string`
  - `function compareNewestFirst(a: Keyed<ChatFeedEntry>, b: Keyed<ChatFeedEntry>): number`
  - `function encodeFeedCursor(cursor: FeedCursor): string`
  - `function decodeFeedCursor(raw: string): FeedCursor | null`
  - `function clampFeedLimit(limit: number | undefined): number`
  - `apps/server/src/chat/feed.ts` re-exports `CHAT_FEED_DEFAULT_LIMIT`, `CHAT_FEED_MAX_LIMIT`, `FeedCursor`, `encodeFeedCursor`, `decodeFeedCursor` and `clampFeedLimit`, so `routes/chat.ts` and both test files keep importing them from `./feed.js`.

- [ ] **Step 1: Run the feed tests to record the green baseline**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-feed.test.ts test/pin-events.test.ts`
Expected: PASS, both files, no failures. (These are the regression net for this refactor; if they are red before you start, stop and report that.)

- [ ] **Step 2: Create `apps/server/src/chat/feed-cursor.ts`**

Write the whole file:

```ts
import type { ChatFeedEntry } from "@dispatch/shared";

import { isChatMessageId } from "./store.js";

export const CHAT_FEED_DEFAULT_LIMIT = 200;
export const CHAT_FEED_MAX_LIMIT = 500;

/**
 * Feed ordering is (created_at desc, source rank desc, id desc): a total
 * order across the sources, so a page boundary that falls on rows with
 * identical timestamps never drops or repeats a row. The cursor names the
 * last entry of the previous page in that order. `at` is Postgres microsecond
 * text (`to_char(..., 'YYYY-MM-DD HH24:MI:SS.US')`), not the millisecond ISO
 * `at` the entries expose, so equality comparisons are exact.
 */
export type FeedCursor = {
  at: string;
  type: ChatFeedEntry["type"];
  id: string;
};

export const SOURCE_RANK: Record<ChatFeedEntry["type"], number> = {
  // assistant and activity share one source (agent_stream_events), so they
  // share one rank: the cursor tie-break on id is valid across both.
  assistant: 6,
  activity: 6,
  review: 5,
  chat: 4,
  status: 3,
  pin: 2,
  agent_message: 1,
  media: 0,
};

const AT_KEY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
export const AT_KEY_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Serial ids: digits only, and small enough for a Postgres int4 cast. */
const SERIAL_ID_RE = /^\d{1,10}$/;

function isValidCursorId(type: ChatFeedEntry["type"], id: string): boolean {
  switch (type) {
    case "chat":
    case "agent_message":
      return isChatMessageId(id);
    case "status":
    case "media":
    case "review":
    case "assistant":
    case "activity":
    case "turn":
    case "pin":
      return SERIAL_ID_RE.test(id) && Number(id) <= 2_147_483_647;
  }
}

/**
 * Shape-valid text like `2026-02-30 25:61:00.000000` would still reach the
 * timestamp cast and fail there; round-trip through Date so only real
 * instants pass (JS normalises impossible dates, so the re-rendered ISO
 * string must match).
 */
function isRealTimestamp(at: string): boolean {
  // JS accepts year 0000; Postgres does not (there is no year zero).
  if (at.startsWith("0000-")) return false;
  const iso = `${at.slice(0, 10)}T${at.slice(11, 23)}Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === iso;
}

/**
 * Returns null for anything that is not a cursor this server produced —
 * every field is checked against what its source column can hold, so a
 * rejected cursor is a 400 at the route and never a failed cast in SQL.
 */
export function decodeFeedCursor(raw: string): FeedCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { at, type, id } = parsed as Record<string, unknown>;
  if (typeof at !== "string" || !AT_KEY_RE.test(at) || !isRealTimestamp(at)) {
    return null;
  }
  if (typeof type !== "string" || !(type in SOURCE_RANK)) return null;
  const sourceType = type as ChatFeedEntry["type"];
  if (typeof id !== "string" || !isValidCursorId(sourceType, id)) return null;
  return { at, type: sourceType, id };
}

export function clampFeedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return CHAT_FEED_DEFAULT_LIMIT;
  }
  return Math.min(CHAT_FEED_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export type Keyed<E extends ChatFeedEntry> = {
  entry: E;
  atKey: string;
  /** Raw id for the cursor and the SQL tuple comparison. */
  rawId: string;
  /** Fixed-width form so JS ordering matches the column's ordering. */
  idKey: string;
};

/**
 * "Older than the cursor" for one source. `$1` is the agent id; the clause
 * appends its own parameters. Sources ranked below the cursor's include the
 * cursor timestamp itself; those above it exclude it; the cursor's own
 * source breaks the tie on id. `alias` qualifies the columns for a source
 * whose query joins other tables that have `id`/`created_at` of their own.
 */
export function cursorClause(
  type: ChatFeedEntry["type"],
  idCast: "int" | "uuid",
  cursor: FeedCursor | null,
  params: unknown[],
  alias = ""
): string {
  if (!cursor) return "";
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  params.push(cursor.at);
  const ts = `($${params.length}::timestamp AT TIME ZONE 'UTC')`;
  const rank = SOURCE_RANK[type];
  const cursorRank = SOURCE_RANK[cursor.type];
  if (rank > cursorRank) return `AND ${col("created_at")} < ${ts}`;
  if (rank < cursorRank) return `AND ${col("created_at")} <= ${ts}`;
  params.push(idCast === "int" ? Number(cursor.id) : cursor.id);
  return `AND (${col("created_at")} < ${ts} OR (${col("created_at")} = ${ts} AND ${col("id")} < $${params.length}::${idCast}))`;
}

export const intKey = (id: number) => String(id).padStart(20, "0");

/** Newest first: (atKey, source rank, id) descending. */
export function compareNewestFirst(
  a: Keyed<ChatFeedEntry>,
  b: Keyed<ChatFeedEntry>
): number {
  if (a.atKey !== b.atKey) return a.atKey < b.atKey ? 1 : -1;
  const rank = SOURCE_RANK[b.entry.type] - SOURCE_RANK[a.entry.type];
  if (rank !== 0) return rank;
  if (a.idKey === b.idKey) return 0;
  return a.idKey < b.idKey ? 1 : -1;
}
```

`SOURCE_RANK` is `Record<ChatFeedEntry["type"], number>`, and `ChatFeedEntry` has no `turn` member yet, so the file above is exactly what compiles today. Task 2 adds `turn: 6` to the record and `case "turn":` to `isValidCursorId` in the same commit that adds the union member.

- [ ] **Step 3: Cut the moved declarations out of `feed.ts` and import them back**

Two edits in `apps/server/src/chat/feed.ts`. Nothing below `const intKey = ...` moves: `MESSAGE_COLUMNS`, `listChatEntries` and everything after them stay where they are.

First edit: replace everything from the file's first line (`import type {`) down to and including the `const intKey = (id: number) => String(id).padStart(20, "0");` line with:

```ts
import type {
  ChatActivityEntry,
  ChatAgentMessageEntry,
  ChatAssistantEntry,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatMessageEntry,
  ChatPinEntry,
  ChatReviewEntry,
  ChatStatusEntry,
} from "@dispatch/shared";

import type {
  AssistantPayload,
  ToolPayload,
} from "../agents/harness/stream-store.js";
import { dimensionFields, parseMediaMetadata } from "../media/metadata.js";

import {
  AT_KEY_SQL,
  CHAT_FEED_DEFAULT_LIMIT,
  CHAT_FEED_MAX_LIMIT,
  clampFeedLimit,
  compareNewestFirst,
  cursorClause,
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedCursor,
  intKey,
  type Keyed,
} from "./feed-cursor.js";
import { type ChatStore, type Queryable, toChatMessage } from "./store.js";

// The feed's ordering primitives live in `feed-cursor.ts` so the turn
// composer can use them without importing this module back.
export {
  CHAT_FEED_DEFAULT_LIMIT,
  CHAT_FEED_MAX_LIMIT,
  clampFeedLimit,
  decodeFeedCursor,
  encodeFeedCursor,
};
export type { FeedCursor };

export type ComposeChatFeedOptions = {
  /** Opaque cursor from a previous page's `nextCursor`; already decoded. */
  cursor?: FeedCursor | null;
  limit?: number;
};
```

Note the two dropped imports: `isChatMessageId` (now only `feed-cursor.ts` needs it) and nothing else. `CHAT_FEED_DEFAULT_LIMIT` and `CHAT_FEED_MAX_LIMIT` are imported only to be re-exported; that is why they appear in both lists.

Second edit: delete the now-duplicated `compareNewestFirst` function (the block starting `/** Newest first: (atKey, source rank, id) descending. */` and ending with the closing brace of that function).

- [ ] **Step 4: Run the check and the feed tests**

Run: `pnpm --filter @dispatch/server check`
Expected: no output, exit 0.

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-feed.test.ts test/pin-events.test.ts`
Expected: PASS, the same test counts as Step 1.

- [ ] **Step 5: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/chat/feed-cursor.ts apps/server/src/chat/feed.ts
git commit -m "$(cat <<'EOF'
refactor(server): move the feed's cursor primitives into feed-cursor.ts

The turn composer needs cursorClause, Keyed, AT_KEY_SQL and intKey while
the feed needs the composer's page function, which would be a runtime
import cycle. Both now depend on chat/feed-cursor.ts instead. feed.ts
re-exports what routes/chat.ts and the tests import from it, so no caller
changes and no behavior changes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `turn` feed entry type, and the turn assembler moves into `chat/`

**Files:**

- Modify: `packages/shared/src/chat-types.ts:197-232`, `:257-265`
- Modify: `packages/shared/src/harness-types.ts:1`, `:18-46`, `:199-204`
- Modify: `packages/shared/src/index.ts:36-66`
- Modify: `apps/server/src/chat/feed-cursor.ts` (add `turn` to `SOURCE_RANK` and `isValidCursorId`)
- Modify: `apps/web/src/components/app/chat/chat-feed.tsx:232-249` (`authorKey`'s `turn` arm)
- Move: `apps/server/src/agents/harness/turns.ts` to `apps/server/src/chat/turns.ts`
- Modify: `apps/server/src/routes/agents/harness-routes.ts:11`
- Test: `apps/server/test/harness-turns.test.ts:1-8` (import), plus two new cases

**Interfaces:**

- Consumes: `Keyed`, `SOURCE_RANK` from Task 1's `apps/server/src/chat/feed-cursor.ts`.
- Produces, from `packages/shared/src/chat-types.ts`:
  - `type ChatTurnStep` (today's `HarnessStep`, moved), `type ChatTurnStepStatus = "running" | "ok" | "error"`, `type ChatTurnPlanEntry` (today's `HarnessPlanEntry`, moved)
  - `type ChatTurnPrompt = { source: "chat" | "launch" | "agent" | "system"; text: string; chatMessageId?: string; senderName?: string; attachments: ChatAttachment[] }`
  - `type ChatTurnQuestionRef = { messageId: string; answered: boolean }`
  - `type ChatTurnEntry` (full shape below)
  - `ChatFeedEntry` includes `ChatTurnEntry`
- Produces, from `packages/shared/src/harness-types.ts`: `HarnessStep`, `HarnessStepStatus` and `HarnessPlanEntry` are now re-exports of `ChatTurnStep`, `ChatTurnStepStatus` and `ChatTurnPlanEntry` under their current names (plan 4 removes them).
- Produces, from `apps/server/src/chat/turns.ts`:
  - `type TurnSourceRow` (unchanged)
  - `type TurnGroup = { turn: TurnSourceRow | null; rows: TurnSourceRow[] }`
  - `function groupTurnRows(rows: TurnSourceRow[]): TurnGroup[]`
  - `function assembleTurns(rows, chat, questions?): HarnessTurn[]` (unchanged, except a pre-turn group's id)
  - `function toTurnEntry(turn: HarnessTurn, group: TurnGroup, agentId: string): ChatTurnEntry`
  - `function loadTurns(db, agentId, limit): Promise<HarnessTurn[]>` (unchanged)
  - `function loadQueued(db, queued): Promise<HarnessQueuedPrompt[]>` (unchanged)
  - `function locationsFromInput(input, terminalOutput)` (unchanged)

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/harness-turns.test.ts`, change the import block at lines 4-8 to:

```ts
import {
  assembleTurns,
  groupTurnRows,
  loadQueued,
  toTurnEntry,
  type TurnSourceRow,
} from "../src/chat/turns.js";
```

Then append these two describes to the end of the file:

```ts
describe("groupTurnRows", () => {
  it("cuts at each turn row and keeps rows before the first one in their own group", () => {
    seq = 0;
    const early = row("assistant", { text: "before", streaming: false }, 0);
    const first = row(
      "turn",
      { state: "settled", prompt: { source: "system", text: "one" } },
      1,
      3
    );
    const inFirst = row("assistant", { text: "a", streaming: false }, 2);
    const second = row(
      "turn",
      { state: "started", prompt: { source: "system", text: "two" } },
      4
    );
    const groups = groupTurnRows([early, first, inFirst, second]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual({ turn: null, rows: [early] });
    expect(groups[1]).toEqual({ turn: first, rows: [inFirst] });
    expect(groups[2]).toEqual({ turn: second, rows: [] });
  });

  it("indexes one to one with assembleTurns over the same rows", () => {
    seq = 0;
    const rows = [
      row("thought", { text: "hmm" }, 0),
      row(
        "turn",
        { state: "settled", prompt: { source: "system", text: "p" } },
        1,
        2
      ),
    ];
    expect(groupTurnRows(rows)).toHaveLength(
      assembleTurns(rows, new Map()).length
    );
  });
});

describe("toTurnEntry", () => {
  it("anchors the entry on the turn row and moves updatedAt with the newest row", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "started",
        prompt: { source: "system", text: "p" },
      },
      1
    );
    const chunk = row("assistant", { text: "so far", streaming: true }, 2, 7);
    const [group] = groupTurnRows([turnRow, chunk]);
    const [turn] = assembleTurns([turnRow, chunk], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry).toMatchObject({
      type: "turn",
      id: `turn:${turnRow.id}`,
      agentId: "agt_x",
      at: at(1).toISOString(),
      updatedAt: at(7).toISOString(),
      settled: false,
      interrupted: false,
      result: { text: "so far", streaming: true },
    });
    expect(entry.error).toBeUndefined();
  });

  it("gives a pre-turn group the first row's id and reads it as settled", () => {
    seq = 0;
    const early = row("assistant", { text: "history", streaming: false }, 0, 1);
    const [group] = groupTurnRows([early]);
    const [turn] = assembleTurns([early], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.id).toBe(`turn:pre:${early.id}`);
    expect(entry.settled).toBe(true);
    expect(entry.at).toBe(at(0).toISOString());
  });

  it("reads a cancelled turn as interrupted", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        stopReason: "cancelled",
        endedAt: at(2).toISOString(),
      },
      0,
      2
    );
    const [group] = groupTurnRows([turnRow]);
    const [turn] = assembleTurns([turnRow], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.interrupted).toBe(true);
    expect(entry.settled).toBe(true);
    expect(entry.trace.finalResult).toBe("interrupted");
  });

  it("reads a turn the service went down under as interrupted, not failed", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        error: "interrupted by restart",
        endedAt: at(4).toISOString(),
      },
      0,
      4
    );
    const [group] = groupTurnRows([turnRow]);
    const [turn] = assembleTurns([turnRow], new Map());
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.interrupted).toBe(true);
    expect(entry.trace.finalResult).toBe("interrupted");
    // The restart marker is not an engine failure, so it does not also
    // render as an error line under the result.
    expect(entry.error).toBeUndefined();
  });

  it("carries an engine error through and turns questions into references", () => {
    seq = 0;
    const turnRow = row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        error: "no API key",
        endedAt: at(5).toISOString(),
      },
      0,
      5
    );
    const question = {
      id: "11111111-1111-4111-8111-111111111111",
      agentId: "agt_x",
      authorKind: "agent" as const,
      kind: "question" as const,
      text: "Which one?",
      replyTo: null,
      question: { options: [{ label: "A" }], allowFreeform: true },
      answer: null,
      attachments: [],
      delivered: null,
      readAt: null,
      createdAt: at(1).toISOString(),
      updatedAt: at(1).toISOString(),
    };
    const [group] = groupTurnRows([turnRow]);
    const [turn] = assembleTurns([turnRow], new Map(), [question as never]);
    const entry = toTurnEntry(turn, group, "agt_x");
    expect(entry.error).toBe("no API key");
    expect(entry.interrupted).toBe(false);
    expect(entry.questions).toEqual([
      { messageId: "11111111-1111-4111-8111-111111111111", answered: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-turns.test.ts`
Expected: FAIL at collection with `Failed to load "../src/chat/turns.js"` (the module has not moved yet).

- [ ] **Step 3: Move `ChatTurnStep` and `ChatTurnPlanEntry` into `chat-types.ts`**

In `packages/shared/src/chat-types.ts`, replace the whole `ChatAssistantEntry` / `ChatActivityStatus` / `ChatActivityEntry` block (lines 197-232, from `/** One assistant message from a stream-driven harness (over ACP). */` through the closing `};` of `ChatActivityEntry`) with that block **kept as it is** plus the new turn types appended after it. That is: leave lines 197-232 untouched and insert the following immediately after line 232 (after `ChatActivityEntry`'s closing `};`):

```ts
export type ChatTurnStepStatus = "running" | "ok" | "error";

/**
 * One unit of work inside a turn's trace: a tool call, a thought, or a
 * piece of assistant text that was not the turn's answer.
 */
export type ChatTurnStep = {
  id: string;
  /** execute | edit | read | search | fetch | think | note | other */
  kind: string;
  label: string;
  status: ChatTurnStepStatus;
  startedAt: string;
  endedAt?: string;
  durMs?: number;
  detail: {
    toolKind?: string;
    locations?: { path: string; line?: number }[];
    diff?: { path: string; oldText: string | null; newText: string } | null;
    terminalOutput?: string | null;
    truncated?: boolean;
    /** The tool call's raw input (the harness sends the model's arguments). */
    input?: unknown;
    /** note and think steps: the full text. */
    text?: string;
    /** A `subagent` step: the child session it started. */
    subagentSessionId?: string;
    /** A nested call: the toolCallId of the step it runs under. */
    parentToolCallId?: string;
  };
  /** Steps a subagent ran under this one (Claude Task calls). */
  children?: ChatTurnStep[];
};

/** One entry of the agent's task list, as ACP `plan` carries it. */
export type ChatTurnPlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};

/** What opened a turn, in the reader's terms rather than the wire envelope's. */
export type ChatTurnPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  /** The `agent_chat_messages` row behind a chat or launch prompt. */
  chatMessageId?: string;
  /** A prompt from another agent: who sent it. */
  senderName?: string;
  attachments: ChatAttachment[];
};

/** A question asked during the turn. Its card is a `chat` entry of its own. */
export type ChatTurnQuestionRef = { messageId: string; answered: boolean };

/**
 * One turn of a stream-driven harness, whole: the prompt that opened it, the
 * activity behind it, the answer it ended with. It takes the position of its
 * anchor `turn` row and grows in place while the turn runs, so it belongs
 * wholly to the page that anchor falls on and no page boundary splits it.
 */
export type ChatTurnEntry = {
  type: "turn";
  /** `turn:<stream row id>`, or `turn:pre:<first row id>` for a pre-turn group. */
  id: string;
  agentId: string;
  /** The anchor row's `created_at`: the turn's place in the feed, fixed for its life. */
  at: string;
  /** The newest row folded in so far; moves while the turn streams. */
  updatedAt: string;
  prompt: ChatTurnPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error" | "interrupted";
    steps: ChatTurnStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  /** False while the turn is open: the rail is live and the result may grow. */
  settled: boolean;
  /** Cut rather than finished: Stop, Ctrl+C, Send now, or a service restart. */
  interrupted: boolean;
  error?: string;
  /** The turn in the agent's own words: its last `dispatch_event` message. */
  label?: string;
  plan?: ChatTurnPlanEntry[];
  usage?: { used: number; size: number; costUsd: number | null };
  questions?: ChatTurnQuestionRef[];
};
```

Then add `ChatTurnEntry` to the union (line 257-265 today):

```ts
export type ChatFeedEntry =
  | ChatMessageEntry
  | ChatStatusEntry
  | ChatAgentMessageEntry
  | ChatMediaEntry
  | ChatReviewEntry
  | ChatAssistantEntry
  | ChatActivityEntry
  | ChatTurnEntry
  | ChatPinEntry;
```

(`ChatAssistantEntry` and `ChatActivityEntry` leave the union in Task 11, once nothing renders them.)

- [ ] **Step 4: Turn `harness-types.ts`'s copies into re-exports**

In `packages/shared/src/harness-types.ts`, change line 1 to:

```ts
import type {
  ChatAttachment,
  ChatQuestionOption,
  ChatTurnPlanEntry,
  ChatTurnStep,
  ChatTurnStepStatus,
} from "./chat-types.js";
```

Replace lines 18-46 (`export type HarnessStepStatus = ...` through the closing `};` of `HarnessStep`) with:

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

Replace lines 199-204 (`/** One entry of the agent's task list, as ACP `plan` carries it. */` through the closing `};` of `HarnessPlanEntry`) with:

```ts
/** One entry of the agent's task list; see `ChatTurnPlanEntry`. */
export type HarnessPlanEntry = ChatTurnPlanEntry;
```

- [ ] **Step 5: Export the new types from the shared index**

In `packages/shared/src/index.ts`, add these six names to the `export type { ... } from "./chat-types.js";` list, in alphabetical position (after `ChatSendResponse` and before `ChatUnreadSummary`):

```ts
  ChatStatusEntry,
  ChatTurnEntry,
  ChatTurnPlanEntry,
  ChatTurnPrompt,
  ChatTurnQuestionRef,
  ChatTurnStep,
  ChatTurnStepStatus,
  ChatUnreadSummary,
```

- [ ] **Step 6: Teach the cursor primitives about `turn`**

In `apps/server/src/chat/feed-cursor.ts`, add `turn: 6,` to `SOURCE_RANK` right after `activity: 6,`, and update the comment above it to:

```ts
export const SOURCE_RANK: Record<ChatFeedEntry["type"], number> = {
  // assistant, activity and turn share one source (agent_stream_events), so
  // they share one rank: the cursor tie-break on id is valid across them.
  assistant: 6,
  activity: 6,
  turn: 6,
```

and add `case "turn":` to `isValidCursorId`'s serial-id branch, right after `case "activity":`.

- [ ] **Step 7: Give `authorKey` its `turn` arm**

`authorKey` in `apps/web/src/components/app/chat/chat-feed.tsx:232-249` is a `switch` over `Exclude<ChatFeedEntry, ChatStatusEntry>` declared `: string` with no `default:`, so the union gaining a member makes it non-exhaustive and `tsc` reports `TS2366: Function lacks ending return statement and return type does not include 'undefined'`. It has to be exhaustive again in this commit, the same way `SOURCE_RANK` and `isValidCursorId` do. Replace:

```ts
    case "assistant":
    case "activity":
      return "agent";
  }
}
```

with:

```ts
    case "assistant":
    case "activity":
      return "agent";
    case "turn":
      // Never reached: `layoutFeed` gives a turn its own group before it
      // asks for an author key.
      return "turn";
  }
}
```

Task 9 adds that `layoutFeed` branch. Until then a turn entry never reaches the feed, so the arm is unreachable in fact as well as by design.

- [ ] **Step 8: Move the turns module**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git mv apps/server/src/agents/harness/turns.ts apps/server/src/chat/turns.ts
```

Then fix its imports. Replace the whole import block at the top of `apps/server/src/chat/turns.ts` (lines 1-24 as moved) with:

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

import { INTERRUPTED_BY_RESTART } from "../agents/harness/stream-recorder.js";
import type { PromptSource } from "../agents/harness/prompt-source.js";
import type {
  AssistantPayload,
  PlanPayload,
  StreamEventRow,
  ThoughtPayload,
  ToolPayload,
  TurnPayload,
} from "../agents/harness/stream-store.js";
import { isChatMessageId, type Queryable, toChatMessage } from "./store.js";
```

- [ ] **Step 9: Extract `groupTurnRows` and give a pre-turn group a real row id**

In `apps/server/src/chat/turns.ts`, replace the private `type Group = { turn: TurnSourceRow | null; rows: TurnSourceRow[] };` line with:

```ts
/** One turn's rows: its `turn` row (null for a pre-turn group) and the rest. */
export type TurnGroup = { turn: TurnSourceRow | null; rows: TurnSourceRow[] };

/**
 * Cut ascending stream rows into turns at each `turn` row. Rows before the
 * first one form a single leading group with no turn row of its own: that
 * is history from before turn rows existed, and it assembles into one
 * closed synthetic turn. Callers rely on the result indexing one to one
 * with {@link assembleTurns} over the same rows.
 */
export function groupTurnRows(rows: TurnSourceRow[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  for (const row of rows) {
    if (row.kind === "turn") {
      current = { turn: row, rows: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { turn: null, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups;
}
```

In `assembleTurns`, replace its own grouping loop:

```ts
const groups: Group[] = [];
let current: Group | null = null;
for (const row of rows) {
  if (row.kind === "turn") {
    current = { turn: row, rows: [] };
    groups.push(current);
    continue;
  }
  if (!current) {
    current = { turn: null, rows: [] };
    groups.push(current);
  }
  current.rows.push(row);
}
```

with:

```ts
const groups = groupTurnRows(rows);
```

and change the returned id (the `id:` line inside `assembleTurns`'s final `return groups.map(...)`) from:

```ts
      id: group.turn ? `turn:${group.turn.id}` : `turn:pre:${index}`,
```

to:

```ts
      // A pre-turn group is named by its first row, not by its position, so
      // a feed cursor over it compares against a real row id.
      id: group.turn
        ? `turn:${group.turn.id}`
        : `turn:pre:${group.rows[0]?.id ?? 0}`,
```

- [ ] **Step 10: Add `toTurnEntry`**

Append to `apps/server/src/chat/turns.ts`, right after `assembleTurns`:

```ts
/**
 * One assembled turn as the feed row it is. The anchor's `created_at` fixes
 * the entry's place for the turn's life; `updatedAt` moves with the newest
 * row folded into it, which is what makes a streaming turn follow the
 * scroll. Questions become references: their cards are `chat` entries of
 * their own, in time order, so the turn only says which ones it asked.
 */
export function toTurnEntry(
  turn: HarnessTurn,
  group: TurnGroup,
  agentId: string
): ChatTurnEntry {
  const anchor = group.turn ?? group.rows[0];
  const payload = group.turn ? (group.turn.payload as TurnPayload) : null;
  // A group with no turn row is closed by definition: it is history from
  // before turn rows existed. Otherwise the row itself says so.
  const settled = payload === null || payload.state === "settled";
  let updatedAt = anchor.updatedAt;
  for (const row of group.rows) {
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  // A turn the service went down under settles carrying the restart marker
  // as its error. That is a cut, not a failure the engine reported, so the
  // entry says `interrupted` and drops the marker rather than showing it as
  // an error line under the result.
  const byRestart = payload?.error === INTERRUPTED_BY_RESTART;
  const trace: ChatTurnEntry["trace"] = byRestart
    ? { ...turn.trace, finalResult: "interrupted" }
    : turn.trace;
  const error = byRestart ? undefined : turn.error;
  const questions: ChatTurnQuestionRef[] | undefined = turn.questions?.map(
    (q) => ({ messageId: q.id, answered: q.answer !== null })
  );
  return {
    type: "turn",
    id: turn.id,
    agentId,
    at: anchor.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    prompt: turn.prompt,
    trace,
    result: turn.result,
    settled,
    interrupted: trace.finalResult === "interrupted",
    ...(error ? { error } : {}),
    ...(turn.label ? { label: turn.label } : {}),
    ...(turn.plan ? { plan: turn.plan } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(questions ? { questions } : {}),
  };
}
```

- [ ] **Step 11: Point the harness route at the moved module**

In `apps/server/src/routes/agents/harness-routes.ts`, change line 11 from:

```ts
import { loadQueued, loadTurns } from "../../agents/harness/turns.js";
```

to:

```ts
import { loadQueued, loadTurns } from "../../chat/turns.js";
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-turns.test.ts test/harness-routes.test.ts test/chat-feed.test.ts`
Expected: PASS, all three files.

Run: `pnpm --filter @dispatch/shared check && pnpm --filter @dispatch/server check && pnpm run check:web`
Expected: no output from any of the three, exit 0.

- [ ] **Step 13: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add packages/shared/src apps/server/src/chat apps/server/src/routes/agents/harness-routes.ts apps/web/src/components/app/chat/chat-feed.tsx apps/server/test/harness-turns.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add the turn feed entry and move the assembler into chat/

A dispatch agent's activity reached the feed as loose assistant and
tool_call rows, which is why the Harness view had to compose turns a
second time. ChatTurnEntry carries one turn whole, and the assembler
that builds it now lives beside the feed it feeds. A pre-turn group is
named by its first row rather than its position, so a cursor over it has
a real row id to compare. The three switches over the entry union get
their turn arm here so the union change type-checks on its own.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `listTurnEntries`: one page of turn entries past the cursor

**Files:**

- Modify: `apps/server/src/chat/turns.ts` (add `listTurnEntries` and `loadLatestTurnEntry`)
- Test: `apps/server/test/chat-feed.test.ts` (new `describe("listTurnEntries")`)

**Interfaces:**

- Consumes: `Keyed`, `FeedCursor`, `cursorClause`, `AT_KEY_SQL`, `intKey` from `apps/server/src/chat/feed-cursor.ts`; `groupTurnRows`, `assembleTurns`, `toTurnEntry`, `TurnSourceRow` from Task 2.
- Produces, from `apps/server/src/chat/turns.ts`:
  - `function listTurnEntries(db: Queryable, agentId: string, cursor: FeedCursor | null, limit: number): Promise<Keyed<ChatTurnEntry>[]>`: newest first, at most `limit` entries.
  - `function loadLatestTurnEntry(db: Queryable, agentId: string): Promise<ChatTurnEntry | null>`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/chat-feed.test.ts`:

```ts
describe("listTurnEntries", () => {
  /**
   * `listTurnEntries` windows on `seq` and orders anchors on `created_at`,
   * which the recorder keeps in step (seq is MAX(seq)+1 per agent, created_at
   * is the insert's now()). These fixtures keep them in step too.
   */
  async function stream(
    rows: Array<{
      seq: number;
      kind: string;
      payload: Record<string, unknown>;
      at: number;
      updated?: number;
      key?: string;
    }>
  ) {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO agent_stream_events
           (agent_id, seq, kind, key, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          A,
          r.seq,
          r.kind,
          r.key ?? null,
          JSON.stringify(r.payload),
          at(r.at),
          at(r.updated ?? r.at),
        ]
      );
    }
  }

  const settledTurn = (text: string, ended: number) => ({
    state: "settled",
    prompt: { source: "system", text },
    stopReason: "end_turn",
    endedAt: at(ended).toISOString(),
  });

  it("returns one entry per turn, newest first, anchored on the turn row", async () => {
    await stream([
      { seq: 1, kind: "turn", payload: settledTurn("first", 3), at: 1 },
      {
        seq: 2,
        kind: "tool_call",
        key: "c1",
        payload: {
          toolKind: "read",
          title: "Read a",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: null,
        },
        at: 2,
        updated: 2,
      },
      {
        seq: 3,
        kind: "assistant",
        payload: { text: "Done one.", streaming: false },
        at: 3,
      },
      { seq: 4, kind: "turn", payload: settledTurn("second", 6), at: 4 },
      {
        seq: 5,
        kind: "assistant",
        payload: { text: "Done two.", streaming: false },
        at: 5,
        updated: 6,
      },
    ]);
    const page = await listTurnEntries(pool, A, null, 10);
    expect(page.map((k) => k.entry.prompt.text)).toEqual(["second", "first"]);
    const [second, first] = page;
    expect(first.entry.at).toBe(at(1).toISOString());
    expect(first.entry.result).toEqual({ text: "Done one.", streaming: false });
    expect(first.entry.trace.steps.map((s) => s.label)).toEqual(["Read a"]);
    expect(first.entry.settled).toBe(true);
    expect(second.entry.updatedAt).toBe(at(6).toISOString());
    // The cursor key is the anchor row's own id and microsecond time.
    expect(first.rawId).toMatch(/^\d+$/);
    expect(first.atKey).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("keeps rows before the first turn row as one closed synthetic turn", async () => {
    await stream([
      {
        seq: 1,
        kind: "assistant",
        payload: { text: "older history", streaming: false },
        at: 1,
        updated: 2,
      },
      { seq: 2, kind: "turn", payload: settledTurn("after", 5), at: 4 },
    ]);
    const page = await listTurnEntries(pool, A, null, 10);
    expect(page).toHaveLength(2);
    const pre = page[1];
    expect(pre.entry.id).toMatch(/^turn:pre:\d+$/);
    expect(pre.entry.prompt.text).toBe("Earlier activity");
    expect(pre.entry.settled).toBe(true);
    expect(pre.entry.at).toBe(at(1).toISOString());
  });

  it("pages by anchor and never re-reads a newer turn's rows", async () => {
    await stream([
      { seq: 1, kind: "turn", payload: settledTurn("one", 2), at: 1 },
      {
        seq: 2,
        kind: "assistant",
        payload: { text: "a", streaming: false },
        at: 2,
      },
      { seq: 3, kind: "turn", payload: settledTurn("two", 4), at: 3 },
      {
        seq: 4,
        kind: "assistant",
        payload: { text: "b", streaming: false },
        at: 4,
      },
      { seq: 5, kind: "turn", payload: settledTurn("three", 6), at: 5 },
      {
        seq: 6,
        kind: "assistant",
        payload: { text: "c", streaming: false },
        at: 6,
      },
    ]);
    const newest = await listTurnEntries(pool, A, null, 2);
    expect(newest.map((k) => k.entry.prompt.text)).toEqual(["three", "two"]);
    expect(newest.map((k) => k.entry.result?.text)).toEqual(["c", "b"]);
    const oldest = newest[newest.length - 1];
    const older = await listTurnEntries(
      pool,
      A,
      { at: oldest.atKey, type: "turn", id: oldest.rawId },
      2
    );
    expect(older.map((k) => k.entry.prompt.text)).toEqual(["one"]);
    expect(older[0].entry.result?.text).toBe("a");
  });

  it("carries an open turn with its live rail and growing text", async () => {
    await stream([
      {
        seq: 1,
        kind: "turn",
        payload: { state: "started", prompt: { source: "system", text: "go" } },
        at: 1,
      },
      {
        seq: 2,
        kind: "tool_call",
        key: "c1",
        payload: {
          toolKind: "execute",
          title: "bash",
          status: "in_progress",
          locations: [],
          diff: null,
          terminalOutput: null,
        },
        at: 2,
        updated: 4,
      },
      {
        seq: 3,
        kind: "assistant",
        payload: { text: "half", streaming: true },
        at: 3,
        updated: 5,
      },
    ]);
    const [live] = await listTurnEntries(pool, A, null, 10);
    expect(live.entry.settled).toBe(false);
    expect(live.entry.updatedAt).toBe(at(5).toISOString());
    expect(live.entry.result).toEqual({ text: "half", streaming: true });
    expect(live.entry.trace.steps[0]).toMatchObject({
      label: "bash",
      status: "running",
    });
    expect(live.entry.trace.endedAt).toBeUndefined();
  });

  it("joins the chat prompt and references a question asked during the turn", async () => {
    const prompt = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "look please",
      delivered: true,
    });
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [prompt.id, at(1)]
    );
    const question = await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "question",
      text: "Which one?",
      question: { options: [{ label: "A" }], allowFreeform: true },
    });
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [question.id, at(3)]
    );
    await stream([
      {
        seq: 1,
        kind: "turn",
        payload: {
          state: "settled",
          prompt: { source: "chat", chatMessageId: prompt.id },
          endedAt: at(4).toISOString(),
        },
        at: 2,
        updated: 4,
      },
    ]);
    const [entry] = await listTurnEntries(pool, A, null, 10);
    expect(entry.entry.prompt).toMatchObject({
      source: "chat",
      text: "look please",
      chatMessageId: prompt.id,
    });
    expect(entry.entry.questions).toEqual([
      { messageId: question.id, answered: false },
    ]);
  });

  it("hands back nothing for an agent with no stream rows", async () => {
    expect(await listTurnEntries(pool, A, null, 10)).toEqual([]);
    expect(await loadLatestTurnEntry(pool, A)).toBeNull();
  });

  it("loadLatestTurnEntry composes only the newest turn", async () => {
    await stream([
      { seq: 1, kind: "turn", payload: settledTurn("old", 2), at: 1 },
      {
        seq: 2,
        kind: "assistant",
        payload: { text: "old answer", streaming: false },
        at: 2,
      },
      {
        seq: 3,
        kind: "turn",
        payload: {
          state: "started",
          prompt: { source: "system", text: "new" },
        },
        at: 3,
      },
      {
        seq: 4,
        kind: "assistant",
        payload: { text: "new answer", streaming: true },
        at: 4,
        updated: 5,
      },
    ]);
    const entry = await loadLatestTurnEntry(pool, A);
    expect(entry?.prompt.text).toBe("new");
    expect(entry?.result?.text).toBe("new answer");
    expect(entry?.settled).toBe(false);
  });
});
```

Add the import at the top of the file, after the `../src/chat/feed.js` import block:

```ts
import { listTurnEntries, loadLatestTurnEntry } from "../src/chat/turns.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-feed.test.ts`
Expected: FAIL at collection with `does not provide an export named 'listTurnEntries'`.

- [ ] **Step 3: Implement `listTurnEntries` and `loadLatestTurnEntry`**

Append to `apps/server/src/chat/turns.ts` (after `toTurnEntry`, before `loadTurns`):

```ts
type StreamRowResult = {
  id: number | string;
  seq: number;
  kind: StreamEventRow["kind"];
  key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  at_key: string;
};

/**
 * One page of turn entries, newest first, past `cursor`.
 *
 * The anchors are the `turn` rows, plus the agent's oldest stream row when
 * that row is not itself a turn row: the rows recorded before turn rows
 * existed assemble into one closed synthetic turn, and it needs an anchor
 * of its own to sort and page by. The page's rows are everything from the
 * oldest selected anchor up to, but not including, the first turn row above
 * the page, so paging older never re-reads a newer turn and a turn belongs
 * wholly to the page its anchor falls on.
 */
export async function listTurnEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatTurnEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("turn", "int", cursor, params);
  params.push(limit);
  const anchors = await db.query<{ id: number | string; seq: number }>(
    `SELECT id, seq
       FROM agent_stream_events
      WHERE agent_id = $1
        AND (
          kind = 'turn'
          OR seq = (
            SELECT min(seq) FROM agent_stream_events WHERE agent_id = $1
          )
        ) ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  if (anchors.rows.length === 0) return [];
  const seqs = anchors.rows.map((r) => r.seq);
  const fromSeq = Math.min(...seqs);
  const maxSeq = Math.max(...seqs);
  const above = await db.query<{ seq: number; created_at: Date }>(
    `SELECT seq, created_at
       FROM agent_stream_events
      WHERE agent_id = $1 AND kind = 'turn' AND seq > $2
      ORDER BY seq ASC
      LIMIT 1`,
    [agentId, maxSeq]
  );
  const untilSeq = above.rows[0]?.seq ?? null;
  const untilAt = above.rows[0]?.created_at ?? null;
  const rows = await db.query<StreamRowResult>(
    `SELECT id, seq, kind, key, payload, created_at, updated_at,
            ${AT_KEY_SQL} AS at_key
       FROM agent_stream_events
      WHERE agent_id = $1 AND seq >= $2
        AND ($3::int IS NULL OR seq < $3)
      ORDER BY seq ASC`,
    [agentId, fromSeq, untilSeq]
  );
  const source: TurnSourceRow[] = [];
  // The cursor needs the anchor row's microsecond time, which only Postgres
  // can render exactly; the ISO form the entry exposes is milliseconds.
  const atKeyById = new Map<number, string>();
  for (const r of rows.rows) {
    const id = Number(r.id);
    atKeyById.set(id, r.at_key);
    source.push({
      id,
      seq: r.seq,
      kind: r.kind,
      key: r.key,
      payload: r.payload,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  const chat = await loadChatMessages(db, chatPromptIds(source));
  // Questions the agent asked while this page's turns ran. Bounded above as
  // well as below: a question from a newer turn would otherwise attach to
  // this page's last turn, which is the one that had started when it landed.
  const since = source.length ? source[0].createdAt : new Date(0);
  const asked = await db.query(
    `SELECT * FROM agent_chat_messages
      WHERE agent_id = $1 AND author_kind = 'agent' AND kind = 'question'
        AND created_at >= $2
        AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at ASC`,
    [agentId, since, untilAt]
  );
  const questions = asked.rows.map((row) => toChatMessage(row as never));
  const groups = groupTurnRows(source);
  const turns = assembleTurns(source, chat, questions);
  const keyed: Keyed<ChatTurnEntry>[] = [];
  turns.forEach((turn, index) => {
    const group = groups[index];
    if (!group) return;
    const anchor = group.turn ?? group.rows[0];
    const atKey = atKeyById.get(anchor.id);
    if (atKey === undefined) return;
    keyed.push({
      entry: toTurnEntry(turn, group, agentId),
      atKey,
      rawId: String(anchor.id),
      idKey: intKey(anchor.id),
    });
  });
  // Assembly runs oldest first; the feed merges newest first.
  return keyed.reverse();
}

/** The chat message ids the page's turn rows name as their prompt. */
function chatPromptIds(rows: TurnSourceRow[]): string[] {
  return rows
    .filter((r) => r.kind === "turn")
    .map((r) => (r.payload as TurnPayload).prompt)
    .filter(
      (p): p is Extract<PromptSource, { source: "chat" }> => p.source === "chat"
    )
    .map((p) => p.chatMessageId);
}

/**
 * The agent's newest turn as one feed entry, for the row-level event the
 * recorder's flush publishes. Null when the agent has no stream rows.
 */
export async function loadLatestTurnEntry(
  db: Queryable,
  agentId: string
): Promise<ChatTurnEntry | null> {
  const [newest] = await listTurnEntries(db, agentId, null, 1);
  return newest?.entry ?? null;
}
```

Add the cursor-primitive import to the top of `apps/server/src/chat/turns.ts`, after the `@dispatch/shared` block:

```ts
import {
  AT_KEY_SQL,
  cursorClause,
  type FeedCursor,
  intKey,
  type Keyed,
} from "./feed-cursor.js";
```

Also change `loadTurns`'s body to reuse `chatPromptIds` instead of its inline copy: replace

```ts
const chatIds = source
  .filter((r) => r.kind === "turn")
  .map((r) => (r.payload as TurnPayload).prompt)
  .filter(
    (p): p is Extract<PromptSource, { source: "chat" }> => p.source === "chat"
  )
  .map((p) => p.chatMessageId);
const chat = await loadChatMessages(db, chatIds);
```

with

```ts
const chat = await loadChatMessages(db, chatPromptIds(source));
```

and add this line to `loadTurns`'s doc comment, so nobody adds a caller:

```ts
/**
 * The newest `limit` turns for an agent, with their chat prompts joined.
 *
 * Only `GET /api/v1/agents/:id/harness/turns` still reads this; the feed
 * reads {@link listTurnEntries}. Plan 4 of the one-feed work deletes both.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-feed.test.ts test/harness-turns.test.ts`
Expected: PASS, both files; the new `listTurnEntries` describe reports 7 passing tests.

Run: `pnpm --filter @dispatch/server check`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/chat/turns.ts apps/server/test/chat-feed.test.ts
git commit -m "$(cat <<'EOF'
feat(server): compose turn feed entries by anchor row

The Harness view read turns by turn count while the feed read rows by a
composite cursor, so the two could not share a page. listTurnEntries
windows on the anchor turn row instead: it selects the anchors past the
cursor, loads only the rows between the oldest of them and the first
anchor above the page, and returns one keyed entry per turn. A turn
therefore belongs wholly to one page and no boundary splits it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `composeChatFeed` serves turns instead of flat stream rows

**Files:**

- Modify: `apps/server/src/chat/feed.ts:193-266` (the chat page's dedup), `:508-575` (delete `listStreamEntries`), `:646-700` (the composer)
- Test: `apps/server/test/chat-feed.test.ts` (replace `describe("stream sources")`)

**Interfaces:**

- Consumes: `listTurnEntries` from Task 3.
- Produces: `composeChatFeed` returns `turn` entries in place of `assistant` and `activity` entries. `listStreamEntries` is gone. A chat row named as a turn's prompt is no longer listed as its own `chat` entry, on any page and through `loadChatMessageEntry`.

- [ ] **Step 1: Clear `pin_events` between tests**

`apps/server/test/chat-feed.test.ts`'s `beforeEach` truncates six tables but not `pin_events`, which nothing in the file wrote until now. Add the line so the pin row one of the new tests seeds cannot leak into the next:

```ts
beforeEach(async () => {
  await pool.query("DELETE FROM agent_chat_messages");
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM agent_messages");
  await pool.query("DELETE FROM media");
  await pool.query("DELETE FROM reviews");
  await pool.query("DELETE FROM pin_events");
  await pool.query("DELETE FROM agent_stream_events");
});
```

- [ ] **Step 2: Write the failing test**

In `apps/server/test/chat-feed.test.ts`, replace the whole `describe("stream sources", () => { ... });` block (both of its tests) with:

```ts
describe("turn entries in the feed", () => {
  const settledTurn = (text: string, ended: number) => ({
    state: "settled",
    prompt: { source: "system", text },
    stopReason: "end_turn",
    endedAt: at(ended).toISOString(),
  });

  async function turnRow(
    seq: number,
    payload: Record<string, unknown>,
    when: number,
    updated = when
  ) {
    await pool.query(
      `INSERT INTO agent_stream_events
         (agent_id, seq, kind, payload, created_at, updated_at)
       VALUES ($1, $2, 'turn', $3::jsonb, $4, $5)`,
      [A, seq, JSON.stringify(payload), at(when), at(updated)]
    );
  }

  async function assistantRow(
    seq: number,
    text: string,
    when: number,
    updated = when
  ) {
    await pool.query(
      `INSERT INTO agent_stream_events
         (agent_id, seq, kind, payload, created_at, updated_at)
       VALUES ($1, $2, 'assistant', $3::jsonb, $4, $5)`,
      [
        A,
        seq,
        JSON.stringify({ text, streaming: false }),
        at(when),
        at(updated),
      ]
    );
  }

  it("orders a turn at its anchor among chat, review, pin, status and media rows", async () => {
    await pool.query(
      `INSERT INTO agent_events (agent_id, event_type, message, created_at)
       VALUES ($1, 'working', 'reading', $2)`,
      [A, at(1)]
    );
    const m = await store.insert({
      agentId: A,
      authorKind: "agent",
      text: "hi",
    });
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [m.id, at(6)]
    );
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description, created_at)
       VALUES ($1, 'shot.png', 'screenshot', 10, 'a shot', $2)`,
      [A, at(7)]
    );
    await pool.query(
      `INSERT INTO reviews (agent_id, reviewer_type, summary, created_at)
       VALUES ($1, 'human', 'looks fine', $2)`,
      [A, at(8)]
    );
    await pool.query(
      `INSERT INTO pin_events (agent_id, action, pin_id, label, created_at)
       VALUES ($1, 'created', 'pin_1', 'Dev URL', $2)`,
      [A, at(9)]
    );
    await turnRow(1, settledTurn("do it", 4), 2, 4);
    await assistantRow(2, "Done.", 3, 4);

    const feed = await composeChatFeed(store, A);
    expect(feed.entries.map((e) => e.type)).toEqual([
      "status",
      "turn",
      "chat",
      "media",
      "review",
      "pin",
    ]);
    const turn = feed.entries[1];
    if (turn.type !== "turn") throw new Error("expected a turn entry");
    expect(turn.at).toBe(at(2).toISOString());
    expect(turn.id).toMatch(/^turn:\d+$/);
    expect(turn.agentId).toBe(A);
    expect(turn.prompt.text).toBe("do it");
    expect(turn.result).toEqual({ text: "Done.", streaming: false });
    expect(turn.settled).toBe(true);
    expect(turn.interrupted).toBe(false);
  });

  it("pages by anchor between two turns and repeats neither", async () => {
    await turnRow(1, settledTurn("one", 2), 1, 2);
    await assistantRow(2, "a", 2);
    await turnRow(3, settledTurn("two", 4), 3, 4);
    await assistantRow(4, "b", 4);

    const page1 = await composeChatFeed(store, A, { limit: 1 });
    expect(page1.hasMore).toBe(true);
    expect(page1.entries.map((e) => e.type)).toEqual(["turn"]);
    const page2 = await composeChatFeed(store, A, {
      limit: 1,
      cursor: decodeFeedCursor(page1.nextCursor!),
    });
    expect(page2.hasMore).toBe(false);
    const prompts = [...page2.entries, ...page1.entries].map((e) =>
      e.type === "turn" ? e.prompt.text : ""
    );
    expect(prompts).toEqual(["one", "two"]);
    const results = [...page2.entries, ...page1.entries].map((e) =>
      e.type === "turn" ? e.result?.text : ""
    );
    expect(results).toEqual(["a", "b"]);
  });

  it("returns a turn whole even when its rows straddle the page limit", async () => {
    await turnRow(1, settledTurn("old", 2), 1, 2);
    await assistantRow(2, "old answer", 2);
    await turnRow(3, settledTurn("big", 9), 3, 9);
    for (let i = 0; i < 5; i += 1) {
      await assistantRow(4 + i, `chunk ${i}`, 4 + i);
    }
    // Two entries either way: the limit counts entries, not stream rows.
    const feed = await composeChatFeed(store, A, { limit: 2 });
    expect(feed.hasMore).toBe(false);
    expect(feed.entries.map((e) => e.type)).toEqual(["turn", "turn"]);
    const big = feed.entries[1];
    if (big.type !== "turn") throw new Error("expected a turn entry");
    expect(big.trace.steps.map((s) => s.label)).toEqual([
      "chunk 0",
      "chunk 1",
      "chunk 2",
      "chunk 3",
    ]);
    expect(big.result?.text).toBe("chunk 4");
  });

  it("carries an interrupted turn with its flag and final result", async () => {
    await turnRow(
      1,
      {
        state: "settled",
        prompt: { source: "system", text: "stopped" },
        stopReason: "cancelled",
        endedAt: at(3).toISOString(),
      },
      1,
      3
    );
    await assistantRow(2, "half", 2);
    const feed = await composeChatFeed(store, A);
    const turn = feed.entries[0];
    if (turn.type !== "turn") throw new Error("expected a turn entry");
    expect(turn.interrupted).toBe(true);
    expect(turn.trace.finalResult).toBe("interrupted");
    expect(turn.settled).toBe(true);
  });

  it("lists a question asked during a turn once, as a chat entry the turn references", async () => {
    const question = await store.insert({
      agentId: A,
      authorKind: "agent",
      kind: "question",
      text: "Which one?",
      question: { options: [{ label: "A" }], allowFreeform: true },
    });
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [question.id, at(3)]
    );
    await turnRow(1, settledTurn("asking", 5), 1, 5);
    const feed = await composeChatFeed(store, A);
    expect(feed.entries.map((e) => e.type)).toEqual(["turn", "chat"]);
    const turn = feed.entries[0];
    if (turn.type !== "turn") throw new Error("expected a turn entry");
    expect(turn.questions).toEqual([
      { messageId: question.id, answered: false },
    ]);
    expect(feed.entries[1]).toMatchObject({ id: question.id });
  });

  it("does not list the chat row a turn used as its prompt", async () => {
    const prompt = await store.insert({
      agentId: A,
      authorKind: "user",
      text: "look please",
      delivered: true,
    });
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [prompt.id, at(1)]
    );
    const reply = await store.insert({
      agentId: A,
      authorKind: "agent",
      text: "an extra post",
    });
    await pool.query(
      `UPDATE agent_chat_messages SET created_at = $2 WHERE id = $1`,
      [reply.id, at(6)]
    );
    await turnRow(
      1,
      {
        state: "settled",
        prompt: { source: "chat", chatMessageId: prompt.id },
        endedAt: at(4).toISOString(),
      },
      2,
      4
    );
    const feed = await composeChatFeed(store, A);
    expect(feed.entries.map((e) => e.type)).toEqual(["turn", "chat"]);
    const turn = feed.entries[0];
    if (turn.type !== "turn") throw new Error("expected a turn entry");
    expect(turn.prompt).toMatchObject({
      source: "chat",
      text: "look please",
      chatMessageId: prompt.id,
    });
    expect(feed.entries[1]).toMatchObject({ id: reply.id });
    // The prompt row is not on this feed at all, so no page can bring it back.
    expect(await loadChatMessageEntry(pool, A, prompt.id)).toBeNull();
    expect(await loadChatMessageEntry(pool, A, reply.id)).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-feed.test.ts`
Expected: FAIL, six failures in `turn entries in the feed`, the first reporting `["status","assistant","chat","media","review","pin"]` where `"turn"` was expected.

- [ ] **Step 4: Filter a turn's prompt row out of the chat page**

In `apps/server/src/chat/feed.ts`, inside `listChatEntries`'s SQL, replace:

```sql
        WHERE m.agent_id = $1 ${clause}
```

with:

```sql
        WHERE m.agent_id = $1
          -- A chat row that opened a turn is rendered by that turn entry,
          -- prompt text and attachments included, so listing it again would
          -- show the prompt twice. Every other chat row stays an entry of
          -- its own: an agent post, a question, an answer. Checked against
          -- every turn row on the agent rather than this page's, so paging
          -- cannot make a prompt reappear.
          AND NOT EXISTS (
            SELECT 1
              FROM agent_stream_events s
             WHERE s.agent_id = $1
               AND s.kind = 'turn'
               AND s.payload->'prompt'->>'chatMessageId' = m.id::text
          ) ${clause}
```

No index sits behind `payload->'prompt'->>'chatMessageId'`, so Postgres plans this as an anti-join over the agent's `turn` rows once per chat page, reached through `agent_stream_events_agent_created`. At Dispatch's row counts (tens to low thousands of turn rows per agent) that is cheaper than the index would be to maintain, so it needs no migration.

- [ ] **Step 5: Swap the source in the composer and delete `listStreamEntries`**

In `apps/server/src/chat/feed.ts`, delete the whole `listStreamEntries` function together with its doc comment (the block from `/**\n * Stream rows from a protocol-driven harness (over ACP): assistant text` through the closing brace of the function).

In `composeChatFeed`, rename the destructured `stream` binding to `turns` and swap the call:

```ts
const [chat, status, agentMessages, media, reviews, turns, pins, unreadCount] =
  await Promise.all([
    listChatEntries(db, agentId, cursor, limit + 1),
    listStatusEntries(db, agentId, cursor, limit + 1),
    listAgentMessageEntries(db, agentId, cursor, limit + 1),
    listMediaEntries(db, agentId, cursor, limit + 1),
    listReviewEntries(db, agentId, cursor, limit + 1),
    listTurnEntries(db, agentId, cursor, limit + 1),
    listPinEntries(db, agentId, cursor, limit + 1),
    store.countUnread(agentId),
  ]);

const merged: Keyed<ChatFeedEntry>[] = [
  ...chat,
  ...status,
  ...agentMessages,
  ...media,
  ...reviews,
  ...turns,
  ...pins,
].sort(compareNewestFirst);
```

Update the composer's doc comment to name the source:

```ts
/**
 * Compose one agent's Chat feed at read time from chat messages, status
 * events, cross-agent messages, shared media, reviews, harness turns, and
 * pin activity. Each source contributes its newest `limit + 1` rows past the
 * cursor; the merge keeps the newest `limit` overall, so any row that belongs
 * on the page is present (a row in the top `limit` overall is in the top
 * `limit` of its source), and anything left over proves an older page exists.
 */
```

Add the import and drop the two now-unused payload types. Replace the `@dispatch/shared` and stream-store import blocks at the top of the file with:

```ts
import type {
  ChatAgentMessageEntry,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatMessageEntry,
  ChatPinEntry,
  ChatReviewEntry,
  ChatStatusEntry,
} from "@dispatch/shared";

import { dimensionFields, parseMediaMetadata } from "../media/metadata.js";
```

and add, after the `./feed-cursor.js` import block:

```ts
import { listTurnEntries } from "./turns.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-feed.test.ts test/chat-routes.test.ts test/pin-events.test.ts test/harness-routes.test.ts`
Expected: PASS, all four files.

Run: `pnpm --filter @dispatch/server check`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/chat/feed.ts apps/server/test/chat-feed.test.ts
git commit -m "$(cat <<'EOF'
feat(server): serve harness turns in the chat feed

Two readers walked the same stream rows and produced different shapes:
the feed emitted loose assistant and tool_call entries while the Harness
view assembled turns. The feed now takes its stream source from
listTurnEntries, so a dispatch agent's activity arrives as one entry per
turn beside the reviews, pins, status lines and media it already carried.
The chat row a turn used as its prompt is filtered out, since the turn
renders it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `GET /api/v1/agents/:id/harness/queue`

The queue is live in-memory state, not a feed row, and today it rides on the `/harness/turns` response that plan 4 deletes. It gets a route of its own beside the send-now and remove routes that already live at that path.

**Files:**

- Modify: `packages/shared/src/harness-types.ts` (add `HarnessQueueResponse`), `packages/shared/src/index.ts`
- Modify: `apps/server/src/routes/agents/harness-routes.ts:96-98`
- Test: `apps/server/test/harness-routes.test.ts` (new `describe`)

**Interfaces:**

- Consumes: `loadQueued(db, queued)` from `apps/server/src/chat/turns.ts`.
- Produces:
  - `type HarnessQueueResponse = { queued: HarnessQueuedPrompt[] }` from `@dispatch/shared`.
  - `GET /api/v1/agents/:id/harness/queue` -> `200 { queued: HarnessQueuedPrompt[] }`, `404 { error: "Agent not found." }` for an unknown or deleted agent.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/harness-routes.test.ts`:

```ts
describe("GET /api/v1/agents/:id/harness/queue", () => {
  it("returns an empty queue for a running agent and 404s for an unknown one", async () => {
    const empty = await authedGet(`/api/v1/agents/${agentId}/harness/queue`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ queued: [] });
    const missing = await authedGet("/api/v1/agents/agt_nope/harness/queue");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Agent not found.");
  });

  it("shapes a queued chat prompt with its chat text joined", async () => {
    const app = Fastify();
    const chat = await ctx.pool.query<{ id: string }>(
      `INSERT INTO agent_chat_messages
         (id, agent_id, author_kind, kind, text, attachments, delivered)
       VALUES (gen_random_uuid(), $1, 'user', 'reply', 'queued please',
               '[]'::jsonb, NULL)
       RETURNING id`,
      [agentId]
    );
    const chatId = chat.rows[0].id;
    await registerAgentHarnessRoutes(app, {
      pool: ctx.pool,
      harness: {
        getConfigOptions: () => null,
        setConfigOption: async () => [],
        getCommands: () => null,
        listQueued: () => [
          {
            id: chatId,
            source: { source: "chat", chatMessageId: chatId },
            createdAt: "2026-09-08T10:00:00.000Z",
          },
          {
            id: "q_2",
            source: {
              source: "agent",
              senderId: "agt_other",
              senderName: "Reviewer",
              text: "take a look",
            },
            createdAt: "2026-09-08T10:00:01.000Z",
          },
        ],
        sendQueuedNow: async () => false,
        removeQueued: () => false,
        interrupt: async () => false,
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/queue`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      queued: [
        {
          id: chatId,
          source: "chat",
          text: "queued please",
          chatMessageId: chatId,
          attachments: [],
          createdAt: "2026-09-08T10:00:00.000Z",
        },
        {
          id: "q_2",
          source: "agent",
          text: "take a look",
          senderName: "Reviewer",
          attachments: [],
          createdAt: "2026-09-08T10:00:01.000Z",
        },
      ],
    });
    await app.close();
  });
});
```

Add these two imports to the top of `apps/server/test/harness-routes.test.ts`:

```ts
import Fastify from "fastify";

import { registerAgentHarnessRoutes } from "../src/routes/agents/harness-routes.js";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-routes.test.ts`
Expected: FAIL, two failures in `GET /api/v1/agents/:id/harness/queue`; the first reports `404` where `200` was expected (Fastify has no such route).

- [ ] **Step 3: Add the response type**

In `packages/shared/src/harness-types.ts`, immediately after `HarnessQueuedPrompt`'s closing `};`, add:

```ts
/** `GET /api/v1/agents/:id/harness/queue`: what waits behind the live turn. */
export type HarnessQueueResponse = { queued: HarnessQueuedPrompt[] };
```

In `packages/shared/src/index.ts`, add `HarnessQueueResponse,` to the `from "./harness-types.js"` type export list, right after `HarnessQueuedPrompt,`.

- [ ] **Step 4: Add the route**

In `apps/server/src/routes/agents/harness-routes.ts`, add the route immediately after the `/harness/turns` handler's closing `});` and before the `// The queue: a prompt that has not started can jump the line or leave it.` comment:

```ts
// What waits behind the running turn. In-memory supervisor state, not a
// feed row: the composer reads it from here rather than from the turns.
app.get("/api/v1/agents/:id/harness/queue", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  const response: HarnessQueueResponse = {
    queued: await loadQueued(deps.pool, deps.harness.listQueued(id)),
  };
  return response;
});
```

Add `HarnessQueueResponse` to the file's `@dispatch/shared` type import list, in alphabetical position after `HarnessPathsResponse,`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-routes.test.ts`
Expected: PASS, including the two new tests.

Run: `pnpm --filter @dispatch/shared check && pnpm --filter @dispatch/server check`
Expected: no output from either, exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add packages/shared/src apps/server/src/routes/agents/harness-routes.ts apps/server/test/harness-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(server): serve the harness queue on its own route

The queue rode on the /harness/turns response, which the one-feed work
deletes once the feed carries turns. GET /harness/queue returns the same
shaped list from loadQueued, so the composer can read it without the
turns endpoint.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The per-flush `chat.entry` for the live turn

The recorder rewrites a row at most every 100 ms and the supervisor announces each flush through `publishHarness`. That hook now also composes the affected turn (always the newest one: the recorder only ever writes into it) and publishes one `chat.entry` carrying the whole entry, the way a status row already does. `upsertFeedEntry` replaces an entry by `type:id` in whichever page holds it, so a turn deep in the feed updates without a refetch.

**Files:**

- Modify: `apps/server/src/chat/service.ts` (add `publishTurnEntry`)
- Modify: `apps/server/src/server.ts:489-490`
- Test: `apps/server/test/chat-service.test.ts` (new `describe`)

**Interfaces:**

- Consumes: `loadLatestTurnEntry` from Task 3.
- Produces: `ChatService.publishTurnEntry(agentId: string): Promise<void>`: publishes one `{ type: "chat.entry", agentId, entry }` whose `entry.type` is `"turn"`, or nothing when the agent has no stream rows. Never rejects.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/chat-service.test.ts`:

```ts
describe("publishTurnEntry", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, s));

  it("publishes the newest turn as one feed entry", async () => {
    await pool.query("DELETE FROM agent_stream_events");
    await pool.query(
      `INSERT INTO agent_stream_events
         (agent_id, seq, kind, payload, created_at, updated_at)
       VALUES ($1, 1, 'turn', $2::jsonb, $3, $4),
              ($1, 2, 'assistant', $5::jsonb, $4, $6)`,
      [
        A,
        JSON.stringify({
          state: "started",
          prompt: { source: "system", text: "go" },
        }),
        at(1),
        at(2),
        JSON.stringify({ text: "working on it", streaming: true }),
        at(5),
      ]
    );
    published.length = 0;
    await service.publishTurnEntry(A);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "chat.entry",
      agentId: A,
      entry: {
        type: "turn",
        agentId: A,
        at: at(1).toISOString(),
        updatedAt: at(5).toISOString(),
        settled: false,
        result: { text: "working on it", streaming: true },
      },
    });
  });

  it("publishes nothing for an agent with no stream rows", async () => {
    await pool.query("DELETE FROM agent_stream_events");
    published.length = 0;
    await service.publishTurnEntry(A);
    expect(published).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-service.test.ts`
Expected: FAIL with `service.publishTurnEntry is not a function`.

- [ ] **Step 3: Add `publishTurnEntry` to `ChatService`**

In `apps/server/src/chat/service.ts`, change the `./feed.js` import to:

```ts
import { loadChatMessageEntry } from "./feed.js";
import { loadLatestTurnEntry } from "./turns.js";
```

Then add the method immediately after `publishHarnessChanged`:

```ts
  /**
   * The agent's newest harness turn as the feed row it now is, so a mounted
   * feed replaces that one row instead of refetching every page it holds.
   * The newest turn is always the affected one: the recorder only ever
   * writes into the turn it opened last. A flush that changed nothing about
   * any turn (a queue edit) still publishes, and the client's upsert is a
   * no-op when the row is unchanged.
   *
   * Never rejects: a stream write must not fail because its announcement did.
   */
  async publishTurnEntry(agentId: string): Promise<void> {
    try {
      const entry = await loadLatestTurnEntry(this.store.db, agentId);
      if (entry) {
        this.deps.publishUiEvent({ type: "chat.entry", agentId, entry });
      }
    } catch (error) {
      this.log.warn(
        { err: error, agentId },
        "chat: could not compose the harness turn for its feed event"
      );
    }
  }
```

- [ ] **Step 4: Call it from the supervisor's publish hook**

In `apps/server/src/server.ts`, replace lines 489-490:

```ts
  publishHarness: (agentId, config) =>
    chatService.publishHarnessChanged(agentId, config),
```

with:

```ts
  // Every flush announces itself twice for now: the coarse harness.changed
  // the Harness view still listens for, and the affected turn as one feed
  // row. Plan 4 of the one-feed work drops the coarse half.
  publishHarness: (agentId, config) => {
    chatService.publishHarnessChanged(agentId, config);
    void chatService.publishTurnEntry(agentId);
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/chat-service.test.ts test/harness-supervisor.test.ts`
Expected: PASS, both files.

Run: `pnpm --filter @dispatch/server check`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/chat/service.ts apps/server/src/server.ts apps/server/test/chat-service.test.ts
git commit -m "$(cat <<'EOF'
feat(server): publish the live turn as one chat.entry per flush

Every streamed chunk made the client refetch the whole feed, because a
stream write only announced itself as the coarse harness.changed. The
supervisor's publish hook now also composes the newest turn and sends it
as a chat.entry, which the client places in whichever page holds it. One
composition per flush costs one bounded query, not a feed page.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The turn components move under `chat/turn/`

A pure move plus the import fixes it forces. `harness/turn-stream.tsx` and `harness/harness-pane.tsx` are **not** moved, renamed or deleted here: they keep rendering for dispatch agents in this stage and simply import from the new location. Plan 3 deletes them.

**Files:**

- Move (with `git mv`), from `apps/web/src/components/app/harness/` to `apps/web/src/components/app/chat/turn/`: `activity-block.tsx`, `activity-block.test.tsx`, `contracts.ts`, `motion.ts`, `motion.test.ts`, `prompt-line.tsx`, `prompt-line.test.tsx`, `queued-prompt.tsx`, `registry.ts`, `registry.test.ts`, `result-turn.tsx`, `shortcut-row.tsx`, `step-detail.tsx`, `step-row.tsx`, `step-row.test.tsx`, `tasks-strip.tsx`, `todo-list.tsx`, `todo-list.test.tsx`, `trace.ts`, `trace.test.ts`, `turn-shortcuts.tsx`; and `harness-context.tsx` to `chat/turn/turn-context.tsx`
- Create: `apps/web/src/components/app/chat/turn/diff-block.tsx`, `apps/web/src/components/app/chat/turn/diff-block.test.tsx`
- Delete: `apps/web/src/components/app/chat/stream-entries.test.tsx`
- Modify: `apps/web/src/components/app/chat/stream-entries.tsx`, `apps/web/src/components/app/harness/{turn-stream.tsx,harness-pane.tsx,harness-pane.test.tsx,use-harness-turns.ts}`, and the moved files' cross-boundary imports

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `apps/web/src/components/app/chat/turn/diff-block.tsx`: `type DiffLine = { kind: "same" | "add" | "del"; text: string }`, `function diffLines(oldText: string | null, newText: string): DiffLine[]`, `function DiffBlock({ oldText, newText }: { oldText: string | null; newText: string }): JSX.Element` (testid `chat-activity-diff`, unchanged).
  - `apps/web/src/components/app/chat/turn/turn-context.tsx`: `type TurnContextValue = { agent: Agent | null }`, `const INERT_TURN_CONTEXT: TurnContextValue`, `const TurnContext`, `function TurnContextProvider({ value, children }): JSX.Element`, `function useTurnContext(): TurnContextValue`.
  - `apps/web/src/components/app/chat/turn/activity-block.tsx` additionally exports `function showsActivity(trace: Trace | null | undefined): trace is Trace`.
  - `apps/web/src/components/app/chat/turn/result-turn.tsx`'s `ResultTurn` takes a new `showTime?: boolean` prop, default `true`.
  - Every other moved module keeps its exports and its testids; only its path changes.

- [ ] **Step 1: Record the green baseline**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness src/components/app/chat`
Expected: PASS. Note the file and test counts; Step 8 compares against them.

- [ ] **Step 2: Move the files**

```bash
cd /home/nii/.dispatch/server-dsh-harness
BASE=apps/web/src/components/app
mkdir -p "$BASE/chat/turn"
for f in activity-block.tsx activity-block.test.tsx contracts.ts motion.ts \
         motion.test.ts prompt-line.tsx prompt-line.test.tsx queued-prompt.tsx \
         registry.ts registry.test.ts result-turn.tsx shortcut-row.tsx \
         step-detail.tsx step-row.tsx step-row.test.tsx tasks-strip.tsx \
         todo-list.tsx todo-list.test.tsx trace.ts trace.test.ts \
         turn-shortcuts.tsx; do
  git mv "$BASE/harness/$f" "$BASE/chat/turn/$f"
done
git mv "$BASE/harness/harness-context.tsx" "$BASE/chat/turn/turn-context.tsx"
git rm "$BASE/chat/stream-entries.test.tsx"
```

Expected: no output from `git mv`, and `rm 'apps/web/src/components/app/chat/stream-entries.test.tsx'` from `git rm`.

- [ ] **Step 3: Create `chat/turn/diff-block.tsx`**

Write the whole file, cutting the four declarations out of `chat/stream-entries.tsx`:

```tsx
import { useMemo } from "react";

import { cn } from "@/lib/utils";

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/**
 * Line-aligned diff over the two texts (longest common subsequence). Bounded:
 * past the cell budget it falls back to "everything removed, everything
 * added", which is still honest, just less pretty. A null old text is an
 * empty file, so a new file is pure additions.
 */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const a = oldText === null || oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const CELL_BUDGET = 250_000;
  if (a.length * b.length > CELL_BUDGET) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

const DIFF_LINE_CLASS: Record<DiffLine["kind"], string> = {
  same: "text-muted-foreground",
  add: "bg-status-done/10 text-status-done",
  del: "bg-status-blocked/10 text-status-blocked",
};
const DIFF_SIGN: Record<DiffLine["kind"], string> = {
  same: " ",
  add: "+",
  del: "-",
};

export function DiffBlock({
  oldText,
  newText,
}: {
  oldText: string | null;
  newText: string;
}): JSX.Element {
  // An open diff survives every feed refetch; do not realign it each time.
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <pre
      className="max-h-64 overflow-auto rounded-md bg-muted font-terminal text-[11px] leading-snug"
      data-testid="chat-activity-diff"
    >
      {lines.map((line, index) => (
        <div
          key={index}
          data-kind={line.kind}
          className={cn("flex min-w-0 px-2", DIFF_LINE_CLASS[line.kind])}
        >
          <span aria-hidden="true" className="w-4 shrink-0 select-none">
            {DIFF_SIGN[line.kind]}
          </span>
          <span className="whitespace-pre">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}
```

- [ ] **Step 4: Create `chat/turn/diff-block.test.tsx`**

Write the whole file (the three cases from the deleted `chat/stream-entries.test.tsx`):

```tsx
import { describe, expect, it } from "vitest";

import { diffLines } from "@/components/app/chat/turn/diff-block";

describe("diffLines", () => {
  it("aligns an insertion without marking every following line", () => {
    const out = diffLines("a\nb\nc", "x\na\nb\nc");
    expect(out).toEqual([
      { kind: "add", text: "x" },
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  it("treats a null old text as an empty file", () => {
    expect(diffLines(null, "one\ntwo")).toEqual([
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]);
  });

  it("marks a replaced line as one removal and one addition", () => {
    expect(diffLines("a\nb", "a\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });
});
```

- [ ] **Step 5: Strip the diff helpers out of `chat/stream-entries.tsx`**

In `apps/web/src/components/app/chat/stream-entries.tsx`:

Change the React import from `import { useMemo, useState } from "react";` to `import { useState } from "react";`.

Add, after the `@/lib/utils` import:

```tsx
import { DiffBlock } from "@/components/app/chat/turn/diff-block";
```

Delete the `DiffLine` type, `diffLines`, `DIFF_LINE_CLASS`, `DIFF_SIGN` and `DiffBlock` declarations (the block from `export type DiffLine = ...` through the closing brace of `DiffBlock`).

- [ ] **Step 6: Fix the moved files' cross-boundary imports**

`apps/web/src/components/app/chat/turn/activity-block.tsx`: change

```tsx
import { formatStepDuration } from "./format";
```

to

```tsx
import { formatStepDuration } from "@/components/app/harness/format";
```

and

```tsx
import { useStreamTicker } from "./use-stream-ticker";
```

to

```tsx
import { useStreamTicker } from "@/components/app/harness/use-stream-ticker";
```

`apps/web/src/components/app/chat/turn/step-row.tsx`: the same two changes.

`apps/web/src/components/app/chat/turn/prompt-line.tsx`: change

```tsx
import { ExpandableBlock } from "./code-block";
```

to

```tsx
import { ExpandableBlock } from "@/components/app/harness/code-block";
```

`apps/web/src/components/app/chat/turn/step-detail.tsx`: change

```tsx
import { DiffBlock } from "@/components/app/chat/stream-entries";
```

to

```tsx
import { DiffBlock } from "./diff-block";
```

and change the `} from "./code-block";` import block's specifier to `} from "@/components/app/harness/code-block";`.

`apps/web/src/components/app/chat/turn/registry.ts`: change

```ts
import { diffLines } from "@/components/app/chat/stream-entries";
```

to

```ts
import { diffLines } from "./diff-block";
```

- [ ] **Step 7: Rewrite `chat/turn/turn-context.tsx` and export `showsActivity`**

Replace the whole content of `apps/web/src/components/app/chat/turn/turn-context.tsx` with:

```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { Agent } from "@/components/app/types";

/**
 * What a turn entry needs about its agent that `FeedContext` does not carry.
 * `FeedContext` is what every memoized feed row is keyed on, so it holds
 * only what changes rarely; the live agent record (its pins, its status)
 * changes on its own schedule, so it travels here and re-renders only the
 * turn entries, the way `PinShortcutContext` already does for pin rows.
 */
export type TurnContextValue = {
  /** The live agent record; its shortcut pins render under a turn's result. */
  agent: Agent | null;
};

/** The default: a turn renders without shortcut pins and asks for nothing. */
export const INERT_TURN_CONTEXT: TurnContextValue = { agent: null };

export const TurnContext = createContext<TurnContextValue>(INERT_TURN_CONTEXT);

export function TurnContextProvider({
  value,
  children,
}: {
  value: TurnContextValue;
  children: ReactNode;
}): JSX.Element {
  return <TurnContext.Provider value={value}>{children}</TurnContext.Provider>;
}

export function useTurnContext(): TurnContextValue {
  return useContext(TurnContext);
}
```

In `apps/web/src/components/app/chat/turn/activity-block.tsx`, add this exported predicate right after the `BLOCK_FILL` constant:

```tsx
/**
 * Whether a trace is worth a rail at all: a finished turn that ran no steps
 * has nothing to show, so the block stays unmounted rather than rendering
 * an empty fold.
 */
export function showsActivity(trace: Trace | null | undefined): trace is Trace {
  if (!trace) return false;
  return !(trace.endedAt != null && trace.steps.length === 0);
}
```

In `apps/web/src/components/app/chat/turn/result-turn.tsx`, add the `showTime` prop. Replace the component's signature and its trailing timestamp block:

```tsx
function ResultTurnImpl({
  turn,
  isStreaming = false,
  showTime = true,
}: {
  turn: Turn;
  isStreaming?: boolean;
  /**
   * The settle time under the result. Off inside a chat feed entry, whose
   * post header already carries the time.
   */
  showTime?: boolean;
}): JSX.Element | null {
```

and

```tsx
{
  showTime ? (
    <div className="pl-[21px] text-[10.5px] text-muted-foreground">
      {new Date(turn.timestamp).toLocaleTimeString()}
    </div>
  ) : null;
}
```

- [ ] **Step 8: Fix the importers that stayed behind**

`apps/web/src/components/app/harness/turn-stream.tsx`: replace its six relative imports of moved modules:

```tsx
import {
  ActivityBlock,
  showsActivity,
} from "@/components/app/chat/turn/activity-block";
import type {
  Attachment,
  Trace,
  Turn,
} from "@/components/app/chat/turn/contracts";
import {
  arrive,
  exitShrink,
  rowVariants,
} from "@/components/app/chat/turn/motion";
import { PromptLine } from "@/components/app/chat/turn/prompt-line";
import { QueuedPrompt } from "@/components/app/chat/turn/queued-prompt";
import { ResultText, ResultTurn } from "@/components/app/chat/turn/result-turn";

import { QuestionCard } from "./question-card";
```

and delete its now-duplicated local `showsActivity` function (the block from `function showsActivity(` through its closing brace).

`apps/web/src/components/app/harness/harness-pane.tsx`: replace

```tsx
import type { Attachment, Turn } from "./contracts";
import { HarnessContext } from "./harness-context";
import { arrive, DURATION, exitShrink, fadeVariants } from "./motion";
```

with

```tsx
import type { Attachment, Turn } from "@/components/app/chat/turn/contracts";
import {
  arrive,
  DURATION,
  exitShrink,
  fadeVariants,
} from "@/components/app/chat/turn/motion";
import { latestPlanItems } from "@/components/app/chat/turn/registry";
import { TasksStrip } from "@/components/app/chat/turn/tasks-strip";
import { TurnContextProvider } from "@/components/app/chat/turn/turn-context";
import { TurnShortcuts } from "@/components/app/chat/turn/turn-shortcuts";
```

and delete the three now-duplicated relative imports (`./harness-context` is already gone, replaced above):

```tsx
import { latestPlanItems } from "./registry";
import { TasksStrip } from "./tasks-strip";
import { TurnShortcuts } from "./turn-shortcuts";
```

Change the context value to the new shape. Replace `harness-pane.tsx:182-185`:

```tsx
const context = useMemo(
  () => ({ agentId, live: streaming }),
  [agentId, streaming]
);
```

with:

```tsx
const context = useMemo(() => ({ agent }), [agent]);
```

and both JSX tags: `<HarnessContext.Provider value={context}>` (`:409`) becomes `<TurnContextProvider value={context}>`, and `</HarnessContext.Provider>` (`:476`) becomes `</TurnContextProvider>`.

`apps/web/src/components/app/harness/use-harness-turns.ts`: replace

```ts
import type { Attachment, Step, Trace, Turn } from "./contracts";
import { turnLabelFromSteps } from "./registry";
```

with

```ts
import type {
  Attachment,
  Step,
  Trace,
  Turn,
} from "@/components/app/chat/turn/contracts";
import { turnLabelFromSteps } from "@/components/app/chat/turn/registry";
```

`apps/web/src/components/app/harness/harness-pane.test.tsx`: replace

```ts
import type { Trace, Turn } from "./contracts";
```

with

```ts
import type { Trace, Turn } from "@/components/app/chat/turn/contracts";
```

- [ ] **Step 9: Run the checks and the tests**

Run: `pnpm run check:web`
Expected: no output, exit 0.

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness src/components/app/chat`
Expected: PASS. The same test count as Step 1: `chat/stream-entries.test.tsx`'s three cases now report from `chat/turn/diff-block.test.tsx`, and the seven moved files report from their new paths.

- [ ] **Step 10: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/components/app/chat apps/web/src/components/app/harness
git commit -m "$(cat <<'EOF'
refactor(web): move the turn components under chat/turn/

The rail, the prompt line, the result and the tasks strip are about to
become feed entry views beside the review and pin views, so they live
beside the feed rather than under a pane that is going away. The diff
helpers move with them out of chat/stream-entries.tsx, which the feed no
longer needs once turns carry the tool calls. HarnessPane and TurnStream
render exactly as before, from the new paths.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `TurnEntryView`

One feed entry that renders a whole turn: the prompt as one of Brad's posts, the activity rail and the result as an agent post under it. Post styling is the outer frame, so the prompt goes through `ChatMessageView` (or `AgentMessageView` for a prompt another agent sent, or the notice line for one Dispatch injected), and the entry has no scroll follow of its own: the feed's is the only one.

**Files:**

- Create: `apps/web/src/components/app/chat/turn/turn-entry-view.tsx`
- Create: `apps/web/src/components/app/chat/turn/turn-entry-view.test.tsx`
- Modify: `apps/web/src/components/app/chat/chat-pane.tsx:22-23` (import), the feed's JSX (provide the context)

**Interfaces:**

- Consumes: `useTurnContext` (in the view) and `TurnContextProvider` (in `ChatPane`) from Task 7's `chat/turn/turn-context.tsx`; `showsActivity` and `ActivityBlock` from `chat/turn/activity-block.tsx`; `ResultTurn`'s `showTime` prop; `ChatMessageView`, `AgentMessageView`, `Post`, `agentAuthor`, `POST_BODY_MEASURE`, `SIDE_POST_INDENT`, `FeedContext` from `chat/chat-entries.tsx`; `PromptLine`, `parseDispatchNotice` from `chat/turn/prompt-line.tsx`; `TurnShortcuts` from `chat/turn/turn-shortcuts.tsx`.
- Produces, from `apps/web/src/components/app/chat/turn/turn-entry-view.tsx`:
  - `type TurnEntryViewProps = { entry: ChatTurnEntry; grouped: boolean; rule?: boolean; ctx: FeedContext }`
  - `const TurnEntryView: React.MemoExoticComponent<(props: TurnEntryViewProps) => JSX.Element>`
  - `function turnStep(step: ChatTurnStep): Step`
  - `function turnTrace(entry: ChatTurnEntry): Trace`
  - `function promptChatMessage(entry: ChatTurnEntry): ChatMessage`
  - `function promptAgentEntry(entry: ChatTurnEntry, ctx: FeedContext): ChatAgentMessageEntry`
  - `function resultTurnModel(entry: ChatTurnEntry, trace: Trace): Turn`
  - `function promptTurnModel(entry: ChatTurnEntry): Turn`
  - Testids: `chat-turn` on the entry wrapper (with `data-turn-id` and `data-settled`), `chat-turn-result` on the agent post. The moved components keep theirs (`harness-prompt`, `harness-notice`, `harness-activity-fold`, `harness-result`, `harness-interrupted`).
- Produces, from `apps/web/src/components/app/chat/chat-pane.tsx`: the feed renders inside `TurnContextProvider value={{ agent }}`.

- [ ] **Step 1: Write the failing test**

Write the whole file `apps/web/src/components/app/chat/turn/turn-entry-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { ChatTurnEntry } from "@dispatch/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";

vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

afterEach(cleanup);

const AGENT_ID = "agt_1";

const ctx: FeedContext = {
  agentId: AGENT_ID,
  agentName: "builder",
  agentType: "dispatch",
  onOpenMedia: () => undefined,
};

function turn(overrides: Partial<ChatTurnEntry> = {}): ChatTurnEntry {
  return {
    type: "turn",
    id: "turn:12",
    agentId: AGENT_ID,
    at: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:09.000Z",
    prompt: {
      source: "chat",
      text: "read the readme",
      chatMessageId: "11111111-1111-4111-8111-111111111111",
      attachments: [],
    },
    trace: {
      startedAt: "2026-09-08T10:00:00.000Z",
      endedAt: "2026-09-08T10:00:09.000Z",
      finalResult: "ok",
      steps: [
        {
          id: "stream:13",
          kind: "read",
          label: "Read README.md",
          status: "ok",
          startedAt: "2026-09-08T10:00:01.000Z",
          endedAt: "2026-09-08T10:00:02.000Z",
          durMs: 1000,
          detail: { toolKind: "read", locations: [{ path: "/w/README.md" }] },
        },
      ],
    },
    result: { text: "It documents the CLI.", streaming: false },
    settled: true,
    interrupted: false,
    ...overrides,
  };
}

function renderTurn(entry: ChatTurnEntry) {
  return render(
    <MemoryRouter>
      <MotionConfig reducedMotion="always">
        <TurnEntryView entry={entry} grouped={false} ctx={ctx} />
      </MotionConfig>
    </MemoryRouter>
  );
}

describe("TurnEntryView", () => {
  it("renders the prompt as a user post and the result as an agent post", () => {
    renderTurn(turn());
    const prompt = screen.getByTestId("chat-message");
    expect(prompt.getAttribute("data-author")).toBe("user");
    expect(prompt.textContent).toContain("read the readme");
    const result = screen.getByTestId("chat-turn-result");
    expect(result.getAttribute("data-author-kind")).toBe("agent");
    expect(result.textContent).toContain("builder");
    expect(result.textContent).toContain("It documents the CLI.");
    // The rail sits between the two halves, inside the agent post.
    expect(
      screen
        .getByTestId("chat-turn-result")
        .querySelector('[data-testid="harness-activity-fold"]')
    ).not.toBeNull();
  });

  it("names the entry and its settled state on the wrapper", () => {
    renderTurn(turn());
    const wrapper = screen.getByTestId("chat-turn");
    expect(wrapper.getAttribute("data-turn-id")).toBe("turn:12");
    expect(wrapper.getAttribute("data-settled")).toBe("true");
  });

  it("shows a running turn's growing text with no settle time under it", () => {
    renderTurn(
      turn({
        settled: false,
        result: { text: "reading now", streaming: true },
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          steps: [
            {
              id: "stream:14",
              kind: "execute",
              label: "bash",
              status: "running",
              startedAt: "2026-09-08T10:00:01.000Z",
              detail: { toolKind: "execute" },
            },
          ],
        },
      })
    );
    expect(
      screen.getByTestId("chat-turn").getAttribute("data-settled")
    ).toBeNull();
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "reading now"
    );
    expect(screen.getByTestId("harness-activity-fold")).toBeTruthy();
  });

  it("renders a prompt from another agent as a side post", () => {
    renderTurn(
      turn({
        prompt: {
          source: "agent",
          text: "take a look at the diff",
          senderName: "Reviewer",
          attachments: [],
        },
      })
    );
    const post = screen.getByTestId("chat-agent-message");
    expect(post.getAttribute("data-direction")).toBe("in");
    expect(post.getAttribute("data-side")).toBe("true");
    expect(post.textContent).toContain("Reviewer");
    expect(post.textContent).toContain("take a look at the diff");
    expect(screen.queryByTestId("chat-message")).toBeNull();
  });

  it("renders a prompt Dispatch injected as a notice, not as a user post", () => {
    renderTurn(
      turn({
        prompt: {
          source: "system",
          text: "Rename yourself to match the work you are doing.",
          attachments: [],
        },
      })
    );
    expect(screen.getByTestId("harness-notice")).toBeTruthy();
    expect(screen.queryByTestId("chat-message")).toBeNull();
  });

  it("says an interrupted turn was cut short", () => {
    renderTurn(
      turn({
        interrupted: true,
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          endedAt: "2026-09-08T10:00:04.000Z",
          finalResult: "interrupted",
          steps: [],
        },
        result: { text: "half", streaming: false },
      })
    );
    expect(screen.getByTestId("harness-interrupted").textContent).toContain(
      "Interrupted mid-turn"
    );
    // No steps and a finished trace: no empty rail.
    expect(screen.queryByTestId("harness-activity-fold")).toBeNull();
  });

  it("shows the turn's error under the result", () => {
    renderTurn(
      turn({
        error: "no API key",
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          endedAt: "2026-09-08T10:00:01.000Z",
          finalResult: "error",
          steps: [],
        },
        result: null,
      })
    );
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "no API key"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/turn/turn-entry-view.test.tsx`
Expected: FAIL at collection with `Failed to resolve import "@/components/app/chat/turn/turn-entry-view"`.

- [ ] **Step 3: Write `chat/turn/turn-entry-view.tsx`**

Write the whole file:

```tsx
import { memo, useMemo } from "react";
import type {
  ChatAgentMessageEntry,
  ChatMessage,
  ChatTurnEntry,
  ChatTurnStep,
} from "@dispatch/shared";

import {
  AgentMessageView,
  agentAuthor,
  ChatMessageView,
  type FeedContext,
  Post,
  POST_BODY_MEASURE,
  SIDE_POST_INDENT,
} from "@/components/app/chat/chat-entries";
import { cn } from "@/lib/utils";

import { ActivityBlock, showsActivity } from "./activity-block";
import type { Step, Trace, Turn } from "./contracts";
import { parseDispatchNotice, PromptLine } from "./prompt-line";
import { ResultTurn } from "./result-turn";
import { useTurnContext } from "./turn-context";
import { TurnShortcuts } from "./turn-shortcuts";

/** A turn prompt is never a question, so its post never offers an answer. */
const NO_ANSWER = (): void => undefined;

/** One trace step as the rail's model carries it: ISO times become epoch ms. */
export function turnStep(step: ChatTurnStep): Step {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
    ...(step.children?.length ? { children: step.children.map(turnStep) } : {}),
  };
}

export function turnTrace(entry: ChatTurnEntry): Trace {
  return {
    startedAt: Date.parse(entry.trace.startedAt),
    ...(entry.trace.endedAt
      ? { endedAt: Date.parse(entry.trace.endedAt) }
      : {}),
    ...(entry.trace.finalResult
      ? { finalResult: entry.trace.finalResult }
      : {}),
    steps: entry.trace.steps.map(turnStep),
  };
}

/**
 * The prompt as one of Brad's user posts. The attachments pass through
 * untouched, so the feed's own image and file rendering (and its lightbox)
 * handles them rather than a second renderer. `updatedAt` deliberately
 * mirrors `at`: the post does not change while the turn below it grows.
 */
export function promptChatMessage(entry: ChatTurnEntry): ChatMessage {
  return {
    id: entry.prompt.chatMessageId ?? `${entry.id}:prompt`,
    agentId: entry.agentId,
    authorKind: "user",
    kind: "reply",
    text: entry.prompt.text,
    replyTo: null,
    question: null,
    answer: null,
    attachments: entry.prompt.attachments,
    // The prompt reached the engine: it opened this turn.
    delivered: true,
    readAt: null,
    ...(entry.prompt.source === "launch" ? { origin: "launch" as const } : {}),
    createdAt: entry.at,
    updatedAt: entry.at,
  };
}

/**
 * A prompt another agent sent, as one of Brad's side posts. The turn carries
 * the sender's name and not its id, because a turn prompt is not an
 * `agent_messages` row: there is no peer to look up, so the post reads as a
 * generic agent.
 */
export function promptAgentEntry(
  entry: ChatTurnEntry,
  ctx: FeedContext
): ChatAgentMessageEntry {
  return {
    type: "agent_message",
    id: `${entry.id}:prompt`,
    direction: "in",
    senderAgentId: "",
    senderName: entry.prompt.senderName ?? "agent",
    recipientAgentId: entry.agentId,
    recipientName: ctx.agentName ?? "this agent",
    content: entry.prompt.text,
    delivered: true,
    at: entry.at,
  };
}

/** The turn's answer as the result renderer's model. */
export function resultTurnModel(entry: ChatTurnEntry, trace: Trace): Turn {
  return {
    id: `${entry.id}:result`,
    role: "assistant",
    content: entry.result?.text ?? "",
    timestamp: Date.parse(entry.trace.endedAt ?? entry.at),
    trace,
    ...(entry.error
      ? { error: { code: "turn_failed", message: entry.error } }
      : {}),
  };
}

/** A Dispatch-injected prompt as the notice line's model. */
export function promptTurnModel(entry: ChatTurnEntry): Turn {
  return {
    id: `${entry.id}:prompt`,
    role: "user",
    content: entry.prompt.text,
    timestamp: Date.parse(entry.at),
    extra: { source: entry.prompt.source },
  };
}

export type TurnEntryViewProps = {
  entry: ChatTurnEntry;
  /**
   * Always false: a turn carries a user post and an agent post inside one
   * entry, so nothing outside it groups with either half. The prop is here
   * to match every other entry view's shape.
   */
  grouped: boolean;
  /** A hairline above the prompt post: this entry follows another directly. */
  rule?: boolean;
  ctx: FeedContext;
};

/**
 * One harness turn as a feed entry: the prompt that opened it, the activity
 * rail, and the answer it ended with. The rail sits inside the agent post so
 * the work and the answer read under one header. No scroll follow of its
 * own: the feed owns that, keyed on `entryGrowthKey`.
 */
function TurnEntryViewImpl({
  entry,
  rule = false,
  ctx,
}: TurnEntryViewProps): JSX.Element {
  const { agent } = useTurnContext();
  const trace = useMemo(() => turnTrace(entry), [entry]);
  const result = useMemo(() => resultTurnModel(entry, trace), [entry, trace]);
  const notice = useMemo(
    () => parseDispatchNotice(entry.prompt.text, entry.prompt.source),
    [entry.prompt.source, entry.prompt.text]
  );
  const promptTurn = useMemo(() => promptTurnModel(entry), [entry]);
  const promptMessage = useMemo(() => promptChatMessage(entry), [entry]);
  const promptEntry = useMemo(() => promptAgentEntry(entry, ctx), [ctx, entry]);
  return (
    <div
      data-testid="chat-turn"
      data-turn-id={entry.id}
      data-settled={entry.settled ? "true" : undefined}
    >
      {notice ? (
        <div
          className={cn("pt-2 pr-4", SIDE_POST_INDENT, POST_BODY_MEASURE)}
          data-testid="chat-turn-notice"
        >
          <PromptLine turn={promptTurn} />
        </div>
      ) : entry.prompt.source === "agent" ? (
        <AgentMessageView
          entry={promptEntry}
          grouped={false}
          rule={rule}
          ctx={ctx}
        />
      ) : (
        <ChatMessageView
          message={promptMessage}
          held={false}
          grouped={false}
          rule={rule}
          ctx={ctx}
          answering={false}
          answersDisabled
          answeredOptionLabel={null}
          onAnswer={NO_ANSWER}
        />
      )}
      <Post
        author={agentAuthor(ctx, "Agent")}
        at={entry.updatedAt}
        grouped={false}
        data-testid="chat-turn-result"
      >
        <div className={cn(POST_BODY_MEASURE, "min-w-0 font-terminal")}>
          {showsActivity(trace) ? (
            <div className="mb-2">
              <ActivityBlock trace={trace} label={entry.label} />
            </div>
          ) : null}
          <ResultTurn turn={result} showTime={false} />
          <TurnShortcuts
            agent={agent}
            agentId={ctx.agentId}
            steps={trace.steps}
          />
        </div>
      </Post>
    </div>
  );
}

export const TurnEntryView = memo(TurnEntryViewImpl);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/turn/turn-entry-view.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Provide the turn context from `ChatPane`**

In `apps/web/src/components/app/chat/chat-pane.tsx`, add the import after the `pin-shortcut-context` import:

```tsx
import { TurnContextProvider } from "@/components/app/chat/turn/turn-context";
```

Add the memoized value immediately after the `useChatFeedContext` call (`chat-pane.tsx:522-527`):

```tsx
const { ctx, pinShortcuts, shortcutDialog } = useChatFeedContext({
  agentId,
  agent,
  openLightbox,
  onOpenReview,
});
// The live agent record a turn entry's shortcut pins need. Separate from
// `ctx` on purpose: `ctx` is what every memoized feed row is keyed on and
// must not change every time the agent record does.
const turnContext = useMemo(() => ({ agent }), [agent]);
```

Wrap the feed:

```tsx
{
  visibleEntries.length > 0 ? (
    <PinShortcutProvider value={pinShortcuts}>
      <TurnContextProvider value={turnContext}>
        <ChatFeed
          entries={visibleEntries}
          ctx={ctx}
          heldMessageId={heldMessageId}
          answeringMessageId={answeringMessageId}
          answersDisabled={disabledReason !== null}
          onAnswer={onAnswer}
        />
      </TurnContextProvider>
    </PinShortcutProvider>
  ) : null;
}
```

- [ ] **Step 6: Run the checks and the pane tests**

Run: `pnpm run check:web`
Expected: no output, exit 0.

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat`
Expected: PASS, including `chat-pane.test.tsx` unchanged.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/components/app/chat
git commit -m "$(cat <<'EOF'
feat(web): render a harness turn as one feed entry

A dispatch agent's turn had no place in Brad's feed, so it needed a
second surface to be seen at all. TurnEntryView composes the moved
pieces into one entry: the prompt through ChatMessageView (or
AgentMessageView for a prompt another agent sent, or the notice line for
one Dispatch injected), then the activity rail and the result inside one
agent post. The entry has no scroll follow of its own; the feed owns
that. ChatPane provides the live agent record the shortcut pins need.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `chat-feed.tsx` dispatches turn entries

**Files:**

- Modify: `apps/web/src/components/app/chat/chat-feed.tsx:73-83` (growth), `:263-312` (layout), `:329-341` (questions), `:453-524` (the view switch). `authorKey` is not touched here: Task 2 Step 7 already gave it its `turn` arm.
- Test: `apps/web/src/components/app/chat/chat-feed.test.tsx` (new `describe`)

**Interfaces:**

- Consumes: `TurnEntryView` from Task 8; `authorKey`'s `turn` arm from Task 2 Step 7.
- Produces:
  - `entryGrowthKey(entry)` returns `` `${id}:${at}:${updatedAt}:${steps}:${resultLength}:${settled}` `` for a `turn`, so `chat-pane.tsx`'s follow logic tracks a streaming turn.
  - `layoutFeed` emits a `turn` row with `grouped: false` and `rule: false`, and resets both grouping runs behind it.
  - `latestOpenFreeformQuestion(entries)` also reads a turn's `questions`: a reference marked `answered` closes that question even when its cached chat row still says otherwise.
  - `ChatFeed` renders `case "turn"` as `TurnEntryView`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/app/chat/chat-feed.test.tsx`:

```tsx
describe("turn entries", () => {
  function turnEntry(overrides: Partial<ChatTurnEntry> = {}): ChatTurnEntry {
    return {
      type: "turn",
      id: "turn:12",
      agentId: AGENT_ID,
      at: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:09.000Z",
      prompt: { source: "chat", text: "read the readme", attachments: [] },
      trace: {
        startedAt: "2026-09-04T10:00:00.000Z",
        endedAt: "2026-09-04T10:00:09.000Z",
        finalResult: "ok",
        steps: [
          {
            id: "stream:13",
            kind: "read",
            label: "Read README.md",
            status: "ok",
            startedAt: "2026-09-04T10:00:01.000Z",
            endedAt: "2026-09-04T10:00:02.000Z",
            durMs: 1000,
            detail: { toolKind: "read" },
          },
        ],
      },
      result: { text: "It documents the CLI.", streaming: false },
      settled: true,
      interrupted: false,
      ...overrides,
    };
  }

  it("renders the prompt with post styling and the result as an agent post", () => {
    renderFeed([turnEntry()]);
    const prompt = screen.getByTestId("chat-message");
    expect(prompt.getAttribute("data-author")).toBe("user");
    expect(prompt.textContent).toContain("read the readme");
    const result = screen.getByTestId("chat-turn-result");
    expect(result.getAttribute("data-author-kind")).toBe("agent");
    expect(result.textContent).toContain("It documents the CLI.");
    expect(screen.getByTestId("chat-turn").getAttribute("data-turn-id")).toBe(
      "turn:12"
    );
  });

  it("keeps a turn out of every author group and resets the run behind it", () => {
    const rows = layoutFeed(
      [
        chat(
          message({
            id: "m1",
            authorKind: "agent",
            text: "before",
            createdAt: "2026-09-04T09:59:00.000Z",
            updatedAt: "2026-09-04T09:59:00.000Z",
          })
        ),
        turnEntry(),
        chat(
          message({
            id: "m2",
            authorKind: "agent",
            text: "after",
            createdAt: "2026-09-04T10:00:10.000Z",
            updatedAt: "2026-09-04T10:00:10.000Z",
          })
        ),
      ],
      makeCtx(),
      new Date("2026-09-04T12:00:00.000Z")
    );
    const entries = rows.filter((r) => r.kind === "entry");
    expect(entries.map((r) => [r.entry.id, r.grouped, r.rule])).toEqual([
      ["m1", false, false],
      ["turn:12", false, false],
      // Two agent posts five minutes apart would group; the turn between
      // them ends the run, so the second opens a fresh header.
      ["m2", false, true],
    ]);
  });

  it("keys a turn's growth on its newest row, steps, result and settled state", () => {
    const base = turnEntry({
      settled: false,
      result: { text: "a", streaming: true },
    });
    const grown = turnEntry({
      settled: false,
      updatedAt: "2026-09-04T10:00:11.000Z",
      result: { text: "ab", streaming: true },
    });
    expect(entryGrowthKey(base)).not.toBe(entryGrowthKey(grown));
    expect(entryGrowthKey(grown)).not.toBe(
      entryGrowthKey({ ...grown, settled: true })
    );
    // The fade-in version is the anchor time, which never moves, so growth
    // does not remount the entry and collapse an expanded step.
    expect(entryVersion(base)).toBe(entryVersion(grown));
  });

  it("does not re-enter a streaming turn as it grows", () => {
    const { result, rerender } = renderHook(
      ({ entries }: { entries: ChatFeedEntry[] }) =>
        useEnteringEntries(entries),
      {
        initialProps: {
          entries: [
            turnEntry({
              settled: false,
              result: { text: "a", streaming: true },
            }),
          ] as ChatFeedEntry[],
        },
      }
    );
    const later = status("s9", "done", "finished", "2026-09-04T10:00:20.000Z");
    rerender({
      entries: [
        turnEntry({ settled: false, result: { text: "a", streaming: true } }),
        later,
      ],
    });
    expect(result.current.has("s9")).toBe(true);
    rerender({
      entries: [
        turnEntry({
          settled: false,
          updatedAt: "2026-09-04T10:00:15.000Z",
          result: { text: "abc", streaming: true },
        }),
        later,
      ],
    });
    expect(result.current.has("turn:12")).toBe(false);
  });

  it("takes a turn's word for a question its own chat row has not caught up on", () => {
    const question = message({
      id: "q1",
      authorKind: "agent",
      kind: "question",
      text: "Scope choice?",
      question: { options: [{ label: "Narrow" }], allowFreeform: true },
      createdAt: "2026-09-04T10:00:05.000Z",
      updatedAt: "2026-09-04T10:00:05.000Z",
    });
    // The card still says unanswered, and no turn contradicts it.
    expect(
      latestOpenFreeformQuestion([
        turnEntry({ questions: [{ messageId: "q1", answered: false }] }),
        chat(question),
      ])?.id
    ).toBe("q1");
    // The turn is republished on every flush, so its answered state is the
    // fresher one: the composer stops offering to answer a closed question.
    expect(
      latestOpenFreeformQuestion([
        turnEntry({ questions: [{ messageId: "q1", answered: true }] }),
        chat(question),
      ])
    ).toBeNull();
    // A turn that names no question changes nothing.
    expect(latestOpenFreeformQuestion([turnEntry(), chat(question)])?.id).toBe(
      "q1"
    );
  });
});
```

Add `ChatTurnEntry` to the file's `@dispatch/shared` type import list, in alphabetical position after `ChatStatusEntry,`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-feed.test.tsx`
Expected: FAIL, five failures in `turn entries`; the first reports that no element with testid `chat-message` was found (the switch has no `turn` case, so nothing renders).

- [ ] **Step 3: Add the growth key and the layout rule**

`authorKey`'s `turn` arm is already in place: Task 2 Step 7 added it, because the union change would not type-check without it. Do not add it again.

In `apps/web/src/components/app/chat/chat-feed.tsx`, add to `entryGrowthKey`'s switch, before `default:`:

```ts
    case "turn":
      // Everything that makes a turn taller: the newest row folded in, the
      // rail's length, the answer as it streams, and the settle that folds
      // the rail. `entryVersion` stays the anchor time, so growth does not
      // re-fade the entry.
      return `${base}:${entry.updatedAt}:${entry.trace.steps.length}:${entry.result?.text.length ?? 0}:${entry.settled ? 1 : 0}`;
```

In `layoutFeed`, insert this block immediately after the `if (item.kind === "status") { ... continue; }` block and before `const key = authorKey(item.entry, ctx);`:

```ts
// A turn carries a user post and an agent post inside one entry, so
// nothing outside it can group with either half: it always starts a
// fresh group, draws no hairline of its own, and ends the run behind
// it so the post after it opens with a header.
if (item.entry.type === "turn") {
  rows.push({
    kind: "entry",
    entry: item.entry,
    grouped: false,
    rule: false,
  });
  lastPost = null;
  lastAgentRow = null;
  continue;
}
```

- [ ] **Step 4: Let a turn's questions reach the composer**

Replace `latestOpenFreeformQuestion` in `apps/web/src/components/app/chat/chat-feed.tsx` with:

```ts
/**
 * The newest unanswered question that accepts a typed reply. While one is
 * open the composer answers it instead of sending a plain message.
 *
 * A turn names the questions asked during it and whether each is answered.
 * A question's card is a `chat` entry of its own, in time order, and always
 * lands after the turn's anchor, so the walk below finds the card either
 * way; what the turn adds is a fresher answer state. The turn entry is
 * republished whole on every flush, while a cached chat row is only as new
 * as its last event, so an answer the turn knows about closes the question
 * even when the row has not caught up.
 */
export function latestOpenFreeformQuestion(
  entries: ChatFeedEntry[]
): ChatMessage | null {
  const answeredByTurn = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "turn") continue;
    for (const ref of entry.questions ?? []) {
      if (ref.answered) answeredByTurn.add(ref.messageId);
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.type !== "chat") continue;
    const m = entry.message;
    if (m.authorKind !== "agent" || m.kind !== "question") continue;
    if (m.answer !== null || answeredByTurn.has(m.id)) continue;
    return m.question?.allowFreeform ? m : null;
  }
  return null;
}
```

Why not resolve a turn's reference straight to a message: the reference names a chat row, and a chat row that is not in `entries` is one the composer cannot answer against anyway. Resolving one that _is_ in `entries` would let an older question win over a newer one whenever a turn sat above it, which is a worse answer than today's. The answered set is the part of a turn's `questions` that carries information the chat rows do not.

- [ ] **Step 5: Render the entry**

Add the import after the `stream-entries` import block in `apps/web/src/components/app/chat/chat-feed.tsx`:

```tsx
import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";
```

Add the case to the view switch, right after `case "review":`'s block and before `case "assistant":`:

```tsx
            case "turn":
              return (
                <TurnEntryView
                  entry={entry}
                  grouped={row.grouped}
                  rule={row.rule}
                  ctx={ctx}
                />
              );
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat`
Expected: PASS, including the five new `turn entries` tests and every existing case.

Run: `pnpm run check:web`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/components/app/chat/chat-feed.tsx apps/web/src/components/app/chat/chat-feed.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): dispatch turn entries in the chat feed

The feed had no view for the server's new turn entry, so a dispatch
agent's work rendered as nothing. chat-feed.tsx now renders it through
TurnEntryView, treats it as its own author group so neither of its two
posts groups with a neighbor, keys its growth on the newest row folded
into it so the pane follows a streaming turn, and resolves the questions
a turn references against the chat rows that carry them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `useHarnessQueued` and the queue query key

**Files:**

- Modify: `apps/web/src/components/app/harness/use-harness-queue.ts`
- Modify: `apps/web/src/hooks/use-sse.ts:352-361`
- Test: `apps/web/src/components/app/harness/use-harness-queue.test.tsx` (new file)
- Test: `apps/web/src/hooks/use-sse.test.ts:1065-1079` (the one existing case that emits `harness.changed`)

**Interfaces:**

- Consumes: `GET /api/v1/agents/:id/harness/queue` and `HarnessQueueResponse` from Task 5.
- Produces, from `apps/web/src/components/app/harness/use-harness-queue.ts`:
  - `function harnessQueueQueryKey(agentId: string | null): readonly ["harness-queue", string | null]`
  - `function useHarnessQueued(agentId: string | null): { queued: HarnessQueuedPrompt[]; loading: boolean; error: Error | null }`
  - `useHarnessQueue`'s two mutations and `useHarnessInterrupt` invalidate `harnessQueueQueryKey(agentId)` instead of `harnessTurnsQueryKey(agentId)`.
- Produces, in `apps/web/src/hooks/use-sse.ts`: `harness.changed` also invalidates `harnessQueueQueryKey(agentId)`.

- [ ] **Step 1: Write the failing test**

Write the whole file `apps/web/src/components/app/harness/use-harness-queue.test.tsx`:

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  harnessQueueQueryKey,
  useHarnessInterrupt,
  useHarnessQueue,
  useHarnessQueued,
} from "./use-harness-queue";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function freshClient() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return vi.spyOn(client, "invalidateQueries");
}

afterEach(() => {
  api.mockReset();
  vi.restoreAllMocks();
});

describe("useHarnessQueued", () => {
  it("reads the queue route and hands back what waits", async () => {
    freshClient();
    api.mockResolvedValue({
      queued: [
        {
          id: "q1",
          source: "chat",
          text: "next please",
          attachments: [],
          createdAt: "2026-09-08T10:00:00.000Z",
        },
      ],
    });
    const { result } = renderHook(() => useHarnessQueued("agt_1"), { wrapper });
    await waitFor(() => expect(result.current.queued).toHaveLength(1));
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/queue");
    expect(result.current.queued[0].text).toBe("next please");
  });

  it("asks nothing without an agent", () => {
    freshClient();
    const { result } = renderHook(() => useHarnessQueued(null), { wrapper });
    expect(result.current.queued).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("queue actions", () => {
  it("invalidates the queue key after send now", async () => {
    const invalidate = freshClient();
    api.mockResolvedValue(undefined);
    const { result } = renderHook(() => useHarnessQueue("agt_1"), { wrapper });
    await act(async () => {
      await result.current.sendNow("q1");
    });
    expect(api).toHaveBeenCalledWith(
      "/api/v1/agents/agt_1/harness/queue/q1/send-now",
      { method: "POST" }
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: harnessQueueQueryKey("agt_1"),
      exact: true,
    });
  });

  it("invalidates the queue key after a removal", async () => {
    const invalidate = freshClient();
    api.mockResolvedValue(undefined);
    const { result } = renderHook(() => useHarnessQueue("agt_1"), { wrapper });
    await act(async () => {
      await result.current.remove("q1");
    });
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/queue/q1", {
      method: "DELETE",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: harnessQueueQueryKey("agt_1"),
      exact: true,
    });
  });

  it("invalidates the queue key after Stop", async () => {
    const invalidate = freshClient();
    api.mockResolvedValue(undefined);
    const { result } = renderHook(() => useHarnessInterrupt("agt_1"), {
      wrapper,
    });
    await act(async () => {
      await result.current.interrupt();
    });
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/interrupt", {
      method: "POST",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: harnessQueueQueryKey("agt_1"),
      exact: true,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/use-harness-queue.test.tsx`
Expected: FAIL at collection with `does not provide an export named 'harnessQueueQueryKey'`.

- [ ] **Step 3: Add the query and swap the invalidations**

Replace the top of `apps/web/src/components/app/harness/use-harness-queue.ts` (through the end of `useHarnessQueue`'s `refetch`) with:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HarnessQueuedPrompt, HarnessQueueResponse } from "@dispatch/shared";

import { api } from "@/lib/api";

export function harnessQueueQueryKey(agentId: string | null) {
  return ["harness-queue", agentId] as const;
}

/**
 * Prompts waiting behind the running turn, first to run first. Live
 * in-memory supervisor state, not a feed row: it has its own route and its
 * own cache, and every write to it invalidates this key.
 */
export function useHarnessQueued(agentId: string | null): {
  queued: HarnessQueuedPrompt[];
  loading: boolean;
  error: Error | null;
} {
  const query = useQuery({
    queryKey: harnessQueueQueryKey(agentId),
    queryFn: () =>
      api<HarnessQueueResponse>(`/api/v1/agents/${agentId}/harness/queue`),
    enabled: agentId !== null,
    staleTime: 5_000,
  });
  return {
    queued: query.data?.queued ?? [],
    loading: query.isLoading,
    error: query.error,
  };
}

/**
 * Actions on prompts that wait behind the running turn: send one now (it
 * jumps the queue and the running turn is interrupted) or drop it. Both
 * refetch the queue.
 */
export function useHarnessQueue(agentId: string | null): {
  sendNow: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** The queued prompt whose action is in flight, if any. */
  busyId: string | null;
} {
  const queryClient = useQueryClient();
  const refetch = () =>
    queryClient.invalidateQueries({
      queryKey: harnessQueueQueryKey(agentId),
      exact: true,
    });
```

and delete the now-unused import:

```ts
import { harnessTurnsQueryKey } from "./use-harness-turns";
```

In `useHarnessInterrupt`, replace its `onSettled`:

```ts
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: harnessQueueQueryKey(agentId),
        exact: true,
      }),
```

- [ ] **Step 4: Invalidate the queue on `harness.changed`**

In `apps/web/src/hooks/use-sse.ts`, add the import after the `harnessConfigQueryKey` import:

```ts
import { harnessQueueQueryKey } from "@/components/app/harness/use-harness-queue";
```

Add the helper next to `invalidateHarnessConfig`:

```ts
/** The supervisor's queue: a prompt queued, promoted, dropped, or started. */
function invalidateHarnessQueue(
  queryClient: QueryClient,
  agentId: string
): void {
  void queryClient.invalidateQueries({
    queryKey: harnessQueueQueryKey(agentId),
    exact: true,
  });
}
```

and call it in the `harness.changed` branch:

```ts
if (payload.type === "harness.changed") {
  // A stream write: the feed reads the stream rows, the Harness its
  // turns. The session config is read again only when the write
  // says it changed (a start, a settle, a switch).
  invalidateChatFeed(queryClient, payload.agentId);
  invalidateHarnessTurns(queryClient, payload.agentId);
  invalidateHarnessQueue(queryClient, payload.agentId);
  if (payload.config) {
    invalidateHarnessConfig(queryClient, payload.agentId);
  }
  return;
}
```

- [ ] **Step 5: Update the SSE test that pins the invalidated set**

`apps/web/src/hooks/use-sse.test.ts` asserts through `expectInvalidatedSet` (`:476-483`), which checks `expect(keys).toHaveLength(expected.length)`, so each list is the exact set and not a subset. One case emits `harness.changed`, and it now sees one more key. Replace the whole test at `use-sse.test.ts:1065-1079` with:

```tsx
it("refetches the feed, the harness turns and the queue on harness.changed, and the config only when told", () => {
  const { emit, invalidateQueries } = renderMessages();
  emit({ type: "harness.changed", agentId: "agt_1" });
  expectInvalidatedSet(invalidateQueries, [
    ["chat", "agt_1"],
    ["harness-turns", "agt_1"],
    ["harness-queue", "agt_1"],
  ]);
  invalidateQueries.mockClear();
  emit({ type: "harness.changed", agentId: "agt_1", config: true });
  expectInvalidatedSet(invalidateQueries, [
    ["chat", "agt_1"],
    ["harness-turns", "agt_1"],
    ["harness-queue", "agt_1"],
    ["harness-config", "agt_1"],
  ]);
});
```

No other case in the file emits `harness.changed`, so nothing else in it moves.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness src/hooks`
Expected: PASS, including the five new `use-harness-queue` tests and `harness-pane.test.tsx` unchanged (it mocks the whole `use-harness-queue` module).

Run: `pnpm run check:web`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/components/app/harness/use-harness-queue.ts apps/web/src/components/app/harness/use-harness-queue.test.tsx apps/web/src/hooks/use-sse.ts apps/web/src/hooks/use-sse.test.ts
git commit -m "$(cat <<'EOF'
feat(web): read the harness queue from its own cache

The queue rode on the turns query, so it could not outlive the turns
endpoint the one-feed work deletes. useHarnessQueued reads the queue
route under its own key, and send now, remove and Stop invalidate that
key instead of the turns key. harness.changed refreshes it too, so a
prompt that starts or is dropped server-side still shows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Retire the flat `assistant` and `activity` entries

Nothing produces them (Task 4) and nothing needs to render them (Task 9), so the feed can stop carrying a stream row twice: once as a flat entry and again inside its turn.

**Files:**

- Modify: `packages/shared/src/chat-types.ts` (delete three types, trim the union), `packages/shared/src/index.ts`
- Modify: `apps/server/src/chat/feed-cursor.ts` (`SOURCE_RANK`, `isValidCursorId`)
- Delete: `apps/web/src/components/app/chat/stream-entries.tsx`
- Modify: `apps/web/src/components/app/chat/chat-feed.tsx` (drop the two cases, the two author keys, the two growth keys, the import)
- Test: `apps/web/src/components/app/chat/chat-feed.test.tsx` (delete `describe("stream entries")`)

**Interfaces:**

- Consumes: everything from Tasks 4 and 9.
- Produces: `ChatFeedEntry` is `ChatMessageEntry | ChatStatusEntry | ChatAgentMessageEntry | ChatMediaEntry | ChatReviewEntry | ChatTurnEntry | ChatPinEntry`. `ChatAssistantEntry`, `ChatActivityEntry` and `ChatActivityStatus` no longer exist. `SOURCE_RANK` has `turn: 6` and no `assistant` or `activity`.

- [ ] **Step 1: Delete the web test cases that only cover the retired entries**

In `apps/web/src/components/app/chat/chat-feed.test.tsx`, delete the whole `describe("stream entries", () => { ... });` block (all eight of its tests). Task 9's `describe("turn entries")` already covers the growth-key and re-entry behavior those cases carried, over a turn instead of an assistant row.

- [ ] **Step 2: Run the tests to confirm the rest still passes**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-feed.test.tsx`
Expected: PASS, with eight fewer tests than before this step.

- [ ] **Step 3: Trim the shared types**

In `packages/shared/src/chat-types.ts`, delete the three declarations: `ChatAssistantEntry` (with its doc comment), `ChatActivityStatus`, and `ChatActivityEntry` (with its doc comment). Then set the union to:

```ts
export type ChatFeedEntry =
  | ChatMessageEntry
  | ChatStatusEntry
  | ChatAgentMessageEntry
  | ChatMediaEntry
  | ChatReviewEntry
  | ChatTurnEntry
  | ChatPinEntry;
```

In `packages/shared/src/index.ts`, delete `ChatActivityEntry,`, `ChatActivityStatus,` and `ChatAssistantEntry,` from the `from "./chat-types.js"` type export list.

- [ ] **Step 4: Trim the cursor primitives**

In `apps/server/src/chat/feed-cursor.ts`, set `SOURCE_RANK` to:

```ts
export const SOURCE_RANK: Record<ChatFeedEntry["type"], number> = {
  // Turns come from agent_stream_events; the rank keeps the cursor's id
  // tie-break exact against every other source.
  turn: 6,
  review: 5,
  chat: 4,
  status: 3,
  pin: 2,
  agent_message: 1,
  media: 0,
};
```

and delete `case "assistant":` and `case "activity":` from `isValidCursorId`.

A cursor a client still holds from before this change names `assistant` or `activity`, which `decodeFeedCursor` now rejects; the route answers `400 cursor is not valid.` and the client refetches from the head. That is the same handling every malformed cursor already gets.

- [ ] **Step 5: Delete `chat/stream-entries.tsx` and its last references**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git rm apps/web/src/components/app/chat/stream-entries.tsx
```

In `apps/web/src/components/app/chat/chat-feed.tsx`:

Delete the import block:

```tsx
import {
  ActivityEntryView,
  AssistantEntryView,
} from "@/components/app/chat/stream-entries";
```

In `entryGrowthKey`, delete the `case "assistant":` and `case "activity":` arms, leaving:

```ts
export function entryGrowthKey(entry: ChatFeedEntry): string {
  const base = `${entry.id}:${entryVersion(entry)}`;
  switch (entry.type) {
    case "turn":
      // Everything that makes a turn taller: the newest row folded in, the
      // rail's length, the answer as it streams, and the settle that folds
      // the rail. `entryVersion` stays the anchor time, so growth does not
      // re-fade the entry.
      return `${base}:${entry.updatedAt}:${entry.trace.steps.length}:${entry.result?.text.length ?? 0}:${entry.settled ? 1 : 0}`;
    default:
      return base;
  }
}
```

In `authorKey`, delete the `case "assistant":` / `case "activity":` pair, leaving:

```ts
function authorKey(
  entry: Exclude<ChatFeedEntry, ChatStatusEntry>,
  ctx: FeedContext
): string {
  switch (entry.type) {
    case "chat":
      return chatMessageAuthor(entry.message, ctx).key;
    case "agent_message":
      return agentMessageAuthor(entry, ctx).key;
    case "media":
    case "pin":
      return "agent";
    case "review":
      return reviewAuthor(entry, ctx).key;
    case "turn":
      // Never reached: `layoutFeed` gives a turn its own group before it
      // asks for an author key.
      return "turn";
  }
}
```

`layoutFeed`'s whole `lastAgentRow` rule existed only to keep a run of tool-call rows under one agent header, so it goes with them. `lastAgentRow` is referenced in six places (its declaration, the day-divider reset, the status reset, the `grouped` ternary, the two assignments after the push) plus the reset inside the `turn` block Task 9 inserted, and every one of them goes. Rather than seven separate cuts, replace the whole function body. Its final form is:

```ts
/**
 * Lay the collapsed feed out as channel rows: a rule wherever the day
 * changes, and a post grouped under the previous one when the same author
 * posted it within {@link GROUP_WINDOW_MS} with nothing else in between.
 */
export function layoutFeed(
  entries: ChatFeedEntry[],
  ctx: FeedContext,
  now: Date = new Date()
): ChatFeedRow[] {
  const rows: ChatFeedRow[] = [];
  let lastDay: string | null = null;
  let lastPost: { key: string; at: number } | null = null;
  for (const item of collapseFeed(entries)) {
    const day = dayKey(item.entry.at);
    if (day !== lastDay) {
      rows.push({
        kind: "divider",
        key: `day:${day}`,
        label: dayLabel(item.entry.at, now),
      });
      lastDay = day;
      lastPost = null;
    }
    if (item.kind === "status") {
      rows.push(item);
      lastPost = null;
      continue;
    }
    // A turn carries a user post and an agent post inside one entry, so
    // nothing outside it can group with either half: it always starts a
    // fresh group, draws no hairline of its own, and ends the run behind
    // it so the post after it opens with a header.
    if (item.entry.type === "turn") {
      rows.push({
        kind: "entry",
        entry: item.entry,
        grouped: false,
        rule: false,
      });
      lastPost = null;
      continue;
    }
    const key = authorKey(item.entry, ctx);
    const at = new Date(item.entry.at).getTime();
    const safeAt = Number.isFinite(at) ? at : 0;
    const within = (since: number) =>
      Number.isFinite(at) && at - since <= GROUP_WINDOW_MS;
    const grouped =
      lastPost !== null && lastPost.key === key && within(lastPost.at);
    const rule = !grouped && rows[rows.length - 1]?.kind === "entry";
    rows.push({ kind: "entry", entry: item.entry, grouped, rule });
    lastPost = { key, at: safeAt };
  }
  return rows;
}
```

Finally, delete the `case "assistant":` and `case "activity":` blocks from `ChatFeed`'s view switch.

- [ ] **Step 6: Run every gate**

Run: `pnpm --filter @dispatch/shared check && pnpm --filter @dispatch/server check && pnpm run check:web`
Expected: no output from any of the three, exit 0.

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run`
Expected: PASS, the whole server suite.

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: PASS, the whole web suite.

Run: `pnpm run finalize:web`
Expected: the type check passes and `vite build` writes `apps/web/dist` with no errors.

Run: `pnpm run test:e2e`
Expected: PASS. `e2e/harness-agent.spec.ts` is not in this run (it needs `pnpm run test:e2e:live`); every other spec is green.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add packages/shared/src apps/server/src/chat/feed-cursor.ts apps/web/src/components/app/chat
git commit -m "$(cat <<'EOF'
refactor(shared): drop the flat assistant and activity feed entries

With turns in the feed, a stream row would otherwise arrive twice: once
as a loose entry and again inside the turn that ran it. The two entry
kinds, the view module that rendered them and their grouping rules all
go, so agent_stream_events reaches the feed through exactly one
projection. A cursor a client still holds for one of them is rejected as
invalid, which refetches from the head.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Verification of the whole plan

After Task 11, run from the worktree root:

```bash
pnpm run check
pnpm run test
pnpm run test:e2e
```

Expected: green. If `pnpm run check`'s final step fails on missing root `@types/node`, that is the pre-existing gap named in Global Constraints; the three scoped checks are the gate.

Optionally, and only if the user asks for it, `pnpm run test:e2e:live` runs `e2e/harness-agent.spec.ts` against the fake ACP agent. That spec still targets `harness-pane`, which this plan leaves working; plan 3 retargets it to `chat-pane`.

---

## Self-review

**Spec coverage.**

| Spec requirement                                                                                                       | Task      |
| ---------------------------------------------------------------------------------------------------------------------- | --------- |
| Section 3, shape: `ChatTurnPrompt`, `ChatTurnQuestionRef`, `ChatTurnEntry` verbatim                                    | 2         |
| Section 3, shape: `ChatTurnStep` and `ChatTurnPlanEntry` moved, re-exported from `harness-types.ts`                    | 2         |
| Section 3, shape: `ChatFeedEntry` gains `turn`                                                                         | 2         |
| Section 3, composition: `assembleTurns` moves to `chat/turns.ts`, pre-turn id by row id                                | 2         |
| Section 3, composition: `listTurnEntries` with the three-step window                                                   | 3         |
| Section 3, composition: `SOURCE_RANK` gains `turn: 6`, `isValidCursorId` gains `turn`                                  | 2, 11     |
| Section 3, deduplication: the prompt chat row filtered by `NOT EXISTS`                                                 | 4         |
| Section 3, ordering: a turn takes its anchor's position and grows in place                                             | 3, 4      |
| Section 3, live updates: one `chat.entry` per flush from the publish hook                                              | 6         |
| Section 3, what the flat entries become: `listTurnEntries` replaces `listStreamEntries`, `assistant` and `activity` go | 4, 11     |
| Section 3, paging across a turn                                                                                        | 3, 4      |
| Section 4, `chat-feed.tsx`: one `case "turn"`, grouping, growth, questions, post styling                               | 8, 9      |
| Section 4, queue route and `useHarnessQueued`                                                                          | 5, 10     |
| Section 5, stage 1's turn-entry row                                                                                    | all       |
| Section 6, the file moves turn rendering needs                                                                         | 7         |
| Section 6, `DiffBlock` and `diffLines` to `chat/turn/diff-block.tsx`, `stream-entries.tsx` deleted                     | 7, 11     |
| Section 7, server feed cases (seven, in `chat-feed.test.ts`)                                                           | 3, 4      |
| Section 7, queue route test and `use-harness-queue.test.tsx`                                                           | 5, 10     |
| Section 7, moved unit tests                                                                                            | 7         |
| Section 8, every row except the flag row                                                                               | see below |

Section 8's rows: a turn cut by a service restart (Task 2, `toTurnEntry`'s restart branch and its test); a queued message at shutdown (no code: the chat rows behind it already list as `chat` entries, and Task 4's dedup only removes a row a turn row names as its prompt, so an undelivered queued row stays); an engine that publishes no plan (`plan` is optional on `ChatTurnEntry`, and `TasksStrip` returns null on an empty list, unchanged by Task 7); a prompt from another agent (Task 8, `promptAgentEntry` and its test); a turn with a question (Tasks 3, 4, 9 and their tests); a turn longer than the feed page (Task 4's "returns a turn whole even when its rows straddle the page limit"); two rows sharing a millisecond (unchanged: the server orders on microsecond text, `listTurnEntries` returns the anchor's real `at_key`, and the client's existing bail-to-refetch covers the rest); the flag turned off while dispatch agents run (plan 1); a dispatch agent that posts a reply through `dispatch_chat_post` anyway (no code: it is an agent chat row, no turn names it as a prompt, so Task 4's dedup leaves it as its own `chat` entry below the turn).

**Placeholder scan.** No "TBD", no "similar to Task N", no step that changes code without showing it. Every SQL statement, test body and component is written out, and every step's expected output is a concrete pass, failure message or exit code.

**Type consistency.** `listTurnEntries(db, agentId, cursor, limit)` returns `Keyed<ChatTurnEntry>[]` in Task 3 and is consumed with that shape in Task 4. `toTurnEntry(turn, group, agentId)` is defined in Task 2 and called in Task 3. `groupTurnRows` returns `TurnGroup[]` in Task 2 and is indexed against `assembleTurns`'s output in Task 3, which Task 2's second `groupTurnRows` test pins. `loadLatestTurnEntry(db, agentId)` is defined in Task 3 and called in Task 6. `HarnessQueueResponse` is added in Task 5 and consumed in Task 10. `harnessQueueQueryKey` is defined in Task 10 and used in the same task's `use-sse.ts` edit. `TurnEntryView`'s props are `{ entry, grouped, rule?, ctx }` in Task 8 and passed exactly that way in Task 9. `showsActivity` is exported in Task 7 and used in Task 8. `ResultTurn`'s `showTime` is added in Task 7 and passed in Task 8. `TurnContextValue` is `{ agent: Agent | null }` in Task 7, provided in Task 8's `ChatPane` edit, and read by `useTurnContext` in Task 8's view.

**Two things a reviewer should know, neither of which this plan can fix on its own.**

1. Between the `chat.entry` for a user's chat message and the first turn that names it as a prompt, the client holds that row as a `chat` entry while the server has stopped listing it. The turn's own `chat.entry` does not remove it, and `applyChatEntry` has no reason to. In this stage the coarse `harness.changed` invalidation that still fires on every flush refetches the page and the duplicate goes within 100 ms. Plan 4 removes that invalidation, so plan 4 has to handle the removal itself (drop the `chat` entry whose id matches an arriving turn's `prompt.chatMessageId`).
2. `ChatService.publishEntry` reads a message back through `loadChatMessageEntry`, which now returns null for a row a turn claimed as its prompt. That path already falls back to `publishChanged` (a coarse refetch), so it degrades rather than breaking, but it means a late edit to a prompt row costs one feed refetch.
