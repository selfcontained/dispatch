# One feed, plan 3 of 4: ChatPane is the dispatch agent's pane

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Dispatch Harness agent reads in Brad's Chat feed: `ChatPane` becomes its pane, the harness-only chrome (tasks strip, model chip, usage chip, Stop, the queue) moves into the composer region, and `HarnessPane` is deleted along with the pane swap that reached it.

**Architecture:** The chrome's live state comes from the chat feed query that `ChatPane` already holds. One new module, `chat/harness-chrome.tsx`, derives the running turn, the latest plan and the prompt history from the feed's `turn` entries, owns the harness queries that are not feed-shaped (model config, the queue, interrupt, commands, paths) and returns two things: the chrome to render above the composer, and the extra props `ChatComposer` needs. It is inert for every agent type but `dispatch`, because `ChatPane` hands it a null agent id and every harness query is keyed off that. `agent-pane.tsx` then mounts `ChatPane` unconditionally and `harness-pane.tsx`, `turn-stream.tsx` and `question-card.tsx` go.

This is stage 2 of the spec `docs/superpowers/specs/2026-09-08-harness-turns-in-chat-feed-design.md`. Plan 1 (`2026-09-08-one-feed-1-harness-flag.md`, the Dispatch Harness flag) and plan 2 (`2026-09-08-one-feed-2-turn-entries.md`, `turn` feed entries and `TurnEntryView`) must both be complete first: this plan reads `ChatTurnEntry` off the feed, mounts components from `chat/turn/`, calls `useHarnessQueued`, and its E2E setup uses `setDispatchHarnessViaAPI`.

**Tech Stack:** React 18, TypeScript, Tailwind, shadcn/ui, `framer-motion@^12`, TanStack Query, Vitest + Testing Library (jsdom), Playwright, `pg` for E2E seeding.

## Global Constraints

- Copy: American spelling. No em-dashes anywhere: prose, comments, UI copy, commit messages. Engine names come from `HARNESS_ENGINES[i].label` (through `harnessEngineOf`). Nothing mentions the harness's earlier child process by name, DeepSeek, or "provider key".
- Comments earn their place. Write one only where the reason is not visible in the code; never restate what the line does, and do not add a doc comment to a self-evident function. Keep the ones already in code you move.
- Prefer shadcn/ui primitives over hand-rolled UI. State stays colocated: the chrome's state lives in `useHarnessChrome`, not in `ChatPane`'s body and not in an atom. React Query owns server state; Jotai is only for the persisted flag hint atoms that already follow that pattern.
- Motion inside a turn uses tokens from `apps/web/src/components/app/chat/turn/motion.ts` (`arrive`, `DURATION`, `fadeVariants`, `rowVariants`, `exitShrink`). No ad-hoc `duration-*` or `ease-*` class and no new `@keyframes`. The entry's arrival is Brad's `animate-chat-enter`. Reduced motion drops both layers: framer through `MotionConfig reducedMotion="user"` at `ChatPane`'s root, CSS through `motion-reduce:animate-none`.
- Nothing under `apps/web/src/components/app/chat/` may import `@/components/app/harness/use-harness-turns`, `harnessTurnsQueryKey`, `HarnessTurn`, or fetch `GET /api/v1/agents/:id/harness/turns`. That module, its test and its SSE invalidation stay exactly as they are; plan 4 deletes them.
- Web tests: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run <files>`. jsdom plus Testing Library, and there is no jest-dom: use plain matchers (`expect(el).not.toBeNull()`, `expect(el?.textContent).toContain(...)`), never `toBeInTheDocument`.
- Type check: `pnpm run check` from the worktree root. If its last step (`tsc -p tsconfig.scripts.json`) fails for want of root `@types/node`, that is a pre-existing gap unrelated to this plan: `pnpm --filter @dispatch/web check` is then the real gate and must pass.
- Each task ends green: the type check passes and the task's own tests pass. Tests use the existing fixtures; a test that asserts nothing is a defect.
- Commit messages: `type(scope): imperative subject`, lowercase after the colon, body wrapped at 72 that leads with the failure mode or effect, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Scopes in use here: `web`, `e2e`.
- Worktree `/home/nii/.dispatch/server-dsh-harness`, branch `dsh-harness-deploy`. Never touch `/home/nii/.dispatch/server` or `127.0.0.1:6767`. Do not run `pnpm run dev`.

---

## File structure

| Path                                                      | Responsibility after this plan                                                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/app/chat/harness-chrome.tsx`     | **New.** The dispatch-only chrome above the composer and the harness half of the composer's props. Exports `composerHint`, `newestTurnEntry`, `latestTurnPlan`, `harnessPromptHistory`, `useHarnessChrome`. |
| `apps/web/src/components/app/chat/chat-pane.tsx`          | Mounts the chrome, spreads the composer props, hosts the pane-wide drop overlay, and carries `MotionConfig reducedMotion="user"` at its root.                                                               |
| `apps/web/src/components/app/chat/chat-pane.test.tsx`     | Gains the still-relevant cases of `harness/harness-pane.test.tsx`.                                                                                                                                          |
| `apps/web/src/components/app/chat/chat-feed.test.tsx`     | Gains the one question case `harness/question-card.test.tsx` does not already have an equivalent for.                                                                                                       |
| `apps/web/src/components/app/chat/turn/registry.ts`       | `latestPlanItems` deleted: the plan comes off the feed's turn entries now.                                                                                                                                  |
| `apps/web/src/components/app/chat/turn/queued-prompt.tsx` | The row's text clamps to two lines: it sits in fixed chrome now, not in a scrolling stream.                                                                                                                 |
| `apps/web/src/components/app/agent-pane.tsx`              | One feed layer: `ChatPane` unconditionally. `harnessEnabled` gone from both prop types, the toggle and the pane.                                                                                            |
| `apps/web/src/components/app/agents-view.tsx`             | The `harnessEnabled` computation and both props gone. The rule that forces Chat on for a dispatch agent stays.                                                                                              |
| `apps/web/src/lib/center-tabs.ts`                         | `agentSupportsHarness` deleted; its doc comment goes back to `agentSupportsChat`.                                                                                                                           |
| `apps/web/src/components/app/harness/harness-pane.tsx`    | **Deleted**, with `harness-pane.test.tsx`.                                                                                                                                                                  |
| `apps/web/src/components/app/harness/turn-stream.tsx`     | **Deleted**: its only consumer was `HarnessPane`.                                                                                                                                                           |
| `apps/web/src/components/app/harness/question-card.tsx`   | **Deleted**, with `question-card.test.tsx`. Brad's question card renders questions.                                                                                                                         |
| `e2e/helpers.ts`                                          | `seedStreamTurnViaDB`: one settled turn in `agent_stream_events` plus the chat row it claims.                                                                                                               |
| `e2e/harness-agent.spec.ts`                               | The four live tests read the chat pane and the turn entries.                                                                                                                                                |
| `e2e/chat-surface.spec.ts`                                | A dispatch-agent case: a turn, a review, a pin write and a status event in one feed; and its touch-target case.                                                                                             |

---

### Task 1: The chrome's derivations come off the feed

The chrome needs four values that today come from `use-harness-turns`: whether a turn is running, the newest plan, the prompts the user typed before, and the composer's hint line. Three of them are now a read over the `turn` entries `ChatPane` already holds. This task lands them as pure functions with their tests, before anything renders them.

`ChatPane` holds `feed.entries`, which is `flattenFeedPages(query.data.pages)` (`apps/web/src/hooks/use-chat.ts:62`): pages arrive newest-first and each page ascends, so the flattened list is one ascending list across every page loaded. The newest turn is therefore found by walking that list backward from its end and taking the first `turn` entry. No page indexing, and "Load older" only ever prepends.

**Files:**

- Create: `apps/web/src/components/app/chat/harness-chrome.tsx`
- Modify: `apps/web/src/components/app/chat/turn/registry.ts` (delete `latestPlanItems`)
- Modify: `apps/web/src/components/app/chat/turn/registry.test.ts` (delete its `describe("latestPlanItems")` and the `assistantTurn` helper it alone uses)
- Test: `apps/web/src/components/app/chat/chat-pane.test.tsx`

**Interfaces:**

- Consumes: `ChatTurnEntry` and `ChatFeedEntry` from `@dispatch/shared` (plan 2, Task 2); `TodoItem` from `@/components/app/chat/turn/registry` (plan 2, Task 7 moved that file).
- Produces, from `apps/web/src/components/app/chat/harness-chrome.tsx`:
  - `function composerHint(streaming: boolean, queuedCount: number, isMobile?: boolean): string | undefined`
  - `function newestTurnEntry(entries: readonly ChatFeedEntry[]): ChatTurnEntry | null`
  - `function latestTurnPlan(entries: readonly ChatFeedEntry[]): TodoItem[]`
  - `function harnessPromptHistory(entries: readonly ChatFeedEntry[]): string[]`

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/app/chat/chat-pane.test.tsx`, add `ChatTurnEntry` to the shared type import so the first line reads:

```tsx
import type {
  ChatFeedEntry,
  ChatMessage,
  ChatTurnEntry,
} from "@dispatch/shared";
```

Add this import below the existing `./chat-pane` import block:

```tsx
import {
  composerHint,
  harnessPromptHistory,
  latestTurnPlan,
  newestTurnEntry,
} from "./harness-chrome";
```

Add this fixture directly under the existing `chat(m: ChatMessage)` helper:

```tsx
function turnEntry(overrides: Partial<ChatTurnEntry> = {}): ChatTurnEntry {
  return {
    type: "turn",
    id: "turn:1",
    agentId: "agt_1",
    at: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:09.000Z",
    prompt: {
      source: "chat",
      text: "read the readme",
      chatMessageId: "m-prompt",
      attachments: [],
    },
    trace: {
      startedAt: "2026-09-02T10:00:00.000Z",
      endedAt: "2026-09-02T10:00:09.000Z",
      finalResult: "ok",
      steps: [],
    },
    result: { text: "It documents the CLI.", streaming: false },
    settled: true,
    interrupted: false,
    ...overrides,
  };
}
```

Append these four describes to the end of the file:

```tsx
describe("composerHint", () => {
  it("says what Enter and the arrows do for each state", () => {
    expect(composerHint(false, 0)).toBeUndefined();
    expect(composerHint(true, 0)).toBe(
      "Agent is working · Enter queues your message · Ctrl+C stops"
    );
    expect(composerHint(true, 2)).toBe(
      "Agent is working · Enter queues your message · ↑ edits the queued one · Ctrl+C stops"
    );
    expect(composerHint(false, 1)).toBe(
      "Message queued · ↑ edits the queued one"
    );
  });

  it("drops the key hints on a touch keyboard", () => {
    // Neither ArrowUp nor Ctrl+C exists there, and the four-part string
    // wraps to three lines under a 320px field. The Stop button and the
    // queued row's own actions cover both on touch.
    expect(composerHint(true, 2, true)).toBe(
      "Agent is working · Enter queues your message"
    );
    expect(composerHint(false, 1, true)).toBe("Message queued");
    expect(composerHint(false, 0, true)).toBeUndefined();
  });
});

describe("newestTurnEntry", () => {
  it("takes the last turn in the feed whatever follows it", () => {
    const found = newestTurnEntry([
      chat(message({ id: "m0", text: "before" })),
      turnEntry({ id: "turn:1", settled: true }),
      turnEntry({ id: "turn:2", settled: false }),
      chat(message({ id: "m1", text: "after" })),
    ]);
    expect(found?.id).toBe("turn:2");
    expect(found?.settled).toBe(false);
  });

  it("is null when the feed carries no turn", () => {
    expect(newestTurnEntry([chat(message({ id: "m0" }))])).toBeNull();
    expect(newestTurnEntry([])).toBeNull();
  });
});

describe("latestTurnPlan", () => {
  it("takes the newest turn that published a plan, running or settled", () => {
    expect(
      latestTurnPlan([
        turnEntry({
          id: "turn:1",
          plan: [{ content: "old", status: "completed", priority: "low" }],
        }),
        turnEntry({
          id: "turn:2",
          settled: false,
          plan: [
            {
              content: "Read the README",
              status: "completed",
              priority: "high",
            },
            {
              content: "Echo the prompt",
              status: "in_progress",
              priority: "medium",
            },
          ],
        }),
      ])
    ).toEqual([
      { content: "Read the README", status: "completed" },
      { content: "Echo the prompt", status: "in_progress" },
    ]);
  });

  it("looks past a later turn that published none", () => {
    expect(
      latestTurnPlan([
        turnEntry({
          id: "turn:1",
          plan: [{ content: "keep me", status: "pending", priority: "low" }],
        }),
        turnEntry({ id: "turn:2" }),
      ])
    ).toEqual([{ content: "keep me", status: "pending" }]);
  });

  it("is empty when no turn published one", () => {
    expect(latestTurnPlan([turnEntry(), chat(message({ id: "m0" }))])).toEqual(
      []
    );
  });
});

