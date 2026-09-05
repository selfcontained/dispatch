# Harness View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give dsh agents a Harness view in the Agent pane that renders their stream as PromptKit's fused terminal stream (prompt line, collapsing activity block, result) on Dispatch's theme, with Chat and Console unchanged.

**Architecture:** The recorder gains `turn` rows so the server can cut the stream into turns; a read-only endpoint assembles `HarnessTurn[]` from stream rows; the web ports PromptKit's contracts, reducer, and primitives into `apps/web/src/components/app/harness/`, replaces its controller with a React Query hook over the endpoint (live via the existing `chat.changed` event), and mounts the view as a third Agent-pane segment for dsh agents only.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, React 18, Tailwind 3, shadcn (`components/ui`), React Query, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-dsh-harness-view-design.md`

## Global Constraints

- PromptKit source to port from: `/private/tmp/claude-501/-Users-daemon-ai-src-dispatch-agt-683b115bc1e9-dispatch-harness-research/52d35cda-4d51-417e-a645-49984d1adef6/scratchpad/mytra-os-uis/packages/promptkit/src` (shallow clone of MytraAI/mytra-os-uis, private). Re-clone with `gh repo clone MytraAI/mytra-os-uis -- --depth 1` if absent. No runtime dependency on `@mytraai/*`.
- Every ported file starts with a comment: `// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) — Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.`
- Token mapping (spec table): `pk-accent`→`status-working`, `pk-success`→`status-done`, error→`status-blocked`, `content-primary`→`foreground`, `content-secondary`→`foreground/80`, `content-tertiary`→`muted-foreground`, `surface-primary`→`background`, `surface-secondary`→`muted`, `border-base`→`border`, mono→`font-terminal`, `pk-animate-row-in`→`animate-harness-row`, `pk-animate-msg-in`→`animate-harness-msg`, `pk-pop`→`animate-harness-pop`; every animation class pairs with `motion-reduce:animate-none`.
- Web tests run with `NODE_OPTIONS=--no-experimental-webstorage`; server DB tests with `TEST_DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:54329/postgres` (scratch cluster; see memory `project-dispatch-local-env-quirks`). After adding a migration run `node scripts/generate-server-runtime-assets.mjs` before DB tests.
- Every `apps/web` change ends with `pnpm run finalize:web`; every task with `pnpm run check`. Commits carry `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The agent's own `mcp__dispatch__dispatch_event` tool calls never appear as steps.

---

## File map

| File                                                              | Responsibility                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/server/src/db/migrations/0049_agent-stream-events-turn.sql` | widen `kind` check to include `turn`                      |
| `apps/server/src/agents/dsh/driver.ts`                            | `turn started` event carries `text`                       |
| `apps/server/src/agents/dsh/stream-recorder.ts`                   | `turn` rows: started (with parsed prompt) and settled     |
| `apps/server/src/agents/dsh/prompt-source.ts`                     | parse an envelope into `{ source, ... }`                  |
| `apps/server/src/agents/dsh/turns.ts`                             | `assembleTurns(rows, chatMessagesById)` → `HarnessTurn[]` |
| `apps/server/src/routes/agents/harness-routes.ts`                 | `GET /api/v1/agents/:id/harness/turns`                    |
| `packages/shared/src/harness-types.ts`                            | `HarnessTurn`, `HarnessStep`, `HarnessPrompt`             |
| `apps/web/src/components/app/harness/*`                           | the view (see spec)                                       |
| `apps/web/src/lib/store.ts`                                       | `AgentPaneView` gains `"harness"`                         |
| `apps/web/src/lib/center-tabs.ts`                                 | `agentSupportsHarness`                                    |
| `apps/web/src/components/app/agent-pane.tsx`                      | three-segment toggle for dsh, mounts `HarnessPane`        |
| `apps/web/src/hooks/use-sse.ts`                                   | `chat.changed` also invalidates harness turns             |
| `apps/web/tailwind.config.ts`                                     | three keyframes                                           |
| `e2e/dsh-agent.spec.ts`                                           | Harness view assertions                                   |

---

### Task 1: Turn rows in the stream

**Files:**

- Create: `apps/server/src/db/migrations/0049_agent-stream-events-turn.sql`
- Create: `apps/server/src/agents/dsh/prompt-source.ts`
- Modify: `apps/server/src/agents/dsh/stream-store.ts` (`StreamEventKind`, `TurnPayload`)
- Modify: `apps/server/src/agents/dsh/driver.ts` (`turn started` event gains `text`)
- Modify: `apps/server/src/agents/dsh/stream-recorder.ts`
- Test: `apps/server/test/dsh-prompt-source.test.ts`, `apps/server/test/dsh-stream-recorder.test.ts`

**Interfaces:**

- Produces:

```ts
// prompt-source.ts
export type PromptSource =
  | { source: "chat"; chatMessageId: string }
  | { source: "agent"; senderId: string; senderName: string; text: string }
  | { source: "system"; text: string };
export function parsePromptSource(text: string): PromptSource;

// stream-store.ts additions
export type StreamEventKind = "assistant" | "thought" | "tool_call" | "status" | "turn";
export type TurnPayload = {
  state: "started" | "settled";
  prompt: PromptSource;
  stopReason?: string;
  error?: string;
  endedAt?: string;                 // ISO, set on settle
};

// driver.ts: the started event
| { type: "turn"; agentId: string; state: "started"; text: string }
```

- [ ] **Step 1: Write the failing tests**

`apps/server/test/dsh-prompt-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parsePromptSource } from "../src/agents/dsh/prompt-source.js";

describe("parsePromptSource", () => {
  it("reads the chat message id out of a chat envelope", () => {
    const text = [
      "--- DISPATCH CHAT (id: fae1f052-5d66-4039-9bde-35ac8166695d) ---",
      "hello",
      "--- END DISPATCH CHAT ---",
      "The user is reading Chat…",
    ].join("\n");
    expect(parsePromptSource(text)).toEqual({
      source: "chat",
      chatMessageId: "fae1f052-5d66-4039-9bde-35ac8166695d",
    });
  });

  it("reads sender and text out of a cross-agent message envelope", () => {
    const body = JSON.stringify({
      from: "Dispatch Harness Research",
      senderId: "agt_683b115bc1e9",
      senderRelation: "unrelated",
      message: "Quick check: which branch?",
      replyTarget: "agt_683b115bc1e9",
    });
    const text = `--- DISPATCH MESSAGE ---\n${body}\n--- END MESSAGE ---\nOptional reply channel…`;
    expect(parsePromptSource(text)).toEqual({
      source: "agent",
      senderId: "agt_683b115bc1e9",
      senderName: "Dispatch Harness Research",
      text: "Quick check: which branch?",
    });
  });

  it("keeps the first 500 characters of anything else as a system prompt", () => {
    const text = "x".repeat(600);
    expect(parsePromptSource(text)).toEqual({
      source: "system",
      text: "x".repeat(500),
    });
  });
});
```

Append to `apps/server/test/dsh-stream-recorder.test.ts` inside the `StreamRecorder` describe:

```ts
it("records a turn row at start and settles it in place", async () => {
  const rec = new StreamRecorder(store);
  await rec.handle({
    type: "turn",
    agentId: A,
    state: "started",
    text: "--- DISPATCH CHAT (id: 11111111-2222-4333-8444-555555555555) ---\nhi\n--- END DISPATCH CHAT ---",
  });
  await rec.handle(chunk("reply"));
  await rec.handle({
    type: "turn",
    agentId: A,
    state: "settled",
    stopReason: "end_turn",
  });
  const rows = (await store.list(A, 10)).reverse();
  expect(rows.map((r) => r.kind)).toEqual(["turn", "assistant"]);
  expect(rows[0].payload).toMatchObject({
    state: "settled",
    stopReason: "end_turn",
    prompt: {
      source: "chat",
      chatMessageId: "11111111-2222-4333-8444-555555555555",
    },
  });
  expect(typeof rows[0].payload.endedAt).toBe("string");
});

it("records the error on a failed turn's row", async () => {
  const rec = new StreamRecorder(store);
  await rec.handle({
    type: "turn",
    agentId: A,
    state: "started",
    text: "plain",
  });
  await rec.handle({
    type: "turn",
    agentId: A,
    state: "settled",
    error: "no API key",
  });
  const rows = (await store.list(A, 10)).reverse();
  expect(rows[0].payload).toMatchObject({
    state: "settled",
    error: "no API key",
    prompt: { source: "system", text: "plain" },
  });
  // The status row for the error is still written for the Chat feed.
  expect(rows[1].kind).toBe("status");
});
```

Also update every existing `{ type: "turn", agentId: A, state: "started" }` literal in that file and in `apps/server/test/dsh-usage-recorder.test.ts` and `apps/server/test/dsh-driver.test.ts` to include `text: "x"` where the compiler asks for it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:54329/postgres npx vitest run test/dsh-prompt-source.test.ts test/dsh-stream-recorder.test.ts`
Expected: FAIL (module not found; check constraint rejects `turn`).

- [ ] **Step 3: Migration**

`apps/server/src/db/migrations/0049_agent-stream-events-turn.sql`:

```sql
-- A `turn` row per harness turn: written when a prompt is sent and settled
-- in place when the harness finishes. The Harness view cuts the stream into
-- turns on these rows instead of guessing from prompt text.
ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events
  ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn'));
```

Then run `node scripts/generate-server-runtime-assets.mjs`.

- [ ] **Step 4: Prompt source parser**

`apps/server/src/agents/dsh/prompt-source.ts`:

```ts
/**
 * What a prompt sent to the harness was, for the Harness view's prompt
 * line. The wire text is an envelope Dispatch built; the view wants the
 * human-facing source behind it, not the envelope.
 */
export type PromptSource =
  | { source: "chat"; chatMessageId: string }
  | { source: "agent"; senderId: string; senderName: string; text: string }
  | { source: "system"; text: string };

const CHAT_HEADER = /^--- DISPATCH CHAT \(id: ([0-9a-f-]{36})\) ---/m;
const MESSAGE_BLOCK =
  /^--- DISPATCH MESSAGE ---\n([\s\S]*?)\n--- END MESSAGE ---/m;
const SYSTEM_MAX = 500;

export function parsePromptSource(text: string): PromptSource {
  const chat = CHAT_HEADER.exec(text);
  if (chat) return { source: "chat", chatMessageId: chat[1] };
  const message = MESSAGE_BLOCK.exec(text);
  if (message) {
    try {
      const body = JSON.parse(message[1]) as {
        from?: unknown;
        senderId?: unknown;
        message?: unknown;
      };
      if (typeof body.message === "string") {
        return {
          source: "agent",
          senderId: typeof body.senderId === "string" ? body.senderId : "",
          senderName: typeof body.from === "string" ? body.from : "agent",
          text: body.message,
        };
      }
    } catch {
      // fall through to system
    }
  }
  return { source: "system", text: text.slice(0, SYSTEM_MAX) };
}
```

- [ ] **Step 5: Store kind and payload type**

In `apps/server/src/agents/dsh/stream-store.ts` change `StreamEventKind` to include `"turn"` and add after `StatusPayload`:

```ts
export type TurnPayload = {
  state: "started" | "settled";
  prompt: PromptSource;
  stopReason?: string;
  error?: string;
  /** ISO time of settle. */
  endedAt?: string;
};
```

with `import type { PromptSource } from "./prompt-source.js";` and `turn: TurnPayload` in `StreamPayloadByKind`.

- [ ] **Step 6: Driver event carries the text**

In `apps/server/src/agents/dsh/driver.ts` change the started variant to `| { type: "turn"; agentId: string; state: "started"; text: string }` and in `prompt()` emit `{ type: "turn", agentId, state: "started", text }`.

- [ ] **Step 7: Recorder writes turn rows**

In `apps/server/src/agents/dsh/stream-recorder.ts` add a per-agent open-turn map and handle both states:

```ts
  private readonly openTurn = new Map<string, StreamEventRow>();
  ...
      case "turn":
        if (event.state === "started") {
          const row = await this.store.append(event.agentId, "turn", {
            state: "started",
            prompt: parsePromptSource(event.text),
          } satisfies TurnPayload);
          this.openTurn.set(event.agentId, row);
          return;
        }
        await this.closeText(event.agentId);
        {
          const open = this.openTurn.get(event.agentId);
          if (open) {
            const prev = open.payload as TurnPayload;
            await this.store.updatePayload(open.id, {
              ...prev,
              state: "settled",
              ...(event.stopReason ? { stopReason: event.stopReason } : {}),
              ...(event.error ? { error: event.error } : {}),
              endedAt: new Date().toISOString(),
            } satisfies TurnPayload);
            this.openTurn.delete(event.agentId);
          }
        }
        if (event.error) {
          await this.store.append(event.agentId, "status", { message: event.error });
        }
        return;