describe("harnessPromptHistory", () => {
  it("keeps the typed prompts in order without immediate repeats", () => {
    expect(
      harnessPromptHistory([
        turnEntry({
          id: "turn:1",
          prompt: { source: "chat", text: "first", attachments: [] },
        }),
        turnEntry({
          id: "turn:2",
          prompt: { source: "chat", text: " first ", attachments: [] },
        }),
        turnEntry({
          id: "turn:3",
          prompt: { source: "chat", text: "second", attachments: [] },
        }),
      ])
    ).toEqual(["first", "second"]);
  });

  it("leaves out launch, agent and system prompts and empty text", () => {
    expect(
      harnessPromptHistory([
        turnEntry({
          id: "turn:1",
          prompt: { source: "launch", text: "kickoff", attachments: [] },
        }),
        turnEntry({
          id: "turn:2",
          prompt: {
            source: "agent",
            text: "from a peer",
            senderName: "Reviewer",
            attachments: [],
          },
        }),
        turnEntry({
          id: "turn:3",
          prompt: { source: "system", text: "injected", attachments: [] },
        }),
        turnEntry({
          id: "turn:4",
          prompt: { source: "chat", text: "   ", attachments: [] },
        }),
        turnEntry({
          id: "turn:5",
          prompt: { source: "chat", text: "mine", attachments: [] },
        }),
      ])
    ).toEqual(["mine"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-pane.test.tsx`

Expected: FAIL. The whole file fails to collect with `Failed to resolve import "./harness-chrome"`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/components/app/chat/harness-chrome.tsx`:

```tsx
import type { ChatFeedEntry, ChatTurnEntry } from "@dispatch/shared";

import type { TodoItem } from "@/components/app/chat/turn/registry";

/**
 * What Enter and the arrows do right now, in the composer's helper line.
 *
 * On a touch keyboard neither ArrowUp nor Ctrl+C exists, and the full string
 * wraps to three lines under a narrow field, so only the Enter half is worth
 * saying there. The Stop button and the queued row's own Send now / Remove
 * cover the rest.
 */
export function composerHint(
  streaming: boolean,
  queuedCount: number,
  isMobile = false
): string | undefined {
  if (!streaming && queuedCount === 0) return undefined;
  const parts = [
    streaming
      ? "Agent is working · Enter queues your message"
      : "Message queued",
  ];
  if (isMobile) return parts[0];
  if (queuedCount > 0) parts.push("↑ edits the queued one");
  if (streaming) parts.push("Ctrl+C stops");
  return parts.join(" · ");
}

/**
 * `useChatFeed` hands over one ascending list across every page it holds
 * (`flattenFeedPages`), so one walk back from the end needs no page
 * bookkeeping. Rows created while the turn ran carry their own later
 * timestamps and sit after it, which is why this looks past the tail.
 */
export function newestTurnEntry(
  entries: readonly ChatFeedEntry[]
): ChatTurnEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "turn") return entry;
  }
  return null;
}

/**
 * A running turn carries its plan the same way a settled one does, so
 * unlike the turns-endpoint version this needs no live/settled split.
 */
export function latestTurnPlan(entries: readonly ChatFeedEntry[]): TodoItem[] {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "turn" || entry.plan === undefined) continue;
    return entry.plan.map((e) => ({ content: e.content, status: e.status }));
  }
  return [];
}

/**
 * For the composer's ArrowUp history, so only prompts that came from the
 * composer: a launch post, a prompt from another agent and an injected one
 * were never typed here.
 */
export function harnessPromptHistory(
  entries: readonly ChatFeedEntry[]
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "turn" || entry.prompt.source !== "chat") continue;
    const text = entry.prompt.text.trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-pane.test.tsx`

Expected: PASS, all files, including the pane's existing cases.

- [ ] **Step 5: Delete `latestPlanItems`, whose model the plan no longer comes from**

In `apps/web/src/components/app/chat/turn/registry.ts`, delete the whole `latestPlanItems` function and its doc comment:

```ts
/**
 * The task list as the engine last published it: the live turn's plan while
 * one runs, else the newest assistant turn's; empty when neither has one.
 */
export function latestPlanItems(
  turns: Turn[],
  livePlan: HarnessPlanEntry[] | null,
  streaming: boolean
): TodoItem[] {
  const toItems = (plan: HarnessPlanEntry[]) =>
    plan.map((e) => ({ content: e.content, status: e.status }));
  if (streaming && livePlan) return toItems(livePlan);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const plan = turns[i].extra?.plan;
    if (turns[i].role === "assistant" && Array.isArray(plan)) {
      return toItems(plan as HarnessPlanEntry[]);
    }
  }
  return [];
}
```

Keep `export type TodoItem` where it is: `latestTurnPlan` and `TasksStrip` both use it. If deleting the function leaves `HarnessPlanEntry` or `Turn` unused in that file's imports, drop them from the import list; `tsc` will not complain (there is no `noUnusedLocals` here) but eslint will.

In `apps/web/src/components/app/chat/turn/registry.test.ts`, delete `latestPlanItems` from the import list, delete the whole `describe("latestPlanItems")` block, and delete the `assistantTurn` helper if that block was its only user (grep the file for `assistantTurn` before deciding).

- [ ] **Step 6: Run the registry test and the type check**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/turn/registry.test.ts src/components/app/chat/chat-pane.test.tsx`

Expected: PASS. The registry file reports fewer tests than before by exactly the number of cases in the deleted describe.

Run: `pnpm --filter @dispatch/web check`

Expected: exit 0, no output. If it names `latestPlanItems` as a missing export, an importer was missed: grep for it and remove that use.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/app/chat/harness-chrome.tsx \
  apps/web/src/components/app/chat/chat-pane.test.tsx \
  apps/web/src/components/app/chat/turn/registry.ts \
  apps/web/src/components/app/chat/turn/registry.test.ts
git commit -m "$(cat <<'EOF'
feat(web): derive the harness chrome's state from the chat feed

The tasks strip, the composer hint and the ArrowUp history all read the
turns endpoint today, which is a second cache over the same rows the chat
feed already carries. These four pure reads take them off the feed's turn
entries instead, so the chrome can move into ChatPane without it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The chrome above the composer

`ChatPane` grows the harness-only chrome, shown when `agent.type === "dispatch"` and otherwise absent: the status line, the queued prompts, the tasks strip and the chip row (model chip, usage chip, Stop), above the presence strip and the composer. `MotionConfig reducedMotion="user"` moves to `ChatPane`'s root, which is the only `MotionConfig` in the app and the one thing that makes every framer transition inside a turn honor the OS setting.

The chrome is inert for other agent types because `ChatPane` passes `agentId: null` for them, and `useHarnessConfig`, `useHarnessQueued`, `useHarnessQueue` and `useHarnessInterrupt` are all keyed off that id: no `/harness/*` request is made for a claude, codex, gemini, opencode or terminal agent, and `chrome` is `null`.

The starting screen (`harness-starting`) and the empty state (`harness-empty`) do not come across: the status line carries what they said, and it shows whether or not the feed has turns, which is what those two could not do. `ChatPane`'s own `chat-empty` invites the first message.

**Where the queued prompts go, and why.** They are the first rows of the chrome, above the tasks strip, and not rows in the feed. Three reasons, in order of weight:

1. **In the feed they would be a second copy of the message.** A queued prompt has not opened a turn yet, so nothing claims its chat row: the server still lists it as a `chat` entry and the feed already shows it as the user's post. The old surface had no such row to collide with, because it rendered no chat entries at all. In the chrome the row is not the message again but the controls for what is waiting: Send now, Remove, and who it came from.
2. **They must not scroll away.** Each row carries two actions on live server state, and a reader parked up the feed would never see what they queued. The tasks strip is pinned for the same reason (spec Q2, decided: pinned).
3. **The feed's scroll bookkeeping stays untouched.** `ChatPane` detects arrivals and growth from the entry list and anchors on `[data-chat-entry-id]` nodes; a block inside `chat-scroll` that is neither would appear below the fold with nothing to pin the scroll to it.

The cost is that a long queued message would push the composer down, so `QueuedPrompt`'s text clamps to two lines (step 4).

**Files:**

- Modify: `apps/web/src/components/app/chat/harness-chrome.tsx` (add `useHarnessChrome`)
- Modify: `apps/web/src/components/app/chat/chat-pane.tsx:205-221` (`composerDisabledReason`), `:223-234` (the signature stays), the pane body, `:537-541` (the root div and the drop overlay, whose test is Task 3's), `:663-689` (the composer region)
- Modify: `apps/web/src/components/app/chat/turn/queued-prompt.tsx:41-43`
- Test: `apps/web/src/components/app/chat/chat-pane.test.tsx` (a new `describe("ChatPane harness chrome")`, every case of it green on this task's run)

**Interfaces:**

- Consumes: `TasksStrip` from `@/components/app/chat/turn/tasks-strip`; `QueuedPrompt` from `@/components/app/chat/turn/queued-prompt`; `arrive`, `DURATION`, `exitShrink`, `fadeVariants`, `rowVariants` from `@/components/app/chat/turn/motion`; `TodoItem` from `@/components/app/chat/turn/registry` (all four moved by plan 2, Task 7). `useHarnessQueued`, `useHarnessQueue`, `useHarnessInterrupt` from `@/components/app/harness/use-harness-queue` (plan 2, Task 10 added `useHarnessQueued`). `currentChoiceName`, `useHarnessConfig`, `useSetHarnessConfig` from `@/components/app/harness/use-harness-config`; `ModelPicker`, `UsageDialog`, `ProviderIcon` from their own modules under `@/components/app/harness/`; `harnessEngineOf` from `@dispatch/shared`.
- Produces, from `apps/web/src/components/app/chat/harness-chrome.tsx`:
  - `type HarnessChromeInput = { agentId: string | null; agent: Agent | null; entries: readonly ChatFeedEntry[]; isMobile: boolean; disabledReason: string | null; onError: (message: string | null) => void }`
  - `type HarnessChrome = { chrome: ReactNode }` (Task 3 adds one more member, `composer`)
  - `function useHarnessChrome(input: HarnessChromeInput): HarnessChrome`
- Produces, in the DOM: testids `chat-harness-chrome` (new), `harness-status-line`, `harness-login-hint`, `harness-model-chip`, `harness-model-chip-label`, `harness-usage-chip`, `harness-stop`, `harness-tasks-presence` (all carried over from `harness-pane.tsx`).

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/app/chat/chat-pane.test.tsx`, add these four mock blocks after the existing `vi.mock("@/hooks/use-chat", ...)` block. The queue is the one piece of chrome state a test has to drive, so it goes through a hoisted holder like `H`:

```tsx
const HARNESS = vi.hoisted(() => ({
  queued: [] as import("@dispatch/shared").HarnessQueuedPrompt[],
  sendNow: vi.fn(async (_id: string) => {}),
  remove: vi.fn(async (_id: string) => {}),
  interrupt: vi.fn(async () => {}),
}));

vi.mock("@/components/app/harness/use-harness-queue", () => ({
  harnessQueueQueryKey: (agentId: string | null) => ["harness-queue", agentId],
  useHarnessQueued: () => ({
    queued: HARNESS.queued,
    loading: false,
    error: null,
  }),
  useHarnessQueue: () => ({
    sendNow: HARNESS.sendNow,
    remove: HARNESS.remove,
    busyId: null,
  }),
  useHarnessInterrupt: () => ({
    interrupt: HARNESS.interrupt,
    interrupting: false,
  }),
}));
vi.mock(
  "@/components/app/harness/use-harness-config",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/app/harness/use-harness-config")
    >()),
    // `running: true` because the shared fixture is a running agent, and
    // the chip shows the activity bars in place of the engine's mark while
    // the agent runs without a session.
    useHarnessConfig: () => ({
      running: true,
      options: [],
      model: undefined,
      effort: undefined,
      loading: false,
    }),
    useSetHarnessConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  })
);
// The dialog reads a full query result; `api` is mocked file-wide, so the
// real hook would hand it `{ agents: [] }` and `data.engines.map` would throw.
vi.mock("@/components/app/harness/use-harness-usage", () => ({
  HARNESS_USAGE_QUERY_KEY: ["harness-usage"],
  useHarnessUsage: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
```

Add to `beforeEach`, after `H.markRead.mockReset();`:

```tsx
HARNESS.queued = [];
HARNESS.sendNow.mockReset();
HARNESS.remove.mockReset();
HARNESS.interrupt.mockReset();
```

Add this fixture under the existing `agent` fixture:

```tsx
const dispatchAgent: Agent = {
  ...agent,
  type: "dispatch",
  model: "codex/default",
};
```

Append this describe to the end of the file:

```tsx
describe("ChatPane harness chrome", () => {
  it("mounts no chrome and no harness controls for an agent that is not a dispatch agent", () => {
    renderPane();
    expect(screen.queryByTestId("chat-harness-chrome")).toBeNull();
    expect(screen.queryByTestId("harness-model-chip")).toBeNull();
    expect(screen.queryByTestId("harness-usage-chip")).toBeNull();
    expect(screen.queryByTestId("harness-stop")).toBeNull();
    expect(screen.queryByTestId("harness-status-line")).toBeNull();
  });

  it("wears the engine's mark on the model chip for the model it was launched with", () => {
    renderPane({ agent: dispatchAgent });
    const mark = screen
      .getByTestId("harness-model-chip")
      .querySelector('[data-testid="provider-icon"]');
    expect(mark?.getAttribute("data-provider")).toBe("openai");
    expect(screen.getByTestId("harness-model-chip-label")).not.toBeNull();
  });

  it("falls back to the default engine's mark and login command when no model is stored", () => {
    // An agent created on the default path stores no model on older rows,
    // and the chip and the hint both read the engine off the model.
    renderPane({
      agent: {
        ...dispatchAgent,
        model: null,
        status: "error",
        latestEvent: {
          type: "blocked",
          message: "Claude Code is not logged in on the server.",
          updatedAt: "2026-09-07T12:00:00.000Z",
          metadata: null,
        },
      },
    });
    const mark = screen
      .getByTestId("harness-model-chip")
      .querySelector('[data-testid="provider-icon"]');
    expect(mark?.getAttribute("data-provider")).toBe("anthropic");
    expect(screen.getByTestId("harness-login-hint").textContent).toContain(
      "claude /login"
    );
  });

  it("shows the reason and the login command whether or not the feed has turns", () => {
    // The old surface put this in an empty state, so an engine whose login
    // lapsed mid-life showed nothing at all once the agent had history.
    H.entries = [turnEntry()];
    renderPane({
      agent: {
        ...dispatchAgent,
        status: "error",
        latestEvent: {
          type: "blocked",
          message: "Codex is not logged in on the server.",
          updatedAt: "2026-09-07T12:00:00.000Z",
          metadata: null,
        },
      },
    });
    expect(screen.getByTestId("harness-status-line").textContent).toContain(
      "Codex is not logged in on the server."
    );
    expect(screen.getByTestId("harness-login-hint").textContent).toContain(
      "codex login --device-auth"
    );
  });

  it("says the harness is not running when the agent errored without a message", () => {
    renderPane({
      agent: { ...dispatchAgent, status: "error", latestEvent: undefined },
    });
    expect(screen.getByTestId("harness-status-line").textContent).toContain(
      "The harness is not running. Press Start to relaunch it."
    );
  });

  it("names what the harness is doing while it starts and opens nothing from the faded chips", () => {
    // The chrome animates to opacity 0 but stays mounted, so without the
    // pointer-events and tabindex guards a click on blank space opened the
    // portaled Model dialog.
    renderPane({
      agent: {
        ...dispatchAgent,
        status: "creating",
        latestEvent: {
          type: "working",
          message: "Installing dependencies…",
          updatedAt: "2026-09-07T12:00:00.000Z",
          metadata: null,
        },
      },
    });
    const line = screen.getByTestId("harness-status-line");
    expect(line.textContent).toContain("Installing dependencies…");
    expect(line.querySelector('[role="status"]')).not.toBeNull();
    const chip = screen.getByTestId("harness-model-chip");
    expect(chip.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(chip);
    expect(screen.queryByTestId("harness-model-picker")).toBeNull();
    fireEvent.click(screen.getByTestId("harness-usage-chip"));
    expect(screen.queryByTestId("harness-usage-dialog")).toBeNull();
    expect(
      (screen.getByTestId("chat-composer-input") as HTMLTextAreaElement)
        .disabled
    ).toBe(true);
  });

  it("keeps the composer mounted across the starting handoff", () => {
    const { rerender } = renderPane({
      agent: { ...dispatchAgent, status: "creating" },
    });
    const input = screen.getByTestId("chat-composer-input");
    rerender(
      <ChatPane
        agentId="agt_1"
        agent={dispatchAgent}
        terminalMode="tmux"
        active={true}
        showChildAgents={true}
        childAgentIds={[]}
        onShowChildAgentsChange={vi.fn()}
        openLightbox={vi.fn()}
        isMobile={false}
      />
    );
    expect(screen.getByTestId("chat-composer-input")).toBe(input);
  });

  it("pins the current task list above the composer and folds it", () => {
    H.entries = [
      turnEntry({
        plan: [
          { content: "Read the README", status: "completed", priority: "high" },
          {
            content: "Echo the prompt",
            status: "in_progress",
            priority: "medium",
          },
          { content: "Wrap up", status: "pending", priority: "low" },
        ],
      }),
    ];
    renderPane({ agent: dispatchAgent });
    const strip = screen.getByTestId("harness-tasks");
    expect(screen.getByTestId("harness-tasks-presence")).not.toBeNull();
    expect(strip.textContent).toContain("1 of 3 done");
    const items = strip.querySelectorAll('[data-testid="harness-todo-item"]');
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("data-status")).toBe("in_progress");
    expect(screen.getByTestId("harness-tasks-more").textContent).toBe(
      "+1 more"
    );
    fireEvent.click(screen.getByTestId("harness-tasks-more"));
    expect(
      strip.querySelectorAll('[data-testid="harness-todo-item"]')
    ).toHaveLength(3);
    fireEvent.click(screen.getByTestId("harness-tasks-toggle"));
    expect(strip.querySelector('[data-testid="harness-todo-list"]')).toBeNull();
    expect(strip.textContent).toContain("Echo the prompt");
  });

  it("drops the strip once every task is done", () => {
    H.entries = [
      turnEntry({
        plan: [
          { content: "Read the README", status: "completed", priority: "high" },
          { content: "Wrap up", status: "completed", priority: "low" },
        ],
      }),
    ];
    renderPane({ agent: dispatchAgent });
    expect(screen.queryByTestId("harness-tasks")).toBeNull();
  });

  it("lists queued prompts above the composer with Send now and Remove", () => {
    HARNESS.queued = [
      {
        id: "m2",
        source: "chat",
        text: "second thoughts",
        chatMessageId: "m2",
        attachments: [],
        createdAt: "2026-09-04T10:00:01.000Z",
      },
      {
        id: "q_3",
        source: "agent",
        text: "and mine",
        senderName: "Reviewer",
        attachments: [],
        createdAt: "2026-09-04T10:00:02.000Z",
      },
    ];
    renderPane({ agent: dispatchAgent });
    const rows = screen.getAllByTestId("harness-queued");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("second thoughts");
    expect(rows[0]?.textContent).toContain("Queued");
    expect(rows[1]?.textContent).toContain("from Reviewer");
    const chrome = screen.getByTestId("chat-harness-chrome");
    expect(chrome.contains(rows[0]!)).toBe(true);
    expect(screen.getByTestId("chat-scroll").contains(rows[0]!)).toBe(false);

    fireEvent.click(
      rows[0]!.querySelector('[data-testid="harness-queued-send-now"]')!
    );
    expect(HARNESS.sendNow).toHaveBeenCalledWith("m2");
    fireEvent.click(
      rows[1]!.querySelector('[data-testid="harness-queued-remove"]')!
    );
    expect(HARNESS.remove).toHaveBeenCalledWith("q_3");
  });

  it("offers Stop while a turn runs and interrupts on click", () => {
    H.entries = [
      turnEntry({
        settled: false,
        trace: { startedAt: "2026-09-02T10:00:00.000Z", steps: [] },
        result: { text: "working", streaming: true },
      }),
    ];
    renderPane({ agent: dispatchAgent });
    const stop = screen.getByTestId("harness-stop");
    // React stringifies aria-* booleans, so the visible state reads "false".
    expect(stop.getAttribute("aria-hidden")).toBe("false");
    expect(stop.className).not.toContain("invisible");
    fireEvent.click(stop);
    expect(HARNESS.interrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps Stop laid out but hidden when nothing runs", () => {
    H.entries = [turnEntry()];
    renderPane({ agent: dispatchAgent });
    const stop = screen.getByTestId("harness-stop");
    expect(stop.getAttribute("aria-hidden")).toBe("true");
    expect(stop.className).toContain("invisible");
  });

  it("opens the usage dialog from the chip", () => {
    renderPane({ agent: dispatchAgent });
    fireEvent.click(screen.getByTestId("harness-usage-chip"));
    expect(screen.getByTestId("harness-usage-dialog")).not.toBeNull();
  });

  it("keeps every chip a 44px target on a coarse pointer", () => {
    renderPane({ agent: dispatchAgent });
    for (const id of [
      "harness-model-chip",
      "harness-usage-chip",
      "harness-stop",
    ]) {
      expect(screen.getByTestId(id).className).toContain(
        "pointer-coarse:min-h-11"
      );
    }
    // Without min-w-0 the button's min-content is the whole nowrap label, so
    // the span's `truncate` never engages and the row overflows instead.
    expect(screen.getByTestId("harness-model-chip").className).toContain(
      "min-w-0"
    );
  });

  it("renders a turn's shortcut pins, because the pane provides the turn context", () => {
    H.entries = [
      turnEntry({
        trace: {
          startedAt: "2026-09-02T10:00:00.000Z",
          endedAt: "2026-09-02T10:00:09.000Z",
          finalResult: "ok",
          steps: [
            {
              id: "s1",
              kind: "other",
              label: "mcp__dispatch__dispatch_pins",
              status: "ok",
              startedAt: "2026-09-02T10:00:01.000Z",
              endedAt: "2026-09-02T10:00:02.000Z",
              durMs: 1000,
              detail: {
                input: {
                  pins: [
                    {
                      label: "Run the E2E",
                      type: "shortcut",
                      value: "run e2e",
                    },
                    { label: "Gone", type: "shortcut", value: "x" },
                  ],
                },
              },
            },
          ],
        },
      }),
    ];
    renderPane({
      agent: {
        ...dispatchAgent,
        pins: [
          {
            id: "p1",
            label: "Run the E2E",
            value: "run e2e",
            type: "shortcut",
            group: "Next steps",
          },
        ],
      },
    });
    const row = screen.getByTestId("harness-shortcuts");
    expect(
      [...row.querySelectorAll('[data-testid="pin-item"]')].map((i) =>
        i.getAttribute("data-pin-label")
      )
    ).toEqual(["Run the E2E"]);
  });
});
```

The overlay this task renders has no test here: nothing can set `draggingFiles` until the composer is handed `dropTargetRef`, which is Task 3. Its case lives there, with the wiring that makes it pass.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-pane.test.tsx -t "harness chrome"`

Expected: FAIL. Every case but the first (`mounts no chrome ...`) fails on `Unable to find an element by: [data-testid="harness-model-chip"]` and friends.

- [ ] **Step 3: Add the hook to `harness-chrome.tsx`**

Replace the file's import block with:

```tsx
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ChatFeedEntry, ChatTurnEntry } from "@dispatch/shared";
import { harnessEngineOf } from "@dispatch/shared";
import { AnimatePresence, motion } from "framer-motion";
import { CircleDollarSign, Cpu, Square } from "lucide-react";

import { QueuedPrompt } from "@/components/app/chat/turn/queued-prompt";
import {
  arrive,
  DURATION,
  exitShrink,
  fadeVariants,
  rowVariants,
} from "@/components/app/chat/turn/motion";
import type { TodoItem } from "@/components/app/chat/turn/registry";
import { TasksStrip } from "@/components/app/chat/turn/tasks-strip";
import { ModelPicker } from "@/components/app/harness/model-picker";
import { ProviderIcon } from "@/components/app/harness/provider-icon";
import { UsageDialog } from "@/components/app/harness/usage-dialog";
import {
  currentChoiceName,
  useHarnessConfig,
  useSetHarnessConfig,
} from "@/components/app/harness/use-harness-config";
import {
  useHarnessInterrupt,
  useHarnessQueue,
  useHarnessQueued,
} from "@/components/app/harness/use-harness-queue";
import type { Agent } from "@/components/app/types";
import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";
```

Append to the end of the file:

```tsx
const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-3";

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export type HarnessChromeInput = {
  /**
   * The agent id for a Dispatch Harness agent, null for every other type.
   * Nulling it here is what makes the whole hook inert: every harness query
   * below is keyed off it and disabled while it is null, and `chrome` is
   * null too, so no other agent type pays for this or renders any of it.
   */
  agentId: string | null;
  agent: Agent | null;
  /** The feed's entries, oldest first, across every page loaded. */
  entries: readonly ChatFeedEntry[];
  isMobile: boolean;
  /** The composer's reason, shown on the status line when the harness is down. */
  disabledReason: string | null;
  /** Reports an action failure to the pane's one error slot. */
  onError: (message: string | null) => void;
};

export type HarnessChrome = {
  /** The chrome above the composer; null for every agent type but dispatch. */
  chrome: ReactNode;
};

/**
 * Everything live comes from the chat feed the pane already holds: the
 * running turn and the plan are reads over its `turn` entries, so there is
 * no second query and no second cache. What is not feed-shaped stays on its
 * own query: the session's model config, and the queue, which is in-memory
 * state on the server rather than a row.
 */
export function useHarnessChrome({
  agentId,
  agent,
  entries,
  isMobile,
  disabledReason,
  onError,
}: HarnessChromeInput): HarnessChrome {
  const { queued } = useHarnessQueued(agentId);
  const {
    sendNow: sendQueuedNow,
    remove: removeQueued,
    busyId: queueBusyId,
  } = useHarnessQueue(agentId);
  const { interrupt, interrupting } = useHarnessInterrupt(agentId);
  const config = useHarnessConfig(agentId);
  const setConfig = useSetHarnessConfig(agentId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  // The tasks strip's fold, kept here so a new list does not reopen it.
  const [tasksExpanded, setTasksExpanded] = useState(!isMobile);

  const newest = useMemo(() => newestTurnEntry(entries), [entries]);
  const streaming = newest !== null && !newest.settled;
  const tasks = useMemo(() => latestTurnPlan(entries), [entries]);
  const tasksOpen = tasks.some((t) => t.status !== "completed");

  const applyConfig = useCallback(
    async (changes: { configId: string; value: string }[]) => {
      setConfigError(null);
      try {
        for (const change of changes) await setConfig.mutateAsync(change);
        setPickerOpen(false);
      } catch (err) {
        setConfigError(errorText(err, "Could not apply."));
      }
    },
    [setConfig]
  );

  const onSendNow = useCallback(
    (id: string) => {
      onError(null);
      sendQueuedNow(id).catch((err: unknown) => {
        onError(errorText(err, "Could not send."));
      });
    },
    [onError, sendQueuedNow]
  );
  const onRemoveQueued = useCallback(
    (id: string) => {
      onError(null);
      removeQueued(id).catch((err: unknown) => {
        onError(errorText(err, "Could not remove."));
      });
    },
    [onError, removeQueued]
  );
  const onStop = useCallback(() => {
    onError(null);
    interrupt().catch((err: unknown) => {
      onError(errorText(err, "Could not stop."));
    });
  }, [interrupt, onError]);

  // The pane is up before the harness is: setup (worktree, dependencies)
  // runs first, and a prompt sent then has nowhere to go.
  const starting = agent?.status === "creating";
  const errored = agent?.status === "error";
  const statusMessage = agent?.latestEvent?.message?.trim() || null;
  const engine = harnessEngineOf(agent?.model);
  const modelName = currentChoiceName(config.model);
  const effortName = currentChoiceName(config.effort);
  const fixedReason =
    engine && !engine.publishesModelOption
      ? `${engine.label} sets its model at launch.`
      : null;
  const launchModel = agent?.model?.includes("/")
    ? agent.model.slice(agent.model.indexOf("/") + 1)
    : null;
  const chipLabel = fixedReason
    ? `${launchModel === "default" || !launchModel ? engine?.label : launchModel} · fixed`
    : config.running
      ? `${modelName ?? "model"}${effortName ? ` · ${effortName.toLowerCase()}` : ""}`
      : starting || agent?.status === "running"
        ? "starting…"
        : "model · not running";
  /**
   * Shown whatever the feed holds, which is the point: the old surface said
   * this in an empty state, so a start failure, an engine exit and a login
   * that lapsed after the agent had already run were all invisible to an
   * agent with history.
   */
  const statusLine = starting
    ? (statusMessage ?? "Starting the harness…")
    : errored
      ? (statusMessage ?? disabledReason)
      : null;
  const loginCommand =
    errored && engine && /not logged in/i.test(statusMessage ?? "")
      ? engine.loginCommand
      : null;

  const chrome =
    agentId === null ? null : (
      <>
        {statusLine ? (
          <div className="mb-1.5 text-[11px]" data-testid="harness-status-line">
            <div className="flex items-start gap-2">
              {starting ? (
                <ActivityBars size={10} className="mt-px shrink-0" />
              ) : null}
              <span
                className={cn(
                  "min-w-0 break-words",
                  errored ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {statusLine}
              </span>
            </div>
            {loginCommand ? (
              <p
                className="mt-1 break-words text-muted-foreground"
                data-testid="harness-login-hint"
              >
                Run as the service user, then press Start:{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                  {loginCommand}
                </code>
              </p>
            ) : null}
          </div>
        ) : null}
        {/* Driven by `starting` rather than keyed on it, so the chips keep
          their nodes (and their dialogs) across the handoff. While faded out
          the block also stops taking clicks and focus: opacity alone leaves
          an invisible chip both clickable and tabbable. */}
        <motion.div
          animate={starting ? { opacity: 0, y: 6 } : { opacity: 1, y: 0 }}
          transition={arrive(DURATION.slow)}
          className={cn("min-w-0", starting && "pointer-events-none")}
          data-testid="chat-harness-chrome"
          data-starting={starting ? "true" : undefined}
        >
          <AnimatePresence initial={false}>
            {queued.map((prompt) => (
              <motion.div
                key={prompt.id}
                layout
                variants={rowVariants}
                initial="hidden"
                animate="shown"
                exit={exitShrink}
                transition={arrive()}
                className="mb-1.5"
                style={{ overflow: "hidden" }}
              >
                <QueuedPrompt
                  prompt={prompt}
                  busy={queueBusyId === prompt.id}
                  onSendNow={onSendNow}
                  onRemove={onRemoveQueued}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {tasksOpen ? (
              <motion.div
                key="tasks"
                data-testid="harness-tasks-presence"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={exitShrink}
                transition={arrive()}
                style={{ overflow: "hidden" }}
              >
                <TasksStrip
                  items={tasks}
                  open={tasksExpanded}
                  onOpenChange={setTasksExpanded}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div className="mb-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              title={
                fixedReason ?? "Model and reasoning effort (or type /model)"
              }
              data-testid="harness-model-chip"
              data-fixed={fixedReason ? "true" : undefined}
              disabled={starting}
              tabIndex={starting ? -1 : 0}
              className={cn(
                CHIP_CLASS,
                // min-w-0 or the button's min-content is the whole nowrap
                // label, and the span's `truncate` never engages: the usage
                // chip and Stop get pushed off a narrow pane instead.
                "min-w-0 max-w-full",
                fixedReason && "opacity-70"
              )}
            >
              {starting || (!config.running && agent?.status === "running") ? (
                <ActivityBars size={10} className="shrink-0" />
              ) : engine ? (
                <ProviderIcon provider={engine.id} />
              ) : (
                <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
              )}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={chipLabel}
                  data-testid="harness-model-chip-label"
                  className="truncate"
                  variants={fadeVariants}
                  initial="hidden"
                  animate="shown"
                  exit="hidden"
                  transition={arrive(DURATION.fast)}
                >
                  {chipLabel}
                </motion.span>
              </AnimatePresence>
            </button>
            <button
              type="button"
              onClick={() => setUsageOpen(true)}
              title="Engine usage this month (or type /usage)"
              data-testid="harness-usage-chip"
              disabled={starting}
              tabIndex={starting ? -1 : 0}
              className={CHIP_CLASS}
            >
              <CircleDollarSign
                className="h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              usage
            </button>
            {/* The Stop slot is always laid out, so the row does not reflow
              when a turn starts; the button only shows while one runs. */}
            <button
              type="button"
              onClick={onStop}
              disabled={interrupting || !streaming}
              aria-hidden={!streaming}
              tabIndex={streaming ? 0 : -1}
              title="Stop the running turn (Ctrl+C in the field); queued messages run next"
              data-testid="harness-stop"
              className={cn(
                "ml-auto inline-flex items-center gap-1 rounded-full border border-status-blocked/50 px-2 py-0.5 text-[11px] text-status-blocked hover:bg-status-blocked/10 disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3",
                !streaming && "invisible"
              )}
            >
              <Square className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              {interrupting ? "Stopping…" : "Stop"}
            </button>
          </div>
          <UsageDialog open={usageOpen} onOpenChange={setUsageOpen} />
          <ModelPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            model={config.model}
            effort={config.effort}
            running={config.running}
            saving={setConfig.isPending}
            error={configError}
            fixedReason={fixedReason}
            launchModel={launchModel}
            engineLabel={engine?.label}
            onApply={applyConfig}
          />
        </motion.div>
      </>
    );

  return { chrome };
}
```

`streaming`, `queued`, `onStop`, `setPickerOpen` and `setUsageOpen` are also what Task 3 returns to the composer; leave them where they are.

- [ ] **Step 4: Clamp the queued row's text**

In `apps/web/src/components/app/chat/turn/queued-prompt.tsx`, the prompt's paragraph is:

```tsx
<p className="min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-foreground/60">
  {prompt.text}
</p>
```

Replace it with:

```tsx
{
  /* The row sits in fixed chrome above the composer now rather than
          in a scrolling stream, so an unclamped long message would push the
          composer off a short pane. */
}
<p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap text-[12.5px] leading-[1.55] text-foreground/60">
  {prompt.text}
</p>;
```

- [ ] **Step 5: Mount the chrome in `ChatPane`**

In `apps/web/src/components/app/chat/chat-pane.tsx`:

Add to the imports (framer, the hook, the icon):

```tsx
import { MotionConfig } from "framer-motion";
import { ArrowDown, MessageSquare, Upload } from "lucide-react";
import { useHarnessChrome } from "@/components/app/chat/harness-chrome";
```

Give a stopped harness its own reason. `composerDisabledReason` currently ends:

```tsx
  if (agent.status === "creating") return "The agent is still starting up.";
  if (agent.status !== "running") {
    return "The agent is not running. Start it to send messages.";
  }
  return null;
}
```

Replace that with:

```tsx
  if (agent.status === "creating") return "The agent is still starting up.";
  // A harness agent has no CLI in its pane to look at, so the reason is also
  // what its status line says; "Start" is the control that fixes it.
  if (agent.status === "error" && agent.type === "dispatch") {
    return "The harness is not running. Press Start to relaunch it.";
  }
  if (agent.status !== "running") {
    return "The agent is not running. Start it to send messages.";
  }
  return null;
}
```

Add the drop state beside the other refs, right after `const scrollRef = useRef<HTMLDivElement>(null);`:

```tsx
// A file dropped anywhere on the pane attaches to the composer.
const dropRef = useRef<HTMLDivElement>(null);
const [draggingFiles, setDraggingFiles] = useState(false);
```

After `const answeringMessageId = ...` (just before the `return`), add:

```tsx
// The harness chrome belongs to a Dispatch Harness agent and to no other
// type. Nulling the id is what keeps every /harness/* query disabled and
// the chrome unmounted for the rest.
const harnessAgentId = agent?.type === "dispatch" ? agentId : null;
const harness = useHarnessChrome({
  agentId: harnessAgentId,
  agent,
  entries,
  isMobile,
  disabledReason,
  onError: setSendError,
});
```

Wrap the root and add the overlay. The return currently opens:

```tsx
  return (
    <div
      className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-background"
      data-testid="chat-pane"
    >
      <div className="relative min-h-0 flex-1">
```

Replace with:

```tsx
  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={dropRef}
        className="relative flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-background"
        data-testid="chat-pane"
        data-dragging={draggingFiles ? "true" : undefined}
      >
        {draggingFiles ? (
          <div
            data-testid="chat-drop-overlay"
            className="pointer-events-none absolute inset-0 z-40 m-2 overflow-hidden rounded-xl bg-[linear-gradient(to_right,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)))] p-[2px] saturate-[1.35] brightness-[1.05]"
          >
            <div className="relative grid h-full w-full place-items-center overflow-hidden rounded-[10px] bg-background/85 backdrop-blur-sm">
              <div className="dispatch-reconnect-scan pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-[reconnect-scan_1350ms_ease-in-out_infinite] bg-[linear-gradient(to_right,transparent,hsl(var(--status-working)),transparent)] opacity-25 will-change-transform motion-reduce:hidden" />
              <div className="relative flex flex-col items-center gap-2 px-6 text-center text-foreground">
                <Upload className="h-8 w-8" />
                <p className="text-sm font-medium">Drop files to attach</p>
                <p className="text-xs text-muted-foreground">
                  They go with your next message.
                </p>
              </div>
            </div>
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1">
```

Then re-indent the rest of the JSX by one level and close with:

```tsx
        {shortcutDialog}
      </div>
    </MotionConfig>
  );
}
```

(The `relative` on the root is new: the overlay is absolutely positioned against it.)

Render the chrome as the first child of the composer region. It currently opens:

```tsx
      <div
        className={cn(
          "min-w-0 max-w-full shrink-0 overflow-hidden border-t border-border/40 px-4 pt-2",
          isMobile ? "pb-2" : "pb-3"
        )}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
```

Insert `{harness.chrome}` between them:

```tsx
      <div
        className={cn(
          "min-w-0 max-w-full shrink-0 overflow-hidden border-t border-border/40 px-4 pt-2",
          isMobile ? "pb-2" : "pb-3"
        )}
      >
        {harness.chrome}
        <div className="mb-1.5 flex items-center justify-between gap-2">
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-pane.test.tsx`

Expected: PASS, whole file, every new case and every pre-existing one. If `does not re-render memoised posts when the pane re-renders with equal data` regresses, the chrome is re-rendering the feed and the fix is in the memo dependencies, not in the test.

- [ ] **Step 7: Type check**

Run: `pnpm --filter @dispatch/web check`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/app/chat/harness-chrome.tsx \
  apps/web/src/components/app/chat/chat-pane.tsx \
  apps/web/src/components/app/chat/chat-pane.test.tsx \
  apps/web/src/components/app/chat/turn/queued-prompt.tsx
git commit -m "$(cat <<'EOF'
feat(web): put the harness chrome in the chat composer region

A dispatch agent's model chip, usage chip, Stop, tasks strip and message
queue lived on a second surface that had no reviews, pins, presence or
unread. They sit above the chat composer now, fed by the chat feed's turn
entries, and are absent for every other agent type because the hook is
handed a null agent id.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The composer's harness behavior

Enter queues behind a running turn, ArrowUp recalls the queued message and then walks the earlier prompts, Ctrl+C stops the turn, `/model` and `/usage` open their dialogs, the engine's own commands fill the slash menu, `@` completes paths under the working tree, and a file dropped anywhere on the pane attaches to the composer. All of it arrives as extra `ChatComposer` props from the same hook, so the composer itself is untouched and every prop is absent for an agent that is not a Dispatch Harness agent.

**Files:**

- Modify: `apps/web/src/components/app/chat/harness-chrome.tsx`
- Modify: `apps/web/src/components/app/chat/chat-pane.tsx` (the `ChatComposer` call: the spread plus `dropTargetRef` and `onDropZoneDragging`)
- Test: `apps/web/src/components/app/chat/chat-pane.test.tsx` (a new `describe("ChatPane harness composer")`, which carries the drop-overlay case for the overlay Task 2 rendered)

**Interfaces:**

- Consumes: `type SlashItem` from `@/components/app/chat/chat-composer`; `HarnessPath` from `@dispatch/shared`; `useHarnessCommands` from `@/components/app/harness/use-harness-commands`; `useHarnessPathPicker` from `@/components/app/harness/use-harness-paths`; `composerHint` and `harnessPromptHistory` from Task 1.
- Produces, from `apps/web/src/components/app/chat/harness-chrome.tsx`:
  - `type HarnessComposerProps = { slashItems?: SlashItem[]; onSlashCommand?: (name: string) => boolean; hint?: string; history?: string[]; recallQueued?: () => Promise<string | null>; atItems?: HarnessPath[]; onAtQuery?: (query: string | null) => void; onInterrupt?: () => void }`
  - `HarnessChrome` gains `composer: HarnessComposerProps`, empty for every agent type but dispatch.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/app/chat/chat-pane.test.tsx`, add the commands mock beside the other harness mocks (the engine publishes none under test; the `@` picker and the real command list are the E2E's job):

```tsx
vi.mock("@/components/app/harness/use-harness-commands", () => ({
  harnessCommandsQueryKey: (agentId: string | null) => [
    "harness-commands",
    agentId,
  ],
  useHarnessCommands: () => [],
}));
```

Add this import so the draft can be cleared between cases:

```tsx
import { chatDraftAtomFamily } from "@/lib/store";
```

Add to `beforeEach`, at the end. The draft atom is keyed by agent and outlives a render, so an unsent draft left by an earlier case would make ArrowUp a history walk instead of a recall:

```tsx
window.localStorage.clear();
chatDraftAtomFamily.remove("agt_1");
```

Append this describe to the end of the file:

```tsx
describe("ChatPane harness composer", () => {
  const runningTurn = () =>
    turnEntry({
      settled: false,
      trace: { startedAt: "2026-09-02T10:00:00.000Z", steps: [] },
      result: { text: "working", streaming: true },
    });

  const queuedChat = {
    id: "m2",
    source: "chat" as const,
    text: "queued one",
    chatMessageId: "m2",
    attachments: [],
    createdAt: "2026-09-04T10:00:01.000Z",
  };

  it("says what Enter does while a turn runs and something waits behind it", () => {
    H.entries = [runningTurn()];
    HARNESS.queued = [queuedChat];
    renderPane({ agent: dispatchAgent });
    expect(screen.getByTestId("chat-composer-hint").textContent).toBe(
      "Agent is working · Enter queues your message · ↑ edits the queued one · Ctrl+C stops"
    );
  });

  it("keeps the plain composer line when nothing runs and nothing waits", () => {
    H.entries = [turnEntry()];
    renderPane({ agent: dispatchAgent });
    expect(screen.queryByTestId("chat-composer-hint")).toBeNull();
    expect(screen.queryByTestId("harness-queued")).toBeNull();
  });

  it("gives no hint and no history to an agent that is not a dispatch agent", () => {
    H.entries = [runningTurn()];
    HARNESS.queued = [queuedChat];
    renderPane();
    expect(screen.queryByTestId("chat-composer-hint")).toBeNull();
  });

  it("pulls the queued message back on ArrowUp", async () => {
    HARNESS.queued = [queuedChat];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("queued one"));
    expect(HARNESS.remove).toHaveBeenCalledWith("m2");
  });

  it("refuses to recall a queued message that carries attachments", async () => {
    HARNESS.queued = [
      {
        ...queuedChat,
        id: "m3",
        text: "with a file",
        attachments: [
          { type: "file", mediaId: 1, fileName: "a.png", sizeBytes: 1 },
        ],
      },
    ];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("attachments")
    );
    expect(HARNESS.remove).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("walks back through the prompts the user typed before", async () => {
    H.entries = [
      turnEntry({
        id: "turn:1",
        prompt: { source: "chat", text: "earlier prompt", attachments: [] },
      }),
      turnEntry({ id: "turn:2" }),
    ];
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("read the readme"));
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("earlier prompt"));
  });

  it("stops the turn on Ctrl+C in the field while one runs", () => {
    H.entries = [runningTurn()];
    renderPane({ agent: dispatchAgent });
    fireEvent.keyDown(screen.getByTestId("chat-composer-input"), {
      key: "c",
      ctrlKey: true,
    });
    expect(HARNESS.interrupt).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl+C alone when no turn runs", () => {
    H.entries = [turnEntry()];
    renderPane({ agent: dispatchAgent });
    fireEvent.keyDown(screen.getByTestId("chat-composer-input"), {
      key: "c",
      ctrlKey: true,
    });
    expect(HARNESS.interrupt).not.toHaveBeenCalled();
  });

  it("opens the usage dialog from the /usage slash command", async () => {
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "/usage" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("harness-usage-dialog")).not.toBeNull();
    });
    expect(H.send).not.toHaveBeenCalled();
  });

  it("opens the model picker from the /model slash command", async () => {
    renderPane({ agent: dispatchAgent });
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "/model" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("harness-model-picker")).not.toBeNull();
    });
    expect(H.send).not.toHaveBeenCalled();
  });

  it("shows the drop overlay only for a dispatch agent, while files are dragged over the pane", () => {
    const plain = renderPane();
    const plainPane = screen.getByTestId("chat-pane");
    fireEvent.dragOver(plainPane, {
      dataTransfer: { types: ["Files"], files: [] },
    });
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
    plain.unmount();

    renderPane({ agent: dispatchAgent });
    const pane = screen.getByTestId("chat-pane");
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
    fireEvent.dragOver(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("chat-drop-overlay")).not.toBeNull();
    expect(pane.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.queryByTestId("chat-drop-overlay")).toBeNull();
  });
});
```

The last case belongs to this task rather than Task 2: Task 2 renders the overlay and owns `draggingFiles`, but nothing sets it until Step 4 hands the composer `dropTargetRef` and `onDropZoneDragging`, which are the props the composer's own drop-zone effect listens through. `renderPane` returns what `render` returns, so `plain.unmount()` works.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-pane.test.tsx -t "harness composer"`

Expected: FAIL. `says what Enter does ...` fails on `Unable to find an element by: [data-testid="chat-composer-hint"]`; the recall and Ctrl+C cases fail because the mocks are never called; the drop-overlay case fails on `Unable to find an element by: [data-testid="chat-drop-overlay"]`, since nothing reports the drag yet.

- [ ] **Step 3: Return the composer's props from the hook**

In `apps/web/src/components/app/chat/harness-chrome.tsx`, add to the imports:

```tsx
import type { RefObject } from "react";
import type { HarnessPath } from "@dispatch/shared";

import type { SlashItem } from "@/components/app/chat/chat-composer";
import { useHarnessCommands } from "@/components/app/harness/use-harness-commands";
import { useHarnessPathPicker } from "@/components/app/harness/use-harness-paths";
```

(`RefObject` is unused here; drop that line unless the file already needs it.)

Add the type and the empty value above `useHarnessChrome`:

```tsx
/**
 * Every field is absent for an agent that is not a Dispatch Harness agent,
 * so spreading this onto the composer is a no-op for the rest.
 */
export type HarnessComposerProps = {
  slashItems?: SlashItem[];
  onSlashCommand?: (name: string) => boolean;
  hint?: string;
  history?: string[];
  recallQueued?: () => Promise<string | null>;
  atItems?: HarnessPath[];
  onAtQuery?: (query: string | null) => void;
  onInterrupt?: () => void;
};

/** Frozen so a non-dispatch pane hands the composer the same object every render. */
const EMPTY_COMPOSER_PROPS: HarnessComposerProps = Object.freeze({});
```

Change the result type:

```tsx
export type HarnessChrome = {
  /** The chrome above the composer; null for every agent type but dispatch. */
  chrome: ReactNode;
  /** Spread into `ChatComposer`; empty for every agent type but dispatch. */
  composer: HarnessComposerProps;
};
```

Inside the hook, add these hooks after `const setConfig = useSetHarnessConfig(agentId);`:

```tsx
const commands = useHarnessCommands(agentId);
const pathPicker = useHarnessPathPicker(agentId);
```

Add after the `tasksOpen` line:

```tsx
const history = useMemo(() => harnessPromptHistory(entries), [entries]);
```

Add after `applyConfig`:

```tsx
const slashItems = useMemo<SlashItem[]>(
  () => [
    {
      name: "model",
      description: "Choose the model and reasoning effort",
      command: true,
    },
    {
      name: "usage",
      description: "Tokens and cost this month",
      command: true,
    },
    ...commands,
  ],
  [commands]
);
const onSlashCommand = useCallback((name: string) => {
  if (name === "model") {
    setPickerOpen(true);
    return true;
  }
  if (name === "usage") {
    setUsageOpen(true);
    return true;
  }
  return false;
}, []);
```

Add after `onStop`:

```tsx
// ArrowUp on an empty field takes the newest queued message back to
// edit. One with attachments stays queued: the chips cannot come back
// into the draft, so it keeps Send now and Remove instead.
const recallQueued = useCallback(async () => {
  const last = queued[queued.length - 1];
  if (!last) return null;
  onError(null);
  if (last.attachments.length > 0) {
    onError(
      "The queued message has attachments; use Send now or Remove on it."
    );
    return null;
  }
  try {
    await removeQueued(last.id);
  } catch (err) {
    onError(errorText(err, "That message already started."));
    throw err;
  }
  return last.text;
}, [onError, queued, removeQueued]);
```

Add before the `chrome` assignment:

```tsx
const composer = useMemo<HarnessComposerProps>(
  () =>
    agentId === null
      ? EMPTY_COMPOSER_PROPS
      : {
          slashItems,
          onSlashCommand,
          hint: composerHint(streaming, queued.length, isMobile),
          history,
          recallQueued,
          atItems: pathPicker.items,
          onAtQuery: pathPicker.onQuery,
          // Absent when nothing runs, so Ctrl+C keeps its meaning.
          ...(streaming ? { onInterrupt: onStop } : {}),
        },
  [
    agentId,
    history,
    isMobile,
    onSlashCommand,
    onStop,
    pathPicker.items,
    pathPicker.onQuery,
    queued.length,
    recallQueued,
    slashItems,
    streaming,
  ]
);
```

And return both:

```tsx
return { chrome, composer };
```

- [ ] **Step 4: Spread them onto the composer**

In `apps/web/src/components/app/chat/chat-pane.tsx`, the composer call is:

```tsx
<ChatComposer
  agentId={agentId}
  onSend={onSend}
  uploadFile={uploadFile}
  disabledReason={disabledReason}
  sending={send.isPending || answer.isPending}
  autoFocus={active && !isMobile}
  replyContext={replyContext}
/>
```

Replace it with:

```tsx
<ChatComposer
  agentId={agentId}
  onSend={onSend}
  uploadFile={uploadFile}
  disabledReason={disabledReason}
  sending={send.isPending || answer.isPending}
  autoFocus={active && !isMobile}
  replyContext={replyContext}
  // Pane-wide drops are parity with the pane this replaced; other
  // agent types keep taking them on the composer alone.
  dropTargetRef={harnessAgentId === null ? undefined : dropRef}
  onDropZoneDragging={harnessAgentId === null ? undefined : setDraggingFiles}
  {...harness.composer}
/>
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-pane.test.tsx`

Expected: PASS, whole file. `shows the drop overlay only for a dispatch agent` is the case the two drop props in Step 4 are what make work.

- [ ] **Step 6: Type check and lint the two files**

Run: `pnpm --filter @dispatch/web check && cd apps/web && pnpm exec eslint src/components/app/chat/harness-chrome.tsx src/components/app/chat/chat-pane.tsx`

Expected: both exit 0. An `react-hooks/exhaustive-deps` warning on `composer` means a dependency was dropped from the list above; add it rather than silencing the rule.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/app/chat/harness-chrome.tsx \
  apps/web/src/components/app/chat/chat-pane.tsx \
  apps/web/src/components/app/chat/chat-pane.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): give the chat composer the harness keys and menus

Enter queueing, ArrowUp recall, Ctrl+C, the engine's slash commands and
the "@" path picker were the harness pane's, so a dispatch agent lost all
of them the moment its pane became the chat pane. They arrive as extra
ChatComposer props from the chrome hook, absent for every other type.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: One pane, one toggle

`AgentPane` stops choosing between two feed layers: it mounts `ChatPane` for every agent type. With `harnessEnabled` gone, the unread badge on the Chat segment and the child-agent filter popover come back for a dispatch agent, which is most of what the fold was for.

Two rules stay and are worth naming, because a reader will look for them here:

- **Chat is on for a dispatch agent however the global flag is set.** That is `chatEnabled` at `agents-view.tsx:248-251` (`focusedAgent !== null && (chatSurfaceEnabled || focusedAgent.type === "dispatch") && agentSupportsChat(focusedAgent.type)`), under the comment at `:242-247`, and it is untouched. `terminalHostTab(chatEnabled)` therefore still yields `agent`, so the center tabs read Agent, Changes, Whiteboard for that agent even on an install with the chat surface off.
- **The Console segment stays for a dispatch agent** (spec Q1, decided: keep it). Its terminal is a plain shell in the agent's worktree, which is useful for `git status` and test runs, and hiding the segment would be the only work. Nothing in this task touches the segment; the test below pins that.

**Files:**

- Modify: `apps/web/src/components/app/agent-pane.tsx:5-6`, `:61-70`, `:77-90`, `:119-149`, `:160-161`, `:225-267`, `:280-302`, `:327-334`, `:356-385`
- Modify: `apps/web/src/components/app/agents-view.tsx:49` (the import), `:610-611` (the computation), `:640` (the pane prop), `:684` (the split header's prop)
- Modify: `apps/web/src/lib/center-tabs.ts:86-96`
- Test: `apps/web/src/components/app/agent-pane.test.tsx`

**Interfaces:**

- Produces: `AgentViewToggleProps` and `AgentPaneProps` lose `harnessEnabled?: boolean`. `agentSupportsHarness` no longer exists in `@/lib/center-tabs`.

- [ ] **Step 1: Rewrite the tests that assert the swap**

In `apps/web/src/components/app/agent-pane.test.tsx`:

Delete the whole `use-harness-turns` mock. Plan 4 deletes that module, and a `vi.mock` factory for a module that is gone fails the file at collection time:

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

Add the queue mock in its place. `ChatPane` calls `useHarnessQueued` for every agent (with a null id for most), and a dispatch fixture would otherwise reach the unmocked `api`:

```tsx
vi.mock("@/components/app/harness/use-harness-queue", () => ({
  harnessQueueQueryKey: (agentId: string | null) => ["harness-queue", agentId],
  useHarnessQueued: () => ({ queued: [], loading: false, error: null }),
  useHarnessQueue: () => ({
    sendNow: vi.fn(),
    remove: vi.fn(),
    busyId: null,
  }),
  useHarnessInterrupt: () => ({ interrupt: vi.fn(), interrupting: false }),
}));
vi.mock("@/components/app/harness/use-harness-usage", () => ({
  HARNESS_USAGE_QUERY_KEY: ["harness-usage"],
  useHarnessUsage: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
```

Add a dispatch fixture under `agentNamed`:

```tsx
function dispatchAgentNamed(id: string): Agent {
  return { ...agentNamed(id), type: "dispatch", model: "codex/default" };
}
```

Delete this case (the filter is Brad's again, for every type):

```tsx
it("hides the Chat filter for a harness agent, whose feed it cannot filter", () => {
  render(<AgentViewToggle view="chat" onViewChange={vi.fn()} harnessEnabled />);
  expect(screen.queryByTestId("chat-filters-trigger")).toBeNull();
});
```

Delete the whole `describe("AgentViewToggle with the Harness segment")` block, both cases.

Replace the whole `describe("AgentPane with the Harness view")` block, all three cases, with:

```tsx
describe("AgentPane for a dispatch agent", () => {
  it("hosts the chat pane like every other type, with no harness pane left", () => {
    renderPane({ agent: dispatchAgentNamed("agt_a"), view: "chat" });
    expect(isHidden(screen.getByTestId("agent-pane-chat"))).toBe(false);
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
    expect(screen.queryByTestId("harness-pane")).toBeNull();
    expect(isHidden(screen.getByTestId("agent-pane-console"))).toBe(true);
    expect(screen.getByTestId("chat-harness-chrome")).toBeTruthy();
  });

  it("keeps the Console segment and the chat filter, and shows unread under Console", () => {
    renderPane({
      agent: dispatchAgentNamed("agt_a"),
      view: "console",
      chatUnreadCount: 3,
    });
    expect(screen.getByTestId("agent-view-console")).toBeTruthy();
    expect(screen.getByTestId("agent-view-chat")).toBeTruthy();
    expect(screen.queryByTestId("agent-view-harness")).toBeNull();
    expect(screen.getByTestId("chat-filters-trigger")).toBeTruthy();
    expect(screen.getByTestId("agent-view-chat-unread").textContent).toBe("3");
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
    expect(isHidden(screen.getByTestId("agent-pane-console"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/agent-pane.test.tsx`

Expected: FAIL. `hosts the chat pane like every other type` finds `harness-pane` and no `chat-pane`; `keeps the Console segment ...` finds `agent-view-harness` and no `chat-filters-trigger`.

- [ ] **Step 3: Take `harnessEnabled` out of `agent-pane.tsx`**

Delete the import:

```tsx
import { HarnessPane } from "@/components/app/harness/harness-pane";
```

In `AgentViewToggleProps`, delete:

```tsx
  /** Adds the Harness segment (Dispatch Harness agents only). */
  harnessEnabled?: boolean;
```

In `AgentViewToggle`, delete `harnessEnabled = false,` from the destructuring and simplify the unread rule:

```tsx
const showUnread = view === "console" && chatUnreadCount > 0;
```

Replace the whole `{harnessEnabled ? ( ... ) : ( ... )}` conditional over the Chat segment with just the `agent-view-chat` branch:

```tsx
<ToggleGroupItem
  value="chat"
  aria-label="Chat"
  data-testid="agent-view-chat"
  className="relative z-10 h-5 rounded-full px-2.5 text-[11px] transition-colors duration-200 data-[state=on]:bg-transparent data-[state=on]:text-foreground data-[state=on]:shadow-none pointer-coarse:h-11 pointer-coarse:px-2.5"
>
  <MessageSquare className="h-2.5 w-2.5 shrink-0" />
  Chat
  {showUnread ? (
    <span
      data-testid="agent-view-chat-unread"
      aria-label={`${chatUnreadCount} unread chat messages`}
      className="ml-0.5 min-w-4 shrink-0 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-4 text-primary-foreground"
    >
      {formatBadgeCount(chatUnreadCount)}
    </span>
  ) : null}
</ToggleGroupItem>
```

Unwrap the filter popover: delete the comment `{/* The filter acts on the Chat feed, which a harness agent does not show. */}` and the `{harnessEnabled ? null : (` wrapper with its closing `)}`, leaving the `<Popover>` as a direct child.

In `AgentPaneProps`, delete:

```tsx
  /** Mount the Harness view and its toggle segment (Dispatch Harness only). */
  harnessEnabled?: boolean;
```

In `AgentPane`, delete `harnessEnabled = false,` from the destructuring and drop the comment above `feedShown`, whose second sentence was about the swap and whose first only restated the line:

```tsx
const feedShown = chatEnabled && view === "chat";
```

delete `harnessEnabled={harnessEnabled}` from the `AgentViewToggle` call, and replace the swap:

```tsx
{
  harnessEnabled ? (
    <HarnessPane
      key={agentId ?? "none"}
      agentId={agentId}
      agent={agent}
      active={active && feedShown}
      isMobile={isMobile}
      openLightbox={openLightbox}
    />
  ) : (
    <ChatPane
      key={agentId ?? "none"}
      agentId={agentId}
      agent={agent}
      terminalMode={terminalMode}
      active={active && feedShown}
      showChildAgents={showChildAgents}
      childAgentIds={childAgentIds}
      onShowChildAgentsChange={onShowChildAgentsChange}
      openLightbox={openLightbox}
      onOpenReview={onOpenReview}
      isMobile={isMobile}
    />
  );
}
```

with:

```tsx
<ChatPane
  key={agentId ?? "none"}
  agentId={agentId}
  agent={agent}
  terminalMode={terminalMode}
  active={active && feedShown}
  showChildAgents={showChildAgents}
  childAgentIds={childAgentIds}
  onShowChildAgentsChange={onShowChildAgentsChange}
  openLightbox={openLightbox}
  onOpenReview={onOpenReview}
  isMobile={isMobile}
/>
```

- [ ] **Step 4: Take it out of `agents-view.tsx` and `center-tabs.ts`**

In `apps/web/src/components/app/agents-view.tsx`, remove `agentSupportsHarness,` from the `@/lib/center-tabs` import list, then delete:

```tsx
const harnessEnabled = chatEnabled && agentSupportsHarness(focusedAgent?.type);
```

and the `harnessEnabled,` line from `agentPaneProps`, and `harnessEnabled={harnessEnabled}` from the `splitAgentHeaderAccessory`'s `AgentViewToggle`. Leave the `chatEnabled` computation and its comment exactly as they are.

In `apps/web/src/lib/center-tabs.ts`, delete the function and its one-line comment, which restores the doc comment above it to `agentSupportsChat`, its subject:

```ts
/** Only the Dispatch Harness streams turns the Harness view can render. */
export function agentSupportsHarness(
  agentType: string | null | undefined
): boolean {
  return agentType === "dispatch";
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/agent-pane.test.tsx src/components/app/agents-view.test.tsx src/lib/center-tabs.test.ts`

Expected: PASS. If `center-tabs.test.ts` does not exist, the command reports "No test files found" for that path only; run the first two and note it.

- [ ] **Step 6: Prove nothing still asks for the removed props**

Run: `git grep -n "harnessEnabled\|agentSupportsHarness" -- apps e2e`

Expected: no output.

Run: `pnpm --filter @dispatch/web check`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/app/agent-pane.tsx \
  apps/web/src/components/app/agent-pane.test.tsx \
  apps/web/src/components/app/agents-view.tsx \
  apps/web/src/lib/center-tabs.ts
git commit -m "$(cat <<'EOF'
fix(web): give a dispatch agent the same pane as every other type

One boolean swapped a dispatch agent's whole feed layer for a second
surface, so it had no reviews, pins, presence, day dividers, copy action,
unread badge or child-agent filter. The pane is ChatPane for every type
now; the Console segment and the rule that forces Chat on for a dispatch
agent are unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Delete the second surface

`HarnessPane` has no caller. `TurnStream` had exactly one consumer, `HarnessPane`, and its nested-rail cousin is `StepDetail`, which does not use it. `QuestionCard` had one consumer, `TurnStream`; Brad's card in `chat-entries.tsx` renders questions now, and its testids are `chat-question-options` and `chat-question-option`.

`harness/question-card.test.tsx` folds into the existing question cases in `chat/chat-feed.test.tsx`, which already has an equivalent for each of its four:

| `question-card.test.tsx` case                                | Already covered in `chat-feed.test.tsx` by                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| gives every option a real tap target on a coarse pointer     | `renders an unanswered question with clickable Markdown options` (asserts `max-sm:min-h-11` and `[@media(pointer:coarse)]:min-h-11`) |
| renders option labels as inline markdown                     | the same case (`Alpha uses a`, its `strong` and its `code`)                                                                          |
| disables every option once answered and marks the chosen one | `marks the chosen option and disables the rest once answered`                                                                        |
| offers a typed reply only while one can be sent              | `renders an unanswered question ...` for the hint, plus `locks options and hides the freeform hint while answers are unavailable`    |

What that file has no equivalent for is the case the harness card existed to serve: a question the agent asked in the middle of a turn. That is the one case this task adds.

**Files:**

- Delete: `apps/web/src/components/app/harness/harness-pane.tsx`, `apps/web/src/components/app/harness/harness-pane.test.tsx`, `apps/web/src/components/app/harness/turn-stream.tsx`, `apps/web/src/components/app/harness/question-card.tsx`, `apps/web/src/components/app/harness/question-card.test.tsx`
- Test: `apps/web/src/components/app/chat/chat-feed.test.tsx`

**Interfaces:**

- Consumes: the `chat-turn` testid and the `turn` entry case from plan 2, Task 9.
- Produces: nothing new. `composerHint` no longer has a second home; `@/components/app/chat/harness-chrome` is where it lives (Task 1).

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/app/chat/chat-feed.test.tsx`, make sure the shared type import includes `ChatTurnEntry` (plan 2, Task 9 added it for its own describe):

```tsx
import type {
  ChatAttachment,
  ChatFeedEntry,
  ChatMessage,
  ChatStatusEntry,
  ChatTurnEntry,
} from "@dispatch/shared";
```

Insert this case in `describe("ChatFeed")`, directly after `it("disables options while an answer is in flight", ...)`:

```tsx
it("renders a question asked during a turn once, as its own card beside the turn", () => {
  // The harness view drew its own card inside the turn, so a question was
  // answered in one place and read in another. It is a chat row in time
  // order now, and the turn only references it.
  const turn: ChatTurnEntry = {
    type: "turn",
    id: "turn:12",
    agentId: AGENT_ID,
    at: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:09.000Z",
    prompt: { source: "chat", text: "pick one", attachments: [] },
    trace: {
      startedAt: "2026-09-04T10:00:00.000Z",
      endedAt: "2026-09-04T10:00:09.000Z",
      finalResult: "ok",
      steps: [],
    },
    result: { text: "Waiting on you.", streaming: false },
    settled: true,
    interrupted: false,
    questions: [{ messageId: "q1", answered: false }],
  };
  const { onAnswer } = renderFeed([
    turn,
    chat(
      message({
        id: "q1",
        kind: "question",
        text: "Fix the preview alone, or bundle it?",
        question: {
          options: [
            { label: "Preview only" },
            { label: "**Bundle**", value: "bundle" },
          ],
          allowFreeform: true,
        },
        createdAt: "2026-09-04T10:00:05.000Z",
        updatedAt: "2026-09-04T10:00:05.000Z",
      })
    ),
  ]);

  const cards = screen.getAllByTestId("chat-question-options");
  expect(cards).toHaveLength(1);
  expect(screen.queryByTestId("harness-question")).toBeNull();
  const turnRow = screen.getByTestId("chat-turn");
  expect(
    turnRow.compareDocumentPosition(cards[0]!) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(turnRow.contains(cards[0]!)).toBe(false);

  const options = screen.getAllByTestId("chat-question-option");
  expect(options).toHaveLength(2);
  expect(options[1]!.textContent).toBe("Bundle");
  expect(options[1]!.querySelector("strong")).not.toBeNull();
  fireEvent.click(options[1]!);
  expect(onAnswer).toHaveBeenCalledWith("q1", {
    label: "**Bundle**",
    value: "bundle",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/chat-feed.test.tsx -t "asked during a turn"`

Expected: FAIL on `expect(screen.queryByTestId("harness-question")).toBeNull()` only if the harness card leaked into the feed, which it does not; the likely first failure is the `chat-turn` lookup if plan 2's turn case is not in place. With plan 2 complete, this case passes on the first run: it is a regression guard for the deletion below rather than a red-first test, and that is what makes it worth having here.

- [ ] **Step 3: Delete the five files**

```bash
git rm apps/web/src/components/app/harness/harness-pane.tsx \
  apps/web/src/components/app/harness/harness-pane.test.tsx \
  apps/web/src/components/app/harness/turn-stream.tsx \
  apps/web/src/components/app/harness/question-card.tsx \
  apps/web/src/components/app/harness/question-card.test.tsx
```

- [ ] **Step 4: Prove nothing imported them**

Run each; every one must print nothing:

```bash
git grep -n "harness-pane\|HarnessPane" -- apps e2e
git grep -n "turn-stream\|TurnStream" -- apps
git grep -n "question-card\|QuestionCard" -- apps
git grep -n "harness-question" -- apps e2e
```

Expected: no output from any of them. A hit in `e2e/harness-agent.spec.ts` on `harness-pane` means Task 6 has not run yet; do Task 6 before this step if the tasks are being done out of order.

Then check what the deletions orphaned:

```bash
git grep -n "harnessTurnsQueryKey\|use-harness-turns" -- apps
```

Expected: exactly four hits, all of which plan 4 owns: the declaration and the query in `apps/web/src/components/app/harness/use-harness-turns.ts`, the import in `apps/web/src/hooks/use-sse.ts:23` with its use at `:159`, and `apps/web/src/components/app/harness/use-harness-turns.test.tsx:8`. Nothing under `apps/web/src/components/app/chat/` may appear. Leave all four alone.

- [ ] **Step 5: Run the two merged suites and the type check**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat src/components/app/harness src/components/app/agent-pane.test.tsx`

Expected: PASS. The harness directory reports five fewer files than before this plan (`harness-pane.test.tsx` and `question-card.test.tsx` gone from it, and plan 2 moved seven others out).

Run: `pnpm --filter @dispatch/web check`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/components/app/harness apps/web/src/components/app/chat/chat-feed.test.tsx
git commit -m "$(cat <<'EOF'
refactor(web): delete the harness pane and its question card

Nothing mounts them: a dispatch agent's pane is ChatPane, its turns are
feed entries and its questions are chat rows with Brad's card, which is
where they can be answered and read in one place. The turn stream had one
consumer and goes with the pane.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The live harness spec reads the chat pane

The four tests in `e2e/harness-agent.spec.ts` keep the fake ACP agent (`e2e/fixtures/fake-acp-agent.mjs`, unchanged) and every behavior they assert. What changes is where they look: `chat-pane` instead of `harness-pane`, a `chat-turn` entry instead of a prompt line and a live activity block, and the queue above the composer instead of under the stream.

Their setup already calls `setDispatchHarnessViaAPI(request, true)` (plan 1, Task 11). Do not touch it.

Testid map for this task:

| Was                                                                                                                                                                                         | Is now                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `harness-pane`                                                                                                                                                                              | `chat-pane`                                                                       |
| `harness-prompt` (a typed prompt)                                                                                                                                                           | `chat-message` inside `chat-turn`; `harness-prompt` is only a Dispatch notice now |
| one turn                                                                                                                                                                                    | one `chat-turn`, with `data-turn-id` and `data-settled`                           |
| `harness-live-activity`                                                                                                                                                                     | `[data-testid="chat-turn"]:not([data-settled])`                                   |
| `harness-result`, `harness-interrupted`, `harness-tasks`, `harness-activity-summary`, `harness-step`, `harness-nested-steps`, `harness-model-chip`, `harness-usage-chip`, `harness-queued*` | unchanged                                                                         |

The second row is fixed contract, not a guess: plan 2 is committed at `582fe672`, and its `TurnEntryView` renders `PromptLine` only when `parseDispatchNotice` matches, `AgentMessageView` for a prompt another agent sent, and `ChatMessageView` otherwise. A prompt the user typed is therefore a `chat-message` inside `chat-turn`, and `harness-prompt` survives only for a Dispatch notice.

The running-turn locator is `:not([data-settled])` and not `[data-settled="false"]`, for the same reason: plan 2 writes `data-settled={entry.settled ? "true" : undefined}`, so a running turn carries no attribute at all and `[data-settled="false"]` would match nothing and hang the wait.

One transcription note: the `test(...)` title lines below are quoted at their real indentation, but the statement blocks inside the test bodies are quoted flat, without the six spaces they sit under in the engine-matrix test (it is nested in a `for` loop) or the four in the other three. Keep the file's existing indentation when applying each edit.

**Files:**

- Modify: `e2e/harness-agent.spec.ts:98` (the engine-matrix test's title), `:119-186`, `:204-256`, `:273-332`, `:349-392`

**Interfaces:**

- Consumes: the `chat-turn`, `chat-turn-result` and `chat-message` testids from plan 2, Tasks 8 and 9; `chat-harness-chrome` from Task 2; `setDispatchHarnessViaAPI` from plan 1.

- [ ] **Step 1: Retarget the engine matrix test, starting with its title**

One of the four titles still names a view that no longer exists. At `:98`, replace:

```ts
    test(`${engine.model}: opens on the Harness view, runs a turn, shows what the engine publishes`, async ({
```

with:

```ts
    test(`${engine.model}: opens on the Agent pane's Chat, runs a turn, shows what the engine publishes`, async ({
```

The other three are already accurate and stay exactly as they are: "offers paths under the working tree from an @ in the composer", "shows messages queued behind a running turn, with Send now and Remove", and "shows a running step's command live, then folds it when it settles". The `test.describe("harness agent")` name also stays: the agent is still a Dispatch Harness agent, it is only its pane that changed.

Then, in the same test, replace:

```ts
const harness = page.getByTestId("harness-pane");
await expect(harness).toBeVisible();

// The kickoff ran as the first turn; the persona prefix (for engines
// that take it that way) is not shown, the launch post is.
await expect(harness.getByTestId("harness-prompt").first()).toContainText(
  "kickoff: begin",
  { timeout: 30_000 }
);
await expect(harness.getByTestId("harness-result").first()).toContainText(
  "You said:",
  { timeout: 30_000 }
);
```

with:

```ts
const pane = page.getByTestId("chat-pane");
await expect(pane).toBeVisible();

// The kickoff ran as the first turn; the persona prefix (for engines
// that take it that way) is not shown, the launch post is. The prompt
// is a user post inside the turn entry now, not a prompt line.
const firstTurn = pane.getByTestId("chat-turn").first();
await expect(firstTurn.getByTestId("chat-message").first()).toContainText(
  "kickoff: begin",
  { timeout: 30_000 }
);
await expect(firstTurn.getByTestId("harness-result").first()).toContainText(
  "You said:",
  { timeout: 30_000 }
);
```

Then replace every remaining `harness.` in that test body with `pane.`, which covers `harness-tasks` (both branches), `harness-activity-summary`, `harness-step`, `harness-nested-steps`, `harness-model-chip`, `harness-usage-chip` and `chat-composer-input`. The `page.getByTestId("harness-usage-engine-...")` line is a page-level lookup on a portaled dialog and stays as it is.

- [ ] **Step 2: Retarget the "@" path test**

Replace:

```ts
const harness = page.getByTestId("harness-pane");
await expect(harness).toBeVisible();
const input = harness.getByTestId("chat-composer-input");
```

with:

```ts
const pane = page.getByTestId("chat-pane");
await expect(pane).toBeVisible();
const input = pane.getByTestId("chat-composer-input");
```

and replace the two remaining `harness.getByTestId(...)` lookups (`chat-composer-at-item`, `chat-composer-token`) with `pane.getByTestId(...)`.

- [ ] **Step 3: Retarget the queue test**

Replace:

```ts
const harness = page.getByTestId("harness-pane");
await expect(harness).toBeVisible();
const input = harness.getByTestId("chat-composer-input");
await expect(input).toBeEnabled({ timeout: 30_000 });

// A long turn: the fake holds it until cancelled.
await input.fill("sleep:60000 first");
await input.press("Enter");
await expect(harness.getByTestId("harness-live-activity")).toBeVisible({
  timeout: 30_000,
});
await expect(harness.getByTestId("chat-composer-hint")).toContainText(
  "Enter queues your message"
);

// Two more land in the queue, in order, under the live turn.
const queued = harness.getByTestId("harness-queued");
```

with:

```ts
const pane = page.getByTestId("chat-pane");
await expect(pane).toBeVisible();
const input = pane.getByTestId("chat-composer-input");
await expect(input).toBeEnabled({ timeout: 30_000 });

// A long turn: the fake holds it until cancelled. An unsettled turn
// entry is what "a turn is running" looks like in the feed.
await input.fill("sleep:60000 first");
await input.press("Enter");
const runningTurn = pane.locator(
  '[data-testid="chat-turn"]:not([data-settled])'
);
await expect(runningTurn).toBeVisible({ timeout: 30_000 });
await expect(pane.getByTestId("chat-composer-hint")).toContainText(
  "Enter queues your message"
);

// Two more land in the queue, in order, above the composer.
const queued = pane.getByTestId("harness-queued");
```

Replace the placement assertions:

```ts
await expect(harness.getByTestId("chat-composer-hint")).toContainText(
  "↑ edits the queued one"
);
await expect(queued.nth(0)).toContainText("second");
await expect(queued.nth(0)).toContainText("Queued");
await expect(queued.nth(1)).toContainText("third");
```

with:

```ts
await expect(pane.getByTestId("chat-composer-hint")).toContainText(
  "↑ edits the queued one"
);
await expect(queued.nth(0)).toContainText("second");
await expect(queued.nth(0)).toContainText("Queued");
await expect(queued.nth(1)).toContainText("third");
// The queue is chrome above the composer, not a row in the feed: it
// holds the controls for what is waiting and must not scroll away.
await expect(
  pane.getByTestId("chat-harness-chrome").getByTestId("harness-queued")
).toHaveCount(2);
await expect(
  pane.getByTestId("chat-scroll").getByTestId("harness-queued")
).toHaveCount(0);
```

Replace the tail of the test:

```ts
// Send now interrupts the sleeping turn and runs "third" next.
await queued.first().getByTestId("harness-queued-send-now").click();
await expect(queued).toHaveCount(0, { timeout: 30_000 });
await expect(harness.getByTestId("harness-prompt").last()).toContainText(
  "third",
  { timeout: 30_000 }
);
const result = harness.getByTestId("harness-result").last();
await expect(result).toContainText("You said:", { timeout: 30_000 });
await expect(result).toContainText("third");
// The turn Send now cut short says so, above the turn that replaced it
// (it never got a step, so the line is all that marks it).
await expect(harness.getByTestId("harness-interrupted")).toHaveCount(1);
// "second" never ran: no prompt line carries it.
await expect(harness.getByTestId("harness-prompt")).toHaveCount(2);
await expect(harness.getByTestId("harness-prompt").first()).toContainText(
  "first"
);
```

with:

```ts
// Send now interrupts the sleeping turn and runs "third" next.
await queued.first().getByTestId("harness-queued-send-now").click();
await expect(queued).toHaveCount(0, { timeout: 30_000 });
const turns = pane.getByTestId("chat-turn");
await expect(turns.last().getByTestId("chat-message")).toContainText("third", {
  timeout: 30_000,
});
const result = turns.last().getByTestId("harness-result");
await expect(result).toContainText("You said:", { timeout: 30_000 });
await expect(result).toContainText("third");
// The turn Send now cut short says so, above the turn that replaced it
// (it never got a step, so the line is all that marks it).
await expect(pane.getByTestId("harness-interrupted")).toHaveCount(1);
// "second" never ran: it opened no turn of its own.
await expect(turns).toHaveCount(2);
await expect(turns.first().getByTestId("chat-message")).toContainText("first");
```

- [ ] **Step 4: Retarget the live-step test**

Replace:

```ts
const harness = page.getByTestId("harness-pane");
const input = harness.getByTestId("chat-composer-input");
await expect(input).toBeEnabled({ timeout: 30_000 });

// The fake holds a shell step open for a while before its output lands.
await input.fill("run:8000 hold the step");
await input.press("Enter");
const live = harness.getByTestId("harness-live-activity");
await expect(live).toBeVisible({ timeout: 30_000 });
```

with:

```ts
const pane = page.getByTestId("chat-pane");
const input = pane.getByTestId("chat-composer-input");
await expect(input).toBeEnabled({ timeout: 30_000 });

// The fake holds a shell step open for a while before its output lands.
await input.fill("run:8000 hold the step");
await input.press("Enter");
const live = pane.locator('[data-testid="chat-turn"]:not([data-settled])');
await expect(live).toBeVisible({ timeout: 30_000 });
```

and replace the three remaining `harness.getByTestId(...)` lookups (`harness-result`, `harness-activity-summary`, `harness-step`) with `pane.getByTestId(...)`.

- [ ] **Step 5: Prove no selector was missed**

Run: `git grep -n "harness-pane\|harness-live-activity\|harness-prompt\|const harness =\|Harness view" -- e2e`

Expected: no output. The last pattern is the title: a hit means Step 1's rename was skipped.

- [ ] **Step 6: Run the live spec**

Run: `pnpm run test:e2e:live`

Expected: PASS, 7 tests from `e2e/harness-agent.spec.ts` (the engine matrix is four) plus `e2e/terminal-live.spec.ts`. This run works on this host: `tmux` is on PATH and the four engine CLIs are installed and logged in, and this spec passed 7 of 7 live earlier on this branch. A failure is a real failure, so report it rather than recording a green.

- [ ] **Step 7: Commit**

```bash
git add e2e/harness-agent.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): point the harness spec at the chat pane

The pane a dispatch agent opens is the chat pane, its turns are feed
entries with a settled flag and its queue sits above the composer, so
every harness-pane selector in the spec matched nothing. Same four tests,
same fake ACP agent, new targets.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: A dispatch agent's feed in the default E2E suite

`e2e/chat-surface.spec.ts` gains the case that is the whole point of the fold: a review card, a pin row and the presence strip rendering in the same feed as a turn. It runs in `pnpm run test:e2e`, whose runtime is inert (`DISPATCH_AGENT_RUNTIME=inert`, no tmux and no ACP engine), so the turn is seeded straight into `agent_stream_events` by a new helper. The rest is written the way an agent would write it: `dispatch_event` and `dispatch_pin` through the per-agent MCP endpoint, and the review through the existing DB fixture.

Helpers used: the new `seedStreamTurnViaDB` (below), `seedReviewAgentFixtureViaDB` (`e2e/helpers.ts:352`, which inserts an open review on the agent it is given), `createAgentViaAPI`, `clickAgentRow`, `loadApp`, `cleanupE2EAgents`, and `setDispatchHarnessViaAPI` (plan 1) so the create route offers the type at all. The spec's own `callMcpTool` sends the status event and the pin write.

**Files:**

- Modify: `e2e/helpers.ts` (add `seedStreamTurnViaDB`)
- Modify: `e2e/chat-surface.spec.ts` (two new tests, and the import list)

**Interfaces:**

- Produces, from `e2e/helpers.ts`:
  - `seedStreamTurnViaDB(turn: { agentId: string; prompt: string; result: string; stepTitle?: string; plan?: { content: string; status: string; priority: string }[]; startedSecondsAgo?: number }): Promise<{ promptMessageId: string }>`

- [ ] **Step 1: Write the failing tests**

In `e2e/chat-surface.spec.ts`, extend the import list to:

```ts
import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  seedAgentMessageViaDB,
  seedChatMessageViaDB,
  seedReviewAgentFixtureViaDB,
  seedStreamTurnViaDB,
  setAgentPinsViaDB,
  setDispatchHarnessViaAPI,
} from "./helpers";
```

Append these two tests inside `test.describe("Chat surface")`, after the last one:

```ts
test("dispatch agent: a turn, a review, a pin write and presence in one feed", async ({
  page,
  request,
}) => {
  await setChatSurface(request, true);
  await setDispatchHarnessViaAPI(request, true);
  const agent = await createAgentViaAPI(request, {
    name: `e2e-dispatch-feed-${Date.now()}`,
    type: "dispatch",
    cwd: process.cwd(),
    useWorktree: false,
  });

  // No ACP engine runs in the inert suite, so the turn is seeded. It is
  // anchored ten seconds back, which is what puts the rows written below
  // after it: a row created while a turn ran keeps its own timestamp and
  // lands under the turn rather than inside it.
  await seedStreamTurnViaDB({
    agentId: agent.id,
    prompt: "read the readme and plan the work",
    result: "It documents the CLI. Plan is up.",
    stepTitle: "Read README.md",
    plan: [
      { content: "Read the README", status: "completed", priority: "high" },
      { content: "Echo the prompt", status: "in_progress", priority: "medium" },
      { content: "Wrap up", status: "pending", priority: "low" },
    ],
  });
  const fixture = await seedReviewAgentFixtureViaDB(agent.id);
  await callMcpTool(request, agent.id, "dispatch_event", {
    type: "working",
    message: "Wiring the feed",
  });
  await callMcpTool(request, agent.id, "dispatch_pin", {
    label: "Dev server",
    value: "http://127.0.0.1:5173",
    type: "url",
  });

  await loadApp(page);
  await clickAgentRow(page, agent.id);
  await page.getByTestId("center-tab-agent").click();

  const pane = page.getByTestId("chat-pane");
  await expect(pane).toBeVisible();
  await expect(page.getByTestId("harness-pane")).toHaveCount(0);

  const turn = pane.getByTestId("chat-turn");
  await expect(turn).toHaveCount(1, { timeout: 30_000 });
  await expect(turn.getByTestId("chat-message").first()).toContainText(
    "read the readme and plan the work"
  );
  await expect(turn.getByTestId("harness-result")).toContainText(
    "It documents the CLI."
  );
  await expect(turn).toHaveAttribute("data-settled", "true");

  // The fixture seeds two reviews, so the open one is addressed by id.
  // The card is the notice rather than a copy of the summary, so its
  // block is what it must carry.
  const review = pane.locator(
    `[data-testid="chat-review"][data-review-id="${fixture.openReviewId}"]`
  );
  await expect(review).toBeVisible();
  await expect(review.getByTestId("chat-review-block")).toBeVisible();
  const pin = pane.getByTestId("chat-pin-entry");
  await expect(pin).toBeVisible();
  await expect(pin).toContainText("Dev server");

  // Rows written while the turn ran keep their own timestamps, so they
  // land below the turn entry rather than inside it.
  const order = await pane.evaluate((root) =>
    [
      ...root.querySelectorAll(
        '[data-testid="chat-turn"],[data-testid="chat-pin-entry"]'
      ),
    ].map((node) => node.getAttribute("data-testid"))
  );
  expect(order).toEqual(["chat-turn", "chat-pin-entry"]);

  await expect(
    pane.getByTestId("chat-status").filter({ hasText: "Wiring the feed" })
  ).toBeVisible();
  await expect(pane.getByTestId("chat-presence")).toContainText(
    "Wiring the feed"
  );

  // The strip is the plan the seeded turn published, which is the chrome
  // reading the same entries the feed renders.
  await expect(pane.getByTestId("harness-tasks")).toContainText("1 of 3 done");
  await expect(pane.getByTestId("harness-model-chip")).toBeVisible();
  await expect(pane.getByTestId("harness-usage-chip")).toBeVisible();

  await page.screenshot({
    path: test.info().outputPath("dispatch-one-feed.png"),
    fullPage: true,
  });
});

test("dispatch agent: touch-sized pill segments and chip row on a phone", async ({
  browser,
  request,
}) => {
  await setChatSurface(request, true);
  await setDispatchHarnessViaAPI(request, true);
  const agent = await createAgentViaAPI(request, {
    name: `e2e-dispatch-touch-${Date.now()}`,
    type: "dispatch",
    cwd: process.cwd(),
    useWorktree: false,
  });

  const protocol = process.env.TLS_CERT ? "https" : "http";
  const baseURL = `${protocol}://127.0.0.1:${process.env.E2E_PORT ?? "8788"}`;
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const touchPage = await context.newPage();
  try {
    await touchPage.goto(`/agents/${agent.id}`, {
      waitUntil: "domcontentloaded",
    });
    await touchPage
      .getByTestId("agent-view-toggle")
      .waitFor({ state: "visible" });
    expect(
      await touchPage.evaluate(() => matchMedia("(pointer: coarse)").matches)
    ).toBe(true);

    // A Chat segment rather than a harness one: the pill is Brad's for
    // this type now, filter included.
    for (const id of [
      "agent-view-chat",
      "agent-view-console",
      "chat-filters-trigger",
      "harness-model-chip",
      "harness-usage-chip",
    ]) {
      await expect
        .poll(() =>
          touchPage
            .getByTestId(id)
            .evaluate((node) => node.getBoundingClientRect().height)
        )
        .toBeGreaterThanOrEqual(44);
    }
    await expect(touchPage.getByTestId("agent-view-harness")).toHaveCount(0);
  } finally {
    await touchPage.close();
    await context.close();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/e2e-isolated.sh e2e/chat-surface.spec.ts`

Expected: FAIL on both new tests with `TypeError: seedStreamTurnViaDB is not a function` (the module has no such export yet).

- [ ] **Step 3: Write the helper**

Append to `e2e/helpers.ts`:

```ts
/**
 * Seed one settled harness turn straight into `agent_stream_events`, plus
 * the `agent_chat_messages` row it names as its prompt.
 *
 * The default E2E runtime is inert: no tmux pane, no ACP engine, so nothing
 * ever writes a stream row and this has to write what the recorder would.
 * Rows ascend by `seq` from whatever the agent already has, so calling it
 * twice is safe.
 *
 * `startedSecondsAgo` anchors the turn in the past, which is how a caller
 * gets rows it writes afterward (a status event, a pin write, a review) to
 * land under the turn in the feed rather than racing it.
 */
export async function seedStreamTurnViaDB(turn: {
  agentId: string;
  /** The typed prompt; seeded as the chat row the turn claims. */
  prompt: string;
  /** The assistant's reply, which becomes the turn's result. */
  result: string;
  /** The tool step's title, shown on the activity rail. */
  stepTitle?: string;
  /** The task list the engine published during the turn, if any. */
  plan?: { content: string; status: string; priority: string }[];
  startedSecondsAgo?: number;
}): Promise<{ promptMessageId: string }> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed harness turns.");
  }
  const promptMessageId = randomUUID();
  const ago = turn.startedSecondsAgo ?? 10;
  const endedAt = new Date(Date.now() - (ago - 1) * 1000).toISOString();
  const rows: { kind: string; key: string | null; payload: unknown }[] = [
    {
      kind: "turn",
      key: null,
      payload: {
        state: "settled",
        prompt: { source: "chat", chatMessageId: promptMessageId },
        stopReason: "end_turn",
        endedAt,
      },
    },
    {
      kind: "tool_call",
      key: `call_${promptMessageId}`,
      payload: {
        toolKind: "read",
        title: turn.stepTitle ?? "Read README.md",
        status: "completed",
        locations: [],
        diff: null,
        terminalOutput: null,
      },
    },
    ...(turn.plan
      ? [{ kind: "plan", key: null, payload: { entries: turn.plan } }]
      : []),
    {
      kind: "assistant",
      key: null,
      payload: { text: turn.result, streaming: false },
    },
  ];

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_chat_messages
           (id, agent_id, author_kind, kind, text, attachments, delivered)
         VALUES ($1, $2, 'user', 'reply', $3, '[]'::jsonb, true)`,
        [promptMessageId, turn.agentId, turn.prompt]
      );
      for (const [index, row] of rows.entries()) {
        await client.query(
          `INSERT INTO agent_stream_events
             (agent_id, seq, kind, key, payload, created_at, updated_at)
           SELECT $1,
                  COALESCE(MAX(seq), 0) + 1 + $2,
                  $3, $4, $5::jsonb,
                  NOW() - ($6 * INTERVAL '1 second')
                    + ($2 * INTERVAL '100 milliseconds'),
                  NOW() - ($6 * INTERVAL '1 second')
                    + ($2 * INTERVAL '100 milliseconds')
             FROM agent_stream_events WHERE agent_id = $1`,
          [
            turn.agentId,
            index,
            row.kind,
            row.key,
            JSON.stringify(row.payload),
            ago,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return { promptMessageId };
}
```

- [ ] **Step 4: Run the spec**

Run: `bash scripts/e2e-isolated.sh e2e/chat-surface.spec.ts`

Expected: PASS, every test in the file including the two new ones. Two failures are worth knowing by name:

- `expect(turn).toHaveCount(1)` timing out means the seeded rows did not compose into a `turn` entry: check `payload.prompt.chatMessageId` is the exact UUID of the chat row (`parsePromptSource` needs the strict UUID shape) and that `state` is `"settled"`.
- The `chat-message` lookup inside the turn finding nothing means the prompt chat row was filtered out but not adopted by the turn: that is plan 2's `NOT EXISTS` dedup and the `chatMessageId` again.

- [ ] **Step 5: Commit**

```bash
git add e2e/helpers.ts e2e/chat-surface.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): cover a dispatch agent's one feed in the default suite

A dispatch agent had no reviews, pins, presence, unread or day dividers
because it never reached the chat feed. This seeds a turn into the stream
table (the inert suite starts no engine), then a review, a pin write and a
status event, and asserts all four render in one feed with the tasks strip
above the composer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The stage gate

Stage 2 of the spec is shippable when the whole gate passes. This task adds no code: it runs every gate command, and it records the mobile checklist, which rounds 3 and 5 of `docs/chat-surface-plan.md` already deliver and which this stage only had to keep.

**Mobile, verified rather than added:**

| Claim                                            | Where it comes from, after this plan                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The terminal toolbar shows only under Console    | `agents-view.tsx` passes `MobileTerminalToolbar` as `consoleFooter` only while `isMobile && chatEnabled`, and `agent-pane.tsx` renders `consoleFooter` inside the Console layer. With the surface off it is a grid row of its own (`agents-view.tsx:876`). A dispatch agent has `chatEnabled` forced true, so it always takes the first path. Unchanged by this plan. |
| The pill's segments are 44 px on coarse pointers | `pointer-coarse:h-11` on the `ToggleGroup` and each `ToggleGroupItem` in `agent-pane.tsx`. Task 4 deleted the harness segment, so a dispatch agent now uses the same segments as every other type, which is what Task 7's touch test pins.                                                                                                                            |
| The chip row keeps its `pointer-coarse:min-h-11` | `CHIP_CLASS` moved into `chat/harness-chrome.tsx` with the class intact, and Stop carries its own copy. Task 2's `keeps every chip a 44px target on a coarse pointer` and Task 7's touch test both assert it.                                                                                                                                                         |

**Files:** none.

- [ ] **Step 1: Type check the whole workspace**

Run: `pnpm run check`

Expected: exit 0. If the final `tsc -p tsconfig.scripts.json` step fails for want of root `@types/node`, that is the pre-existing gap named in the Global Constraints: record it, and take `pnpm --filter @dispatch/shared check && pnpm --filter @dispatch/server check && pnpm run check:web` as the gate instead. Every one of those must pass.

- [ ] **Step 2: Build the web app**

Run: `pnpm run finalize:web`

Expected: exit 0, with a Vite build summary. A build that fails on an unresolved import from `@/components/app/harness/harness-pane`, `.../turn-stream` or `.../question-card` means Task 5 deleted a file something still reaches; grep and fix the importer rather than restoring the file.

- [ ] **Step 3: Run the merged web suites**

Run:

```bash
cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run \
  src/components/app/chat src/components/app/harness \
  src/components/app/agent-pane.test.tsx src/lib
```

Expected: PASS, no skipped files. `chat-pane.test.tsx` and `chat-feed.test.tsx` are the two that carry the folded cases.

- [ ] **Step 4: Run the whole web unit suite**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`

Expected: PASS. This is the one that catches a component elsewhere that rendered `AgentViewToggle` with `harnessEnabled` or asserted `agent-view-harness`.

- [ ] **Step 5: Run the default E2E suite**

Run: `pnpm run test:e2e`

Expected: PASS, including the two new tests in `e2e/chat-surface.spec.ts`. `e2e/harness-agent.spec.ts` skips itself here (`test.skip(!live, ...)`), which is expected and not a failure.

- [ ] **Step 6: Run the live harness spec**

Run: `pnpm run test:e2e:live`

Expected: PASS, `e2e/terminal-live.spec.ts` plus the seven tests of `e2e/harness-agent.spec.ts`. This host runs it: `tmux` is present and the engine binaries are installed and logged in. It is the only run that exercises a real ACP turn against the retargeted selectors, so a failure here is reported, never recorded as a green.

- [ ] **Step 7: Confirm the boundary plan 4 inherits**

Run: `git grep -n "harnessTurnsQueryKey\|use-harness-turns\|HarnessTurn\b\|harness/turns" -- apps e2e packages`

Expected, and nothing else:

- `apps/web/src/components/app/harness/use-harness-turns.ts` (the declaration, the query, the `HarnessTurn` imports)
- `apps/web/src/components/app/harness/use-harness-turns.test.tsx`
- `apps/web/src/hooks/use-sse.ts` (the import and the one invalidation)
- `apps/server/src/routes/agents/harness-routes.ts` (the `GET .../harness/turns` route and its `loadTurns` import)
- `apps/server/test/harness-routes.test.ts` (`describe("GET /api/v1/agents/:id/harness/turns")` at `:33`, two cases, which plan 4 deletes with the route)
- `apps/server/src/chat/turns.ts` (`loadTurns`, and `assembleTurns`'s `HarnessTurn[]` return)
- `packages/shared/src/harness-types.ts` and `packages/shared/src/index.ts` (`HarnessTurn`, `HarnessTurnsResponse`)

A hit in `apps/server/test/harness-turns.test.ts` is expected only if plan 2 left a `HarnessTurn` annotation in it; that file asserts `assembleTurns` and never calls `loadTurns`, so no hit is also correct.

Nothing under `apps/web/src/components/app/chat/` may appear. If it does, that import is a defect in this plan and must go before the stage is called done.

- [ ] **Step 8: Commit the checklist result**

There is nothing to commit unless a gate step needed a fix. If one did, commit that fix on its own:

```bash
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

**Spec coverage.** Section 4 from "`ChatPane` becomes the dispatch agent's pane" to the end: the chrome's order and its `agent.type === "dispatch"` gate (Task 2), the starting screen and login hint as a status line (Task 2), the drop overlay merged with the composer's drop handling (Tasks 2 and 3), Stop and the queue with Enter queueing, ArrowUp recall and the touch-keyboard hint (Tasks 1 and 3), `/harness/interrupt` through `useHarnessInterrupt` (Task 2), `MotionConfig` at `ChatPane`'s root (Task 2), `TurnContext` provided by `ChatPane` (plan 2, confirmed and pinned by a test in Task 2), `agent-pane.tsx` and `agents-view.tsx` (Task 4), `agentSupportsHarness` (Task 4), mobile (Task 8's table, with assertions in Tasks 2, 4 and 7), motion tokens (Global Constraints and Task 2). Section 5's stage 2 row: `finalize:web`, the merged suites, the retargeted harness spec and the new dispatch case are Tasks 6 to 8. Section 6's stage-2 deletions: `harness-pane.tsx`, `question-card.tsx`, `turn-stream.tsx`, `agentSupportsHarness`, `harnessEnabled` (Tasks 4 and 5). Section 7: the merged unit tests (Tasks 2, 3, 5) and the E2E bullet (Tasks 6 and 7). Q1 (the Console segment stays) is asserted in Task 4; Q2 (the tasks strip is pinned) is Task 2's placement and its test.

**Placeholders.** None. Every step that changes code carries the code; every command carries its expected output. The two hedges are deliberate and bounded: Task 1 Step 5 says to grep for `assistantTurn` before deleting it (the file may use it elsewhere), and Task 4 Step 5 allows for `center-tabs.test.ts` not existing.

**Every task ends green.** Each task's own run is expected to pass in full as written. The one case that spans two deliverables, the drop overlay, is written in Task 3 with the two composer props that make it pass; Task 2 renders the overlay and owns its state, and says why its test is not there.

**Type consistency.** `useHarnessChrome` returns `{ chrome }` in Task 2 and `{ chrome, composer }` in Task 3; every consumer of `composer` lands in Task 3. `HarnessComposerProps` carries no `dropTargetRef` or `onDropZoneDragging`: `ChatPane` passes those two directly, because the ref and the dragging state belong to the element that paints the overlay. `latestTurnPlan` returns `TodoItem[]`, which is what `TasksStrip` takes. `newestTurnEntry` returns `ChatTurnEntry | null`, and `settled === false` is the one definition of "a turn is running" used by the chip row, the composer hint and `onInterrupt`; its DOM form is the absence of `data-settled`, which plan 2 writes only for a settled turn, so the E2E locators are `:not([data-settled])`. `composerHint`'s three parameters and its exact strings are identical in Task 1's tests, Task 3's hook and the E2E's `chat-composer-hint` assertions.

**Out of scope, deliberately left alone.** `use-harness-turns.ts`, its test, `harnessTurnsQueryKey`, the `use-sse.ts` invalidation at `:159`, `GET /api/v1/agents/:id/harness/turns`, the `harness.changed` feed invalidation, the client-side drop of a prompt chat row when its turn arrives, and the rename of `apps/server/test/harness-turns.test.ts`. All plan 4's. Task 8 Step 7 is the check that this plan left exactly that boundary.