```

Import `parsePromptSource` and `TurnPayload`. On `exit`, delete the agent's open turn too.

- [ ] **Step 8: Run tests, type check**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:54329/postgres npx vitest run test/dsh-prompt-source.test.ts test/dsh-stream-recorder.test.ts test/dsh-driver.test.ts test/dsh-supervisor.test.ts test/dsh-usage-recorder.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db/migrations/0049_agent-stream-events-turn.sql apps/server/src/agents/dsh apps/server/test
git commit -m "feat(harness): turn rows in the stream with the parsed prompt source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Assemble turns

**Files:**

- Create: `packages/shared/src/harness-types.ts` (+ export from `packages/shared/src/index.ts`)
- Create: `apps/server/src/agents/dsh/turns.ts`
- Test: `apps/server/test/dsh-turns.test.ts`

**Interfaces:**

- Produces:

```ts
// packages/shared/src/harness-types.ts
export type HarnessPrompt = {
  source: "chat" | "launch" | "agent" | "system";
  text: string;
  senderName?: string;
  chatMessageId?: string;
  attachments: ChatAttachment[];
};
export type HarnessStepStatus = "running" | "ok" | "error";
export type HarnessStep = {
  id: string;
  kind: string;
  label: string;
  status: HarnessStepStatus;
  startedAt: string;
  endedAt?: string;
  durMs?: number;
  detail: {
    toolKind?: string;
    locations?: { path: string; line?: number }[];
    diff?: { path: string; oldText: string | null; newText: string } | null;
    terminalOutput?: string | null;
    truncated?: boolean;
    text?: string;
  };
};
export type HarnessTurn = {
  id: string;
  prompt: HarnessPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    finalResult?: "ok" | "error";
    steps: HarnessStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
};
export type HarnessTurnsResponse = { turns: HarnessTurn[] };

// apps/server/src/agents/dsh/turns.ts
export type TurnSourceRow = Pick<
  StreamEventRow,
  "id" | "seq" | "kind" | "payload" | "createdAt" | "updatedAt"
>;
export function assembleTurns(
  rows: TurnSourceRow[], // ascending seq
  chatMessages: Map<string, ChatMessage> // by id, for chat prompts
): HarnessTurn[];
export async function loadTurns(
  db: Queryable,
  agentId: string,
  limit: number
): Promise<HarnessTurn[]>;
```

- [ ] **Step 1: Write the failing test**

`apps/server/test/dsh-turns.test.ts` (pure, no DB):

```ts
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@dispatch/shared";

import { assembleTurns, type TurnSourceRow } from "../src/agents/dsh/turns.js";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 4, 10, 0, s));
function row(
  kind: TurnSourceRow["kind"],
  payload: Record<string, unknown>,
  s: number,
  settledAt?: number
): TurnSourceRow {
  seq += 1;
  return {
    id: seq,
    seq,
    kind,
    payload,
    createdAt: at(s),
    updatedAt: at(settledAt ?? s),
  };
}
const chatMsg = (id: string, text: string, origin?: "launch"): ChatMessage => ({
  id,
  agentId: "a",
  authorKind: "user",
  kind: "reply",
  text,
  replyTo: null,
  question: null,
  answer: null,
  attachments: [],
  delivered: true,
  readAt: null,
  ...(origin ? { origin } : {}),
  createdAt: at(0).toISOString(),
  updatedAt: at(0).toISOString(),
});

describe("assembleTurns", () => {
  it("cuts the stream into turns with prompt, steps, and result", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "chat", chatMessageId: "m1" },
          stopReason: "end_turn",
          endedAt: at(9).toISOString(),
        },
        0,
        9
      ),
      row("assistant", { text: "Let me look.", streaming: false }, 1),
      row(
        "tool_call",
        {
          toolKind: "other",
          title: "mcp__dispatch__dispatch_event",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "ok",
        },
        2,
        2
      ),
      row(
        "tool_call",
        {
          toolKind: "execute",
          title: "bash",
          status: "completed",
          locations: [],
          diff: null,
          terminalOutput: "a\nb\n",
        },
        3,
        5
      ),
      row("thought", { text: "reasoning" }, 6),
      row("assistant", { text: "Done: two files.", streaming: false }, 8),
      row(
        "turn",
        { state: "started", prompt: { source: "system", text: "again" } },
        10
      ),
      row("assistant", { text: "Work", streaming: true }, 11),
    ];
    const turns = assembleTurns(
      rows,
      new Map([["m1", chatMsg("m1", "look please")]])
    );
    expect(turns).toHaveLength(2);
    const [first, second] = turns;
    expect(first.prompt).toMatchObject({
      source: "chat",
      text: "look please",
      chatMessageId: "m1",
    });
    expect(first.trace.finalResult).toBe("ok");
    expect(first.trace.steps.map((s) => [s.kind, s.label, s.status])).toEqual([
      ["note", "Let me look.", "ok"],
      ["execute", "bash", "ok"],
      ["think", "thinking", "ok"],
    ]);
    expect(first.trace.steps[1].durMs).toBe(2000);
    expect(first.result).toEqual({
      text: "Done: two files.",
      streaming: false,
    });
    expect(second.prompt).toEqual({
      source: "system",
      text: "again",
      attachments: [],
    });
    expect(second.trace.endedAt).toBeUndefined();
    expect(second.result).toEqual({ text: "Work", streaming: true });
  });

  it("marks a launch post and a cross-agent message by source", () => {
    seq = 0;
    const rows = [
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "chat", chatMessageId: "L" },
          endedAt: at(1).toISOString(),
        },
        0,
        1
      ),
      row(
        "turn",
        {
          state: "settled",
          prompt: {
            source: "agent",
            senderId: "agt_x",
            senderName: "Reviewer",
            text: "hi",
          },
          endedAt: at(3).toISOString(),
        },
        2,
        3
      ),
    ];
    const turns = assembleTurns(
      rows,
      new Map([["L", chatMsg("L", "launch text", "launch")]])
    );
    expect(turns[0].prompt.source).toBe("launch");
    expect(turns[1].prompt).toMatchObject({
      source: "agent",
      senderName: "Reviewer",
      text: "hi",
    });
  });

  it("folds rows before the first turn row into one synthetic turn and carries a settle error", () => {
    seq = 0;
    const rows = [
      row(
        "tool_call",
        {
          toolKind: "read",
          title: "read",
          status: "failed",
          locations: [{ path: "x" }],
          diff: null,
          terminalOutput: null,
        },
        0,
        1
      ),
      row(
        "turn",
        {
          state: "settled",
          prompt: { source: "system", text: "p" },
          error: "no API key",
          endedAt: at(3).toISOString(),
        },
        2,
        3
      ),
      row("status", { message: "no API key" }, 3),
    ];
    const turns = assembleTurns(rows, new Map());
    expect(turns[0].prompt).toEqual({
      source: "system",
      text: "Earlier activity",
      attachments: [],
    });
    expect(turns[0].trace.steps[0]).toMatchObject({
      kind: "read",
      status: "error",
    });
    expect(turns[1].error).toBe("no API key");
    expect(turns[1].trace.finalResult).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run test/dsh-turns.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Shared types**

Create `packages/shared/src/harness-types.ts` with the types from the Interfaces block (import `ChatAttachment` from `./chat-types.js`) and add to `packages/shared/src/index.ts`:

```ts
export type {
  HarnessPrompt,
  HarnessStep,
  HarnessStepStatus,
  HarnessTurn,
  HarnessTurnsResponse,
} from "./harness-types.js";
```

- [ ] **Step 4: Assembly**

`apps/server/src/agents/dsh/turns.ts`:

```ts
import type {
  ChatMessage,
  HarnessPrompt,
  HarnessStep,
  HarnessTurn,
} from "@dispatch/shared";

import type { Queryable } from "../../chat/store.js";
import { toChatMessage } from "../../chat/store.js";
import type { PromptSource } from "./prompt-source.js";
import type {
  AssistantPayload,
  StreamEventRow,
  ThoughtPayload,
  ToolPayload,
  TurnPayload,
} from "./stream-store.js";

export type TurnSourceRow = Pick<
  StreamEventRow,
  "id" | "seq" | "kind" | "payload" | "createdAt" | "updatedAt"
>;

/** The agent's own status reports already show as status lines; in a trace they are noise. */
const DROPPED_TOOL_TITLES = new Set(["mcp__dispatch__dispatch_event"]);

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function promptFor(
  source: PromptSource,
  chat: Map<string, ChatMessage>
): HarnessPrompt {
  if (source.source === "chat") {
    const message = chat.get(source.chatMessageId);
    return {
      source: message?.origin === "launch" ? "launch" : "chat",
      text: message?.text ?? "",
      chatMessageId: source.chatMessageId,
      attachments: message?.attachments ?? [],
    };
  }
  if (source.source === "agent") {
    return {
      source: "agent",
      text: source.text,
      senderName: source.senderName,
      attachments: [],
    };
  }
  return { source: "system", text: source.text, attachments: [] };
}

function toolStep(row: TurnSourceRow): HarnessStep | null {
  const p = row.payload as Partial<ToolPayload>;
  const title = p.title ?? "";
  if (DROPPED_TOOL_TITLES.has(title)) return null;
  const settled = p.status === "completed" || p.status === "failed";
  return {
    id: `stream:${row.id}`,
    kind: p.toolKind ?? "other",
    label: title,
    status:
      p.status === "completed"
        ? "ok"
        : p.status === "failed"
          ? "error"
          : "running",
    startedAt: row.createdAt.toISOString(),
    ...(settled
      ? {
          endedAt: row.updatedAt.toISOString(),
          durMs: Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
        }
      : {}),
    detail: {
      toolKind: p.toolKind,
      locations: p.locations ?? [],
      diff: p.diff ?? null,
      terminalOutput: p.terminalOutput ?? null,
      ...(p.truncated ? { truncated: true } : {}),
    },
  };
}

function noteStep(row: TurnSourceRow, kind: "note" | "think"): HarnessStep {
  const p = row.payload as Partial<AssistantPayload & ThoughtPayload>;
  const text = p.text ?? "";
  return {
    id: `stream:${row.id}`,
    kind,
    label: kind === "think" ? "thinking" : firstLine(text),
    status: "ok",
    startedAt: row.createdAt.toISOString(),
    endedAt: row.updatedAt.toISOString(),
    detail: { text, ...(p.truncated ? { truncated: true } : {}) },
  };
}

type Group = { turn: TurnSourceRow | null; rows: TurnSourceRow[] };

export function assembleTurns(
  rows: TurnSourceRow[],
  chat: Map<string, ChatMessage>
): HarnessTurn[] {
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
  return groups.map((group, index) => {
    const turnPayload = group.turn ? (group.turn.payload as TurnPayload) : null;
    const startedAt = (group.turn ?? group.rows[0]).createdAt.toISOString();
    const settled = turnPayload?.state === "settled";
    const steps: HarnessStep[] = [];
    let result: HarnessTurn["result"] = null;
    const assistants = group.rows.filter((r) => r.kind === "assistant");
    const last = assistants[assistants.length - 1];
    for (const row of group.rows) {
      if (row.kind === "tool_call") {
        const step = toolStep(row);
        if (step) steps.push(step);
      } else if (row.kind === "thought") {
        steps.push(noteStep(row, "think"));
      } else if (row.kind === "assistant") {
        if (row === last) {
          const p = row.payload as Partial<AssistantPayload>;
          result = {
            text: p.text ?? "",
            streaming: p.streaming === true && !settled,
            ...(p.truncated ? { truncated: true } : {}),
          };
        } else {
          steps.push(noteStep(row, "note"));
        }
      }
    }
    const error = turnPayload?.error;
    return {
      id: group.turn ? `turn:${group.turn.id}` : `turn:pre:${index}`,
      prompt: turnPayload
        ? promptFor(turnPayload.prompt, chat)
        : { source: "system", text: "Earlier activity", attachments: [] },
      trace: {
        startedAt,
        ...(settled && turnPayload?.endedAt
          ? { endedAt: turnPayload.endedAt }
          : {}),
        ...(settled ? { finalResult: error ? "error" : "ok" } : {}),
        ...(!group.turn && group.rows.length
          ? {
              endedAt:
                group.rows[group.rows.length - 1].updatedAt.toISOString(),
              finalResult: "ok" as const,
            }
          : {}),
        steps,
      },
      result,
      ...(error ? { error } : {}),
    };
  });
}

export async function loadTurns(
  db: Queryable,
  agentId: string,
  limit: number
): Promise<HarnessTurn[]> {
  // The newest `limit` turn rows bound the window; everything from the
  // oldest of them onward is one contiguous slice of the stream.
  const boundary = await db.query<{ seq: number }>(
    `SELECT seq FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn'
      ORDER BY seq DESC LIMIT $2`,
    [agentId, limit]
  );
  const fromSeq = boundary.rows.length
    ? boundary.rows[boundary.rows.length - 1].seq
    : 0;
  const rows = await db.query<{
    id: number;
    seq: number;
    kind: StreamEventRow["kind"];
    payload: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, seq, kind, payload, created_at, updated_at FROM agent_stream_events
      WHERE agent_id = $1 AND seq >= $2 ORDER BY seq ASC`,
    [agentId, fromSeq]
  );
  const source: TurnSourceRow[] = rows.rows.map((r) => ({
    id: Number(r.id),
    seq: r.seq,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const chatIds = source
    .filter((r) => r.kind === "turn")
    .map((r) => (r.payload as TurnPayload).prompt)
    .filter(
      (p): p is Extract<PromptSource, { source: "chat" }> => p.source === "chat"
    )
    .map((p) => p.chatMessageId);
  const chat = new Map<string, ChatMessage>();
  if (chatIds.length) {
    const messages = await db.query(
      `SELECT * FROM agent_chat_messages WHERE id = ANY($1::uuid[])`,
      [chatIds]
    );
    for (const row of messages.rows) {
      const message = toChatMessage(row as never);
      chat.set(message.id, message);
    }
  }
  return assembleTurns(source, chat);
}
```

Check that `toChatMessage` is exported from `chat/store.ts` (feed.ts imports it, so it is) and that `agent_chat_messages.id` is a uuid column; if it is `text`, drop the `::uuid[]` cast.

- [ ] **Step 5: Run tests and type check**

Run: `cd apps/server && npx vitest run test/dsh-turns.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src apps/server/src/agents/dsh/turns.ts apps/server/test/dsh-turns.test.ts
git commit -m "feat(harness): assemble HarnessTurn[] from stream rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Turns endpoint

**Files:**

- Create: `apps/server/src/routes/agents/harness-routes.ts`
- Modify: `apps/server/src/routes/agents/index.ts` (register)
- Test: `apps/server/test/harness-routes.test.ts`

**Interfaces:**

- Consumes: `loadTurns` (Task 2), `AgentRouteDeps` from `apps/server/src/routes/agents/shared.ts` (read it for the `pool` and `handleAgentError` fields).
- Produces: `GET /api/v1/agents/:id/harness/turns?limit=50` → `HarnessTurnsResponse`; 404 for a missing agent; 400 for a non-numeric limit; limit clamped to 1..200.

- [ ] **Step 1: Write the failing test**

Model `apps/server/test/harness-routes.test.ts` on `apps/server/test/chat-routes.test.ts`'s setup (same `buildTestApp`-style helper that file uses for a Fastify instance with a test pool). Cases: seeds one agent with a settled turn row and an assistant row and expects `{ turns: [ { prompt: {...}, result: { text: "hi", streaming: false } } ] }`; unknown agent → 404; `limit=abc` → 400.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:54329/postgres npx vitest run test/harness-routes.test.ts`
Expected: FAIL, 404 on the route.

- [ ] **Step 3: Route**

`apps/server/src/routes/agents/harness-routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { HarnessTurnsResponse } from "@dispatch/shared";

import { loadTurns } from "../../agents/dsh/turns.js";
import type { AgentRouteDeps } from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Turns for the Harness view: read-only, assembled from the stream rows. */
export async function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  app.get("/api/v1/agents/:id/harness/turns", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const raw = (request.query as { limit?: string }).limit;
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed))
        return reply.code(400).send({ error: "limit must be a number." });
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
    }
    const exists = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    if (exists.rows.length === 0)
      return reply.code(404).send({ error: "Agent not found." });
    const response: HarnessTurnsResponse = {
      turns: await loadTurns(deps.pool, id, limit),
    };
    return response;
  });
}
```

Register it in `apps/server/src/routes/agents/index.ts` after the terminal routes.

- [ ] **Step 4: Run tests and check**

Run: `cd apps/server && TEST_DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:54329/postgres npx vitest run test/harness-routes.test.ts && cd ../.. && pnpm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/agents apps/server/test/harness-routes.test.ts
git commit -m "feat(harness): GET /api/v1/agents/:id/harness/turns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Port PromptKit's contracts, reducer, ticker, and format

**Files:**

- Create: `apps/web/src/components/app/harness/contracts.ts`, `reduce.ts`, `format.ts`, `use-stream-ticker.ts`
- Test: `apps/web/src/components/app/harness/reduce.test.ts`, `format.test.ts`

**Interfaces:**

- Produces: exactly PromptKit's exports from `contracts/{turn,trace,tool,artifact,transport,reduce}.ts`, `lib/format.ts`, `primitives/use-stream-ticker.ts`, re-homed. `contracts.ts` holds `Turn`, `Attachment`, `ContextChip`, `Trace`, `Step`, `StepStatus`, `ToolCall`, `ToolOutcome`, `ToolCallRecord`, `StreamEvent`; everything Brane-specific (`AgentForm`, `StructuredInput`, `Reflection`, `Feedback`, `ArtifactRef`, `Clarification`, `PromptTransport`, `SubmitRequest`, `ModelInfo`) is left out.

- [ ] **Step 1: Copy and trim**

```bash
PK=/private/tmp/claude-501/-Users-daemon-ai-src-dispatch-agt-683b115bc1e9-dispatch-harness-research/52d35cda-4d51-417e-a645-49984d1adef6/scratchpad/mytra-os-uis/packages/promptkit/src
H=apps/web/src/components/app/harness
mkdir -p $H
cat $PK/contracts/trace.ts $PK/contracts/tool.ts $PK/contracts/turn.ts $PK/contracts/transport.ts > $H/contracts.ts
cp $PK/contracts/reduce.ts $H/reduce.ts
cp $PK/lib/format.ts $H/format.ts
cp $PK/primitives/use-stream-ticker.ts $H/use-stream-ticker.ts
cp $PK/contracts/reduce.test.ts $H/reduce.test.ts
cp $PK/lib/format.test.ts $H/format.test.ts
```

Then edit `contracts.ts` by hand: drop the internal `import`s between the concatenated files, drop the left-out types listed above and every field on `Turn` that references them (`clarification`, `form`, `input`, `artifacts`, `reflection`, `feedback`), keep `toolCalls`, `trace`, `error`, `extra`; in `StreamEvent` keep `step`, `step_update`, `delta`, `tool_call`, `result` (with only `content`), `error`, `done`. Put the attribution comment at the top of each file. Fix imports in `reduce.ts` (`./contracts`) and the two tests (`./reduce`, `./format`). Prettier will restyle quotes on commit.

- [ ] **Step 2: Run the ported tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app/harness
git commit -m "feat(harness): port PromptKit contracts, reducer, ticker, and format

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Port the primitives onto shadcn and Dispatch tokens

**Files:**

- Create: `apps/web/src/components/app/harness/registry.ts`, `prompt-line.tsx`, `step-row.tsx`, `step-detail.tsx`, `activity-block.tsx`, `result-turn.tsx`, `turn-stream.tsx`
- Modify: `apps/web/tailwind.config.ts` (keyframes + animations)
- Test: `prompt-line.test.tsx`, `step-row.test.tsx`, `activity-block.test.tsx`, `turn-stream.test.tsx` (ported from PromptKit's tests of the same names, with the token classes updated)

**Interfaces:**

- Consumes: Task 4 types.
- Produces:

```ts
// registry.ts
export function kindLabel(kind: string): string; // execute→"run", edit→"edit", read→"read", search→"search", fetch→"fetch", think→"thinking", note→"", other→kind
export function stepSummary(step: Step): string | undefined; // per spec table
export function StepDetail(props: { step: Step }): JSX.Element | null; // per spec table (terminal pre, diff via ../chat/stream-entries diffLines, locations list, kv)
// components
export function PromptLine(props: {
  turn: Turn;
  onAttachmentClick?: (a: Attachment) => void;
}): JSX.Element;
export function StepRow(props: {
  step: Step;
  open: boolean;
  onToggle: () => void;
}): JSX.Element;
export function ActivityBlock(props: {
  trace: Trace;
  label?: string;
}): JSX.Element;
export function ResultTurn(props: {
  turn: Turn;
  isStreaming?: boolean;
}): JSX.Element | null;
export function TurnStream(props: {
  turns: Turn[];
  liveTrace?: Trace | null;
  liveText?: string;
  streaming?: boolean;
  emptyState?: ReactNode;
  onAttachmentClick?: (a: Attachment) => void;
}): JSX.Element;
```

- [ ] **Step 1: Copy the primitives and their tests**

```bash
PK=/private/tmp/claude-501/-Users-daemon-ai-src-dispatch-agt-683b115bc1e9-dispatch-harness-research/52d35cda-4d51-417e-a645-49984d1adef6/scratchpad/mytra-os-uis/packages/promptkit/src/primitives
H=apps/web/src/components/app/harness
cp $PK/PromptLine.tsx $H/prompt-line.tsx;   cp $PK/PromptLine.test.tsx $H/prompt-line.test.tsx
cp $PK/StepRow.tsx $H/step-row.tsx;         cp $PK/StepRow.test.tsx $H/step-row.test.tsx
cp $PK/StepDetailBody.tsx $H/step-detail.tsx; cp $PK/StepDetailBody.test.tsx $H/step-detail.test.tsx
cp $PK/ActivityBlock.tsx $H/activity-block.tsx; cp $PK/ActivityBlock.test.tsx $H/activity-block.test.tsx
cp $PK/ResultTurn.tsx $H/result-turn.tsx;   cp $PK/ResultTurn.test.tsx $H/result-turn.test.tsx
cp $PK/TurnStream.tsx $H/turn-stream.tsx;   cp $PK/TurnStream.test.tsx $H/turn-stream.test.tsx
```

- [ ] **Step 2: Adapt each file**

Apply, in every copied file:

- Attribution comment at the top.
- Imports: `../contracts` → `./contracts`; `../lib/cn` → `@/lib/utils` (`cn`); `../lib/format` → `./format`; `../registry` (`usePromptKit`) → `./registry` (`kindLabel`, `stepSummary`, `StepDetail`); `./MarkdownText` → `Markdown` from `@/components/ui/markdown`; `@mytraai/mytrakit/components/base/scroll-area` (`MKScrollArea`) → `ScrollArea` from `@/components/ui/scroll-area`; `./detail/no-liga` → delete (Dispatch's font has no ligature classes); `./detail/KvGrid` → a 12-line local `KvGrid` in `step-detail.tsx` (a two-column grid of `<dt>`/`<dd>` with `text-[11px]`).
- Token classes per the Global Constraints table, using sed:

```bash
cd apps/web/src/components/app/harness
sed -i '' -E 's/text-pk-accent/text-status-working/g; s/bg-pk-accent/bg-status-working/g; s/ring-pk-accent/ring-status-working/g; s/pk-success/status-done/g; s/text-content-primary/text-foreground/g; s/text-content-secondary/text-foreground\/80/g; s/text-content-tertiary/text-muted-foreground/g; s/bg-surface-secondary/bg-muted/g; s/bg-surface-primary/bg-background/g; s/border-border-base/border-border/g; s/pk-animate-row-in/animate-harness-row motion-reduce:animate-none/g; s/pk-animate-msg-in/animate-harness-msg motion-reduce:animate-none/g; s/pk-animate-pop/animate-harness-pop motion-reduce:animate-none/g' *.tsx
```

Then read each file once for leftovers (`content-`, `surface-`, `pk-`, `MK`).

- Remove from `result-turn.tsx` and `turn-stream.tsx` everything about clarification, forms, artifacts, reflection, revert, retry, reset, `showRaw`, `boardLabel`, `activeArtifactId`; keep `ResultText` (Markdown), the `Footer` only if it survives without those (otherwise drop it), the empty state, and the live path (`liveTrace` + `liveText`).
- `step-row.tsx`: `usePromptKit()` → direct imports; keep `STATUS_ARIA`, `StatusGlyph`, `RunningDots`, `LiveDuration`, and the braille ticker.
- `activity-block.tsx`: the collapsed summary verb reads `done`, `failed`; there is no `clarification` outcome.
- Every `pre` for terminal output or text uses `font-terminal text-[11px] leading-snug`; the diff detail reuses `diffLines` from `@/components/app/chat/stream-entries` with the same coloured rows.

`registry.ts`:

```ts
import type { ReactNode } from "react";
import type { Step } from "./contracts";
import { diffLines } from "@/components/app/chat/stream-entries";

type Detail = {
  toolKind?: string;
  locations?: { path: string; line?: number }[];
  diff?: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput?: string | null;
  truncated?: boolean;
  text?: string;
};

const LABELS: Record<string, string> = {
  execute: "run",
  edit: "edit",
  read: "read",
  search: "search",
  fetch: "fetch",
  think: "thinking",
  note: "",
};
export function kindLabel(kind: string): string {
  return LABELS[kind] ?? kind;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function stepSummary(step: Step): string | undefined {
  const d = (step.detail ?? {}) as Detail;
  switch (step.kind) {
    case "execute":
      return d.terminalOutput?.split("\n").find((l) => l.trim()) ?? undefined;
    case "edit": {
      if (!d.diff)
        return d.locations?.[0] ? basename(d.locations[0].path) : undefined;
      const lines = diffLines(d.diff.oldText, d.diff.newText);
      const add = lines.filter((l) => l.kind === "add").length;
      const del = lines.filter((l) => l.kind === "del").length;
      return `${basename(d.diff.path)} +${add} −${del}`;
    }
    case "read":
      return d.locations?.[0]
        ? `${basename(d.locations[0].path)}${d.locations[0].line ? `:${d.locations[0].line}` : ""}`
        : undefined;
    case "search":
      return d.locations?.length
        ? `${d.locations.length} location${d.locations.length === 1 ? "" : "s"}`
        : undefined;
    default:
      return undefined;
  }
}
```

`StepDetail` lives in `step-detail.tsx` and switches on `step.kind`: `execute` → `<pre>` of `terminalOutput`; `edit` → the diff rows (same markup as `DiffBlock` in `stream-entries.tsx`; extract `DiffBlock` to an export there and reuse it); `read`/`search` → a list of `path:line`; `think`/`note` → `<Markdown>` of `text`; `other` → `KvGrid` of scalar detail fields. A `truncated` flag appends "Output truncated at the server's size limit."

`apps/web/tailwind.config.ts`, inside `theme.extend`:

```ts
      keyframes: {
        ...existing,
        "harness-row": { from: { opacity: "0", transform: "translateY(3px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "harness-msg": { from: { opacity: "0", transform: "translateY(5px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "harness-pop": { "0%": { transform: "scale(0.3)" }, "80%": { transform: "scale(1.12)" }, "100%": { transform: "scale(1)" } },
      },
      animation: {
        ...existing,
        "harness-row": "harness-row 160ms ease-out both",
        "harness-msg": "harness-msg 220ms ease-out both",
        "harness-pop": "harness-pop 260ms cubic-bezier(0.2, 0.9, 0.3, 1.4) both",
      },
```

(Read the existing `chat-enter` entries first and match their shape.)

- [ ] **Step 3: Adapt the ported tests**

The copied tests reference `PromptKitProvider`, mytrakit, and the old token classes. Wrap nothing (there is no provider); replace class assertions with the mapped classes; delete cases for removed features (clarification, forms, artifacts, revert, retry). Keep: ActivityBlock open-while-running / collapsed-when-done / summary text / focus after toggle; StepRow label, aria-label, duration, running dots; PromptLine caret, chips, attachments; TurnStream order and live path.

- [ ] **Step 4: Run, lint, type check**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness && npx tsc --noEmit && npx eslint --config eslint.config.js src/components/app/harness`
Expected: PASS, no errors (warnings about fast refresh on `registry.ts`-style modules are acceptable only in non-component files; move any `export function` component out of a file that also exports non-components).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/harness apps/web/tailwind.config.ts apps/web/src/components/app/chat/stream-entries.tsx
git commit -m "feat(harness): PromptKit primitives on shadcn and Dispatch tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Hook, pane, and view wiring

**Files:**

- Create: `apps/web/src/components/app/harness/use-harness-turns.ts`, `harness-pane.tsx`
- Modify: `apps/web/src/lib/store.ts` (`AgentPaneView`, `isAgentPaneView`, default per type), `apps/web/src/lib/center-tabs.ts` (`agentSupportsHarness`), `apps/web/src/components/app/agent-pane.tsx` (toggle + mount), `apps/web/src/hooks/use-sse.ts` (invalidate), wherever `agentPaneViewAtomFamily` default is read for a dsh agent (grep `agentPaneViewAtomFamily(` in `agents-view.tsx`)
- Test: `use-harness-turns.test.tsx`, `harness-pane.test.tsx`, `agent-pane.test.tsx` (three-segment case)

**Interfaces:**

- Consumes: `HarnessTurn` (Task 2), primitives (Task 5), `ChatComposer` and `useSendChatMessage` from the chat module, `invalidateChatFeed` pattern in `use-sse.ts`.
- Produces:

```ts
export function harnessTurnsQueryKey(
  agentId: string | null
): readonly ["harness-turns", string | null];
export function useHarnessTurns(agentId: string | null): {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  streaming: boolean;
  loading: boolean;
};
export function toPromptKitTurns(turns: HarnessTurn[]): {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  streaming: boolean;
};
export function HarnessPane(props: {
  agentId: string;
  agentName: string;
  active: boolean;
}): JSX.Element;
export type AgentPaneView = "harness" | "chat" | "console";
export function agentSupportsHarness(
  agentType: string | null | undefined
): boolean; // === "dsh"
```

- [ ] **Step 1: Write the failing mapping test**

`use-harness-turns.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import type { HarnessTurn } from "@dispatch/shared";

import { toPromptKitTurns } from "./use-harness-turns";

const settled: HarnessTurn = {
  id: "turn:1",
  prompt: { source: "chat", text: "look", attachments: [] },
  trace: {
    startedAt: "2026-09-04T10:00:00.000Z",
    endedAt: "2026-09-04T10:00:09.000Z",
    finalResult: "ok",
    steps: [
      {
        id: "stream:2",
        kind: "execute",
        label: "bash",
        status: "ok",
        startedAt: "2026-09-04T10:00:03.000Z",
        endedAt: "2026-09-04T10:00:05.000Z",
        durMs: 2000,
        detail: { terminalOutput: "a\n" },
      },
    ],
  },
  result: { text: "Done.", streaming: false },
};
const live: HarnessTurn = {
  id: "turn:2",
  prompt: {
    source: "agent",
    text: "again",
    senderName: "Reviewer",
    attachments: [],
  },
  trace: {
    startedAt: "2026-09-04T10:00:10.000Z",
    steps: [
      {
        id: "stream:9",
        kind: "read",
        label: "read",
        status: "running",
        startedAt: "2026-09-04T10:00:11.000Z",
        detail: {},
      },
    ],
  },
  result: { text: "Work", streaming: true },
};

describe("toPromptKitTurns", () => {
  it("emits a user and an assistant turn per settled HarnessTurn", () => {
    const out = toPromptKitTurns([settled]);
    expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(out.turns[0].content).toBe("look");
    expect(out.turns[1].trace?.steps[0]).toMatchObject({
      kind: "execute",
      status: "ok",
      durMs: 2000,
    });
    expect(out.turns[1].trace?.finalResult).toBe("ok");
    expect(out.liveTrace).toBeNull();
    expect(out.streaming).toBe(false);
  });

  it("routes a streaming turn through the live path with the sender as a chip", () => {
    const out = toPromptKitTurns([settled, live]);
    expect(out.turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(out.turns[2].contextChips).toEqual([{ label: "from Reviewer" }]);
    expect(out.liveTrace?.steps[0].status).toBe("running");
    expect(out.liveText).toBe("Work");
    expect(out.streaming).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/use-harness-turns.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Hook**

`use-harness-turns.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type {
  HarnessStep,
  HarnessTurn,
  HarnessTurnsResponse,
} from "@dispatch/shared";

import { api } from "@/lib/api";
import type { Step, Trace, Turn } from "./contracts";

export function harnessTurnsQueryKey(agentId: string | null) {
  return ["harness-turns", agentId] as const;
}

function toStep(step: HarnessStep): Step {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
  };
}

function toTrace(turn: HarnessTurn): Trace {
  return {
    startedAt: Date.parse(turn.trace.startedAt),
    ...(turn.trace.endedAt ? { endedAt: Date.parse(turn.trace.endedAt) } : {}),
    ...(turn.trace.finalResult ? { finalResult: turn.trace.finalResult } : {}),
    steps: turn.trace.steps.map(toStep),
  };
}

export function toPromptKitTurns(turns: HarnessTurn[]) {
  const out: Turn[] = [];
  let liveTrace: Trace | null = null;
  let liveText = "";
  let streaming = false;
  turns.forEach((turn, index) => {
    const isLast = index === turns.length - 1;
    const open = turn.trace.endedAt === undefined;
    out.push({
      id: `${turn.id}:user`,
      role: "user",
      content: turn.prompt.text,
      timestamp: Date.parse(turn.trace.startedAt),
      ...(turn.prompt.attachments.length
        ? {
            attachments: turn.prompt.attachments.map((a) =>
              a.type === "file"
                ? {
                    kind: "file",
                    url: `/api/v1/media/${a.mediaId}`,
                    name: a.fileName,
                  }
                : a.type === "link"
                  ? { kind: "link", url: a.url, name: a.title ?? a.url }
                  : { kind: "pin", url: "", name: a.pinId }
            ),
          }
        : {}),
      ...(turn.prompt.senderName
        ? { contextChips: [{ label: `from ${turn.prompt.senderName}` }] }
        : {}),
    });
    if (isLast && open) {
      liveTrace = toTrace(turn);
      liveText = turn.result?.text ?? "";
      streaming = true;
      return;
    }
    out.push({
      id: `${turn.id}:assistant`,
      role: "assistant",
      content: turn.result?.text ?? "",
      timestamp: Date.parse(turn.trace.endedAt ?? turn.trace.startedAt),
      trace: toTrace(turn),
      ...(turn.error
        ? { error: { code: "turn_failed", message: turn.error } }
        : {}),
    });
  });
  return { turns: out, liveTrace, liveText, streaming };
}

export function useHarnessTurns(agentId: string | null) {
  const query = useQuery({
    queryKey: harnessTurnsQueryKey(agentId),
    queryFn: () =>
      api<HarnessTurnsResponse>(
        `/api/v1/agents/${agentId}/harness/turns?limit=50`
      ),
    enabled: agentId !== null,
    staleTime: 5_000,
  });
  const mapped = toPromptKitTurns(query.data?.turns ?? []);
  return { ...mapped, loading: query.isLoading };
}
```

Check `ChatAttachment`'s union shape in `packages/shared/src/chat-types.ts` before writing the attachment mapping; match its fields exactly.

- [ ] **Step 4: Pane, views, toggle, SSE**

`harness-pane.tsx`: a flex column; `TurnStream` in `ScrollArea` with a bottom-follow effect keyed on `entryGrowth`-style change (turn count + `liveText.length` + last step status), then `ChatComposer` wired the same way `ChatPane` wires it (read `chat-pane.tsx` for the composer's props and `useSendChatMessage`). `emptyState`: "Send the first prompt."

`store.ts`: `export type AgentPaneView = "harness" | "chat" | "console"`; `isAgentPaneView` accepts all three; keep the atom default `"chat"` but add `export function defaultAgentPaneView(agentType: string | null | undefined): AgentPaneView { return agentType === "dsh" ? "harness" : "chat"; }` and use it where the atom family is created per agent if the atom exposes a default parameter; otherwise apply it in `agents-view.tsx` when the stored value is unset (read `agentPaneViewAtomFamily` usage there).

`center-tabs.ts`: `export function agentSupportsHarness(agentType) { return agentType === "dsh"; }`.

`agent-pane.tsx`: `AgentViewToggle` takes `harnessEnabled: boolean`; when true the grid is `grid-cols-3`, the indicator is `w-[calc(33.333%-0.25rem)]` translated by `100%+0.25rem` per segment, and a first segment `value="harness"` with the `Fish` icon and label `Harness` (`data-testid="agent-view-harness"`). `AgentPane` renders `<HarnessPane>` when `view === "harness"` and `harnessEnabled`, hidden otherwise, the same way Chat is mounted.

`use-sse.ts`: inside the `chat.changed` branch also `void queryClient.invalidateQueries({ queryKey: harnessTurnsQueryKey(payload.agentId), exact: true })`.

- [ ] **Step 5: Tests for the toggle and pane**

Add to `agent-pane.test.tsx`: with `harnessEnabled`, three segments render and clicking `agent-view-harness` calls `onViewChange("harness")`; without it, two segments. Add `harness-pane.test.tsx`: mock `api` to return one settled turn and assert the prompt text, the collapsed summary "done · 1 step", and the result text render; mock a streaming turn and assert the running glyph and live text.

- [ ] **Step 6: Run, check, finalize**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness src/components/app/agent-pane.test.tsx src/lib && cd ../.. && pnpm run check && pnpm run finalize:web`
Expected: PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(harness): Harness view for dsh agents in the Agent pane

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: End to end, full checks

**Files:**

- Modify: `e2e/dsh-agent.spec.ts`

- [ ] **Step 1: Extend the spec**

After the agent is created and the app loaded, before the Chat assertions:

```ts
await expect(page.getByTestId("agent-view-toggle")).toHaveAttribute(
  "data-view",
  "harness"
);
const harness = page.getByTestId("harness-pane");
await expect(harness).toContainText("List the top-level files");
// The launch prompt ran as the first turn: one tool call then the echo.
await expect(harness.getByRole("button", { name: /done, 1 step/ })).toBeVisible(
  { timeout: 30_000 }
);
await expect(harness).toContainText("You said:");
await page.getByTestId("agent-view-chat").click();
```

(`HarnessPane` root carries `data-testid="harness-pane"`.) Keep the existing Chat assertions after the click.

- [ ] **Step 2: Run the dsh spec live and the suite inert**

Run the dsh spec exactly as in memory `project-dispatch-local-env-quirks` with `DISPATCH_AGENT_RUNTIME=tmux`, then the full suite inert. Then `pnpm run check`, the server suite with `TEST_DATABASE_URL`, and the web suite with the webstorage flag.
Expected: PASS apart from the two Docker-only server tests.

- [ ] **Step 3: Commit**

```bash
git add e2e/dsh-agent.spec.ts
git commit -m "test(harness): Harness view end to end

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Release v0.38.7-dsh.2

- [ ] **Step 1: Bump and note.** Set `0.38.7-dsh.2` in the six package manifests (root, apps/server, apps/web, packages/shared, apps/browser-extension and its `public/manifest.json`; not apps/site), add a "What's Changed" line for the Harness view to `release-notes/current.md`, commit `Release v0.38.7-dsh.2`, tag.
- [ ] **Step 2: Build and swap.** `DISPATCH_BUN_TARGETS=bun-darwin-arm64 pnpm run build:bun`, copy `dist/bun/dispatch-0.38.7-dsh.2-bun-darwin-arm64` over `~/.dispatch/server/dispatch` (keep `dispatch.previous`), update `~/.dispatch/release.json`, `launchctl kickstart -k gui/$(id -u)/com.dispatch.server`, poll health, confirm the restore log line.
- [ ] **Step 3: Live check.** Send one message to the running dsh agent and confirm the Harness view shows the prompt line, the activity block collapsing on settle, and the result. Report to Nii with what to look at.
