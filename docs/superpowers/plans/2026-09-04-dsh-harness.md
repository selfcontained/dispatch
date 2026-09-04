# dsh Harness Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `dsh` as a first-class Dispatch agent type whose process is driven over the Agent Client Protocol, with its stream rendered in the Chat tab, status and tokens derived from the stream, and prompts, messages, and personas delivered through the same path.

**Architecture:** A new server module `apps/server/src/agents/dsh/` owns one `dsh --profile acp` child process per agent over stdio JSON-RPC (ACP), attaches Dispatch's HTTP MCP server at session creation, and folds `session/update` notifications into a new `agent_stream_events` table that the Chat feed reads as a sixth source. The existing tmux setup script still creates the worktree and then drops into a login shell for the Console tab. Everything else (chat, messages, personas, pins, repo tools) reaches the agent through the existing MCP server and the existing `enqueueAgentPrompt` seam, which gains one branch.

**Tech Stack:** TypeScript, Node 22+, Fastify, PostgreSQL, `@agentclientprotocol/sdk@1.4.0`, `yaml@2`, vitest, Playwright, React 18 + Tailwind + shadcn.

**Spec:** `docs/superpowers/specs/2026-09-04-dsh-harness-design.md`

## Global Constraints

- Use `pnpm`, never npm, for every install and script.
- Stay in this worktree. Never `cd` to the parent repo.
- Never run `pnpm run dev`; use the `repo_dev_*` MCP tools for a dev stack.
- Nothing outside `apps/server/src/agents/dsh/` imports `@agentclientprotocol/sdk`.
- No test spawns the real `dsh` binary. Unit tests use an in-memory fake ACP agent; E2E uses a shim on PATH.
- The dsh child is launched with `DSH_PERMISSION_MODE=danger-full-access` (spec decision "Match Claude's permission posture").
- `DSH_HOME` for launched agents defaults to `~/.dispatch/dsh`, never the user's own `~/.dsh`.
- Model ids are `provider/model`, for example `deepseek-official/deepseek-v4-flash`.
- Every `apps/web` change ends with `pnpm run finalize:web`. Every task ends with `pnpm run check`.
- Commit after every task with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.

---

## File map

| File                                                         | Responsibility                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/shared/src/agent-types.ts`                         | add `"dsh"` to `AGENT_TYPES` and `CLI_AGENT_TYPES`                    |
| `packages/shared/src/chat-types.ts`                          | add `ChatAssistantEntry`, `ChatActivityEntry`, extend `ChatFeedEntry` |
| `packages/shared/src/index.ts`                               | export the two new types                                              |
| `apps/server/src/config.ts`                                  | `dshBin`, `dshHome`                                                   |
| `apps/server/src/shared/agent-models.ts`                     | `dsh` catalog entry                                                   |
| `apps/server/src/agents/tmux/command-builder.ts`             | `dsh` launches the login shell                                        |
| `apps/server/src/agents/token-harvester.ts`                  | early return for `dsh`                                                |
| `apps/server/src/db/migrations/0048_agent-stream-events.sql` | new table                                                             |
| `apps/server/src/agents/dsh/stream-store.ts`                 | rows in `agent_stream_events`                                         |
| `apps/server/src/agents/dsh/overlay.ts`                      | per-agent `--patch` YAML                                              |
| `apps/server/src/agents/dsh/driver.ts`                       | ACP client, one child per agent                                       |
| `apps/server/src/agents/dsh/stream-recorder.ts`              | `session/update` to store rows                                        |
| `apps/server/src/agents/dsh/usage-recorder.ts`               | `usage_update` to `agent_token_usage`                                 |
| `apps/server/src/agents/dsh/supervisor.ts`                   | glue: start on setup complete, stop, status, prompt                   |
| `apps/server/src/agents/manager.ts`                          | call the supervisor at lifecycle points                               |
| `apps/server/src/server/agent-prompts.ts`                    | route dsh prompts to the supervisor                                   |
| `apps/server/src/chat/feed.ts`                               | `listStreamEntries` source                                            |
| `apps/web/src/lib/agent-types.ts`                            | label                                                                 |
| `apps/web/src/components/app/agent-type-settings.tsx`        | description                                                           |
| `apps/web/src/components/app/agent-type-icon.tsx`            | icon                                                                  |
| `apps/web/src/components/app/chat/chat-entries.tsx`          | `AssistantEntryView`, `ActivityEntryView`                             |
| `apps/web/src/components/app/chat/chat-feed.tsx`             | render the two new entries                                            |
| `e2e/fixtures/fake-dsh.mjs`                                  | ACP shim on PATH                                                      |
| `e2e/dsh-agent.spec.ts`                                      | end-to-end                                                            |
| `docs/agent-model-catalog.md`                                | dsh section                                                           |

---

### Task 1: Register the `dsh` agent type, config, catalog, and labels

**Files:**

- Modify: `packages/shared/src/agent-types.ts`
- Modify: `apps/server/src/config.ts:18-37` and `:85-97`
- Modify: `apps/server/src/shared/agent-models.ts:27-45`
- Modify: `apps/server/src/agents/tmux/command-builder.ts:540-542`
- Modify: `apps/server/src/agents/token-harvester.ts:317-325`
- Modify: `apps/web/src/lib/agent-types.ts:19-25`
- Modify: `apps/web/src/components/app/agent-type-settings.tsx:16-22`
- Modify: `apps/web/src/components/app/agent-type-icon.tsx:28-48` and the label/icon branches below it
- Modify: `docs/agent-model-catalog.md`
- Test: `apps/server/test/agent-models.test.ts`, `apps/server/test/tmux-command-builder.test.ts`

**Interfaces:**

- Produces: `AgentType` now includes `"dsh"`; `AppConfig.dshBin: string`, `AppConfig.dshHome: string`; `AGENT_MODEL_OPTIONS.dsh` with ids `deepseek-official/deepseek-v4-flash`, `deepseek-official/deepseek-v4-pro`, `openai/gpt-5.2`, `openai/gpt-5.3-codex`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/agent-models.test.ts`:

```ts
describe("dsh catalog", () => {
  it("lists provider-qualified ids for dsh", () => {
    const ids = (AGENT_MODEL_OPTIONS.dsh ?? []).map((o) => o.id);
    expect(ids).toContain("deepseek-official/deepseek-v4-flash");
    expect(ids).toContain("openai/gpt-5.2");
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });
});
```

Append to `apps/server/test/tmux-command-builder.test.ts` (copy the `terminal` case's setup in that file for `config`, `agentId`, and the builder call):

```ts
it("launches dsh agents into a login shell like terminal agents", () => {
  const command = buildAgentCommand({
    ...baseInput,
    type: "dsh",
  });
  expect(command).toContain('"${SHELL:-/bin/bash}" -il');
  expect(command).not.toContain("--mcp-config");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/server exec vitest run test/agent-models.test.ts test/tmux-command-builder.test.ts`
Expected: FAIL. TypeScript rejects `"dsh"` as an `AgentType`; the catalog has no `dsh` key.

- [ ] **Step 3: Add the type**

`packages/shared/src/agent-types.ts`:

```ts
export const AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "dsh",
  "terminal",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const CLI_AGENT_TYPES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "dsh",
] as const;
export type CliAgentType = (typeof CLI_AGENT_TYPES)[number];
```

- [ ] **Step 4: Add config fields**

`apps/server/src/config.ts`. In `AppConfig` after `cursorBin: string;` add:

```ts
/** Path to the `dsh` launcher (DeepSeek Harness). */
dshBin: string;
/** DSH_HOME for agents Dispatch launches; never the user's own ~/.dsh. */
dshHome: string;
```

In the config object after `cursorBin:` add:

```ts
    dshBin: process.env.DISPATCH_DSH_BIN ?? process.env.DSH_BIN ?? "dsh",
    dshHome: resolveConfiguredPath(
      process.env.DISPATCH_DSH_HOME ?? path.join(os.homedir(), ".dispatch", "dsh")
    ),
```

- [ ] **Step 5: Add the catalog entry**

`apps/server/src/shared/agent-models.ts`, inside `AGENT_MODEL_OPTIONS` after the `claude` array:

```ts
  // dsh ids are `provider/model`: the provider is a dsh LLM route name and the
  // model is that route's id. Verified against `dsh --profile acp` session
  // configOptions on 2026-09-04 (see docs/agent-model-catalog.md).
  dsh: [
    { id: "deepseek-official/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "openai/gpt-5.2", label: "GPT-5.2 (OpenAI API key)" },
    { id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex (OpenAI API key)" },
  ],
```

- [ ] **Step 6: Launch command and harvester**

`apps/server/src/agents/tmux/command-builder.ts` line 540: change the terminal branch condition to

```ts
if (type === "terminal" || type === "dsh") {
  return `${envPrefix} "\${SHELL:-/bin/bash}" -il`;
}
```

If `CLI_BY_AGENT_TYPE` is typed as `Record<CliAgentType, ...>`, add `dsh: "dshBin"` to it so the type still checks; the branch above returns before it is read.

`apps/server/src/agents/token-harvester.ts` `harvestTokenUsage`: add before the codex check:

```ts
// dsh usage arrives on the ACP stream (agents/dsh/usage-recorder.ts).
if (agent.type === "dsh") return;
```

- [ ] **Step 7: Web labels and icon**

`apps/web/src/lib/agent-types.ts`:

```ts
export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  dsh: "DSH",
  terminal: "Terminal",
};
```

`apps/web/src/components/app/agent-type-settings.tsx`:

```ts
  dsh: "DeepSeek Harness (dsh) — open-source, model-agnostic, streams into the Chat tab.",
```

`apps/web/src/components/app/agent-type-icon.tsx`: extend the union returned by `normalizeAgentType` with `"dsh"`, add `if (type === "dsh") return "dsh";`, add `dsh` to the label ternary (`"DSH"`), and render it with the same `Terminal`-style glyph path the `terminal` branch uses but with a `--chart-3` stroke. Whatever component the terminal branch returns, copy that JSX for `dsh` and change only the colour token. Do not add an SVG asset.

- [ ] **Step 8: Docs**

Append to `docs/agent-model-catalog.md`:

```md
## dsh (DeepSeek Harness)

Ids are `provider/model`. Evidence bar: the id must appear in the `model`
config option returned by `session/new` on `dsh --profile acp` for the
installed version. Procedure: run the ACP probe (or `dsh --profile acp
--dump-config` plus a `session/new`) and copy the `value` pairs verbatim.
Routes other than `deepseek-official` need their provider declared in the
overlay's `llm-pi-ai` row; `openai` is declared by default.
```

- [ ] **Step 9: Run tests and type check**

Run: `pnpm --filter @dispatch/server exec vitest run test/agent-models.test.ts test/tmux-command-builder.test.ts test/agent-type-settings.test.ts && pnpm run check`
Expected: PASS, no type errors. Fix every exhaustiveness error the compiler raises (any `Record<AgentType, ...>` now needs a `dsh` key).

- [ ] **Step 10: Commit**

```bash
git add -A packages/shared apps/server/src apps/server/test apps/web/src docs/agent-model-catalog.md
git commit -m "feat(dsh): register the dsh agent type, config, and model catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `agent_stream_events` migration and `StreamStore`

**Files:**

- Create: `apps/server/src/db/migrations/0048_agent-stream-events.sql`
- Create: `apps/server/src/agents/dsh/stream-store.ts`
- Test: `apps/server/test/dsh-stream-store.test.ts`

**Interfaces:**

- Produces:

```ts
export type StreamEventKind = "assistant" | "thought" | "tool_call" | "status";
export type StreamEventRow = {
  id: number;
  agentId: string;
  seq: number;
  kind: StreamEventKind;
  key: string | null; // toolCallId for tool_call rows, else null
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};
export class StreamStore {
  constructor(private readonly db: Queryable) {}
  append(
    agentId: string,
    kind: StreamEventKind,
    payload: Record<string, unknown>,
    key?: string | null
  ): Promise<StreamEventRow>;
  upsertByKey(
    agentId: string,
    kind: StreamEventKind,
    key: string,
    payload: Record<string, unknown>
  ): Promise<StreamEventRow>;
  latest(
    agentId: string,
    kind: StreamEventKind
  ): Promise<StreamEventRow | null>;
  updatePayload(id: number, payload: Record<string, unknown>): Promise<void>;
  list(agentId: string, limit: number): Promise<StreamEventRow[]>;
}
```

`Queryable` is the same type `apps/server/src/chat/feed.ts` imports; reuse that import.

- [ ] **Step 1: Write the failing test**

`apps/server/test/dsh-stream-store.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { StreamStore } from "../src/agents/dsh/stream-store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: StreamStore;
const A = "agt_stream_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new StreamStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'Stream A', '/tmp', 'running')`,
    [A]
  );
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_stream_events");
});

describe("StreamStore", () => {
  it("appends rows with a per-agent increasing seq", async () => {
    const a = await store.append(A, "assistant", { text: "hi" });
    const b = await store.append(A, "status", { message: "x" });
    expect(b.seq).toBe(a.seq + 1);
    expect(a.key).toBeNull();
  });

  it("upserts a tool call by key without changing its seq", async () => {
    const first = await store.upsertByKey(A, "tool_call", "call_1", {
      status: "pending",
    });
    const second = await store.upsertByKey(A, "tool_call", "call_1", {
      status: "completed",
    });
    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(second.payload).toEqual({ status: "completed" });
  });

  it("returns the latest row of a kind and updates a payload in place", async () => {
    const row = await store.append(A, "assistant", { text: "a" });
    await store.updatePayload(row.id, { text: "ab" });
    const latest = await store.latest(A, "assistant");
    expect(latest?.id).toBe(row.id);
    expect(latest?.payload).toEqual({ text: "ab" });
  });

  it("lists newest first, bounded by limit", async () => {
    for (let i = 0; i < 5; i++) await store.append(A, "status", { i });
    const rows = await store.list(A, 3);
    expect(rows.map((r) => r.payload.i)).toEqual([4, 3, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-stream-store.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the migration**

`apps/server/src/db/migrations/0048_agent-stream-events.sql`:

```sql
-- Stream events from harnesses Dispatch drives over a protocol (dsh over
-- ACP). One row per assistant message, thought, or tool call; tool calls are
-- rewritten in place as their status changes (key = toolCallId). seq orders
-- rows within one agent and never changes after insert.
CREATE TABLE IF NOT EXISTS agent_stream_events (
  id          bigserial PRIMARY KEY,
  agent_id    text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('assistant','thought','tool_call','status')),
  key         text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_stream_events_agent_key
  ON agent_stream_events (agent_id, kind, key) WHERE key IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_stream_events_agent_created
  ON agent_stream_events (agent_id, created_at DESC, id DESC);
```

- [ ] **Step 4: Write the store**

`apps/server/src/agents/dsh/stream-store.ts`:

```ts
import type { Queryable } from "../../chat/feed.js";

export type StreamEventKind = "assistant" | "thought" | "tool_call" | "status";

export type StreamEventRow = {
  id: number;
  agentId: string;
  seq: number;
  kind: StreamEventKind;
  key: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string | number;
  agent_id: string;
  seq: number;
  kind: StreamEventKind;
  key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

function toRow(r: Row): StreamEventRow {
  return {
    id: Number(r.id),
    agentId: r.agent_id,
    seq: r.seq,
    kind: r.kind,
    key: r.key,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const INSERT = `
  INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload)
  SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4::jsonb
    FROM agent_stream_events WHERE agent_id = $1
  RETURNING *`;

export class StreamStore {
  constructor(private readonly db: Queryable) {}

  async append(
    agentId: string,
    kind: StreamEventKind,
    payload: Record<string, unknown>,
    key: string | null = null
  ): Promise<StreamEventRow> {
    const result = await this.db.query<Row>(INSERT, [
      agentId,
      kind,
      key,
      JSON.stringify(payload),
    ]);
    return toRow(result.rows[0]);
  }

  async upsertByKey(
    agentId: string,
    kind: StreamEventKind,
    key: string,
    payload: Record<string, unknown>
  ): Promise<StreamEventRow> {
    const existing = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events WHERE agent_id = $1 AND kind = $2 AND key = $3`,
      [agentId, kind, key]
    );
    if (existing.rows[0]) {
      const updated = await this.db.query<Row>(
        `UPDATE agent_stream_events SET payload = $2::jsonb, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [existing.rows[0].id, JSON.stringify(payload)]
      );
      return toRow(updated.rows[0]);
    }
    return this.append(agentId, kind, payload, key);
  }

  async latest(
    agentId: string,
    kind: StreamEventKind
  ): Promise<StreamEventRow | null> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events WHERE agent_id = $1 AND kind = $2
        ORDER BY seq DESC LIMIT 1`,
      [agentId, kind]
    );
    return result.rows[0] ? toRow(result.rows[0]) : null;
  }

  async updatePayload(
    id: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_stream_events SET payload = $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, JSON.stringify(payload)]
    );
  }

  async list(agentId: string, limit: number): Promise<StreamEventRow[]> {
    const result = await this.db.query<Row>(
      `SELECT * FROM agent_stream_events WHERE agent_id = $1
        ORDER BY seq DESC LIMIT $2`,
      [agentId, limit]
    );
    return result.rows.map(toRow);
  }
}
```

If `Queryable` is not exported from `feed.ts`, export it there (it is a `{ query<T>(text, params) }` shape over `Pool`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-stream-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrations/0048_agent-stream-events.sql apps/server/src/agents/dsh/stream-store.ts apps/server/test/dsh-stream-store.test.ts apps/server/src/chat/feed.ts
git commit -m "feat(dsh): agent_stream_events table and StreamStore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Chat feed entries for stream rows

**Files:**

- Modify: `packages/shared/src/chat-types.ts:117-190`
- Modify: `packages/shared/src/index.ts` (export the new types)
- Modify: `apps/server/src/chat/feed.ts:58-75` (`isValidCursorId`), `:180-216` (add source next to it), `:411-450` (`composeChatFeed`)
- Test: `apps/server/test/chat-feed.test.ts`

**Interfaces:**

- Consumes: `StreamStore` rows from Task 2 (read via SQL here, not via the class).
- Produces:

```ts
export type ChatAssistantEntry = {
  type: "assistant";
  id: string; // `stream:<row id>`
  text: string;
  streaming: boolean;
  at: string;
};
export type ChatActivityEntry = {
  type: "activity";
  id: string; // `stream:<row id>`
  toolKind: string; // ACP ToolKind or "other"
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: { path: string; line?: number }[];
  diff: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput: string | null;
  at: string;
};
```

`ChatFeedEntry` gains both. Cursor `type` for either is `"assistant"` / `"activity"` with an int id.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/chat-feed.test.ts` (the file already sets up `pool`, `store`, and agent `A`; add `agent_stream_events` to the `beforeEach` DELETE list):

```ts
describe("stream sources", () => {
  it("surfaces assistant and tool_call rows as assistant and activity entries", async () => {
    await pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload) VALUES
        ($1, 1, 'assistant', NULL, '{"text":"Reading files","streaming":false}'),
        ($1, 2, 'tool_call', 'call_1', '{"toolKind":"read","title":"Read README.md","status":"completed","locations":[{"path":"/w/README.md"}],"diff":null,"terminalOutput":null}'),
        ($1, 3, 'thought', NULL, '{"text":"hmm"}')`,
      [A]
    );
    const feed = await composeChatFeed(store, A);
    const types = feed.entries.map((e) => e.type);
    expect(types).toEqual(["assistant", "activity"]);
    const activity = feed.entries[1];
    if (activity.type !== "activity") throw new Error("expected activity");
    expect(activity.title).toBe("Read README.md");
    expect(activity.status).toBe("completed");
    expect(activity.locations).toEqual([{ path: "/w/README.md" }]);
  });

  it("pages across stream entries with the cursor", async () => {
    for (let i = 1; i <= 4; i++) {
      await pool.query(
        `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
         VALUES ($1, $2, 'assistant', $3::jsonb)`,
        [A, i, JSON.stringify({ text: `m${i}`, streaming: false })]
      );
    }
    const page1 = await composeChatFeed(store, A, { limit: 2 });
    expect(page1.hasMore).toBe(true);
    const page2 = await composeChatFeed(store, A, {
      limit: 2,
      cursor: decodeFeedCursor(page1.nextCursor!),
    });
    const texts = [...page2.entries, ...page1.entries].map((e) =>
      e.type === "assistant" ? e.text : ""
    );
    expect(texts).toEqual(["m1", "m2", "m3", "m4"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/server exec vitest run test/chat-feed.test.ts`
Expected: FAIL. Entries are missing; the cursor type is rejected.

- [ ] **Step 3: Add the shared types**

`packages/shared/src/chat-types.ts`, after `ChatReviewEntry`:

```ts
/** One assistant message from a stream-driven harness (dsh over ACP). */
export type ChatAssistantEntry = {
  type: "assistant";
  id: string;
  text: string;
  /** True while chunks are still arriving for this message. */
  streaming: boolean;
  at: string;
};

export type ChatActivityStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

/** One tool call from a stream-driven harness, rewritten in place as it settles. */
export type ChatActivityEntry = {
  type: "activity";
  id: string;
  toolKind: string;
  title: string;
  status: ChatActivityStatus;
  locations: { path: string; line?: number }[];
  diff: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput: string | null;
  at: string;
};
```

Extend the union:

```ts
export type ChatFeedEntry =
  | ChatMessageEntry
  | ChatStatusEntry
  | ChatAgentMessageEntry
  | ChatMediaEntry
  | ChatReviewEntry
  | ChatAssistantEntry
  | ChatActivityEntry;
```

Add `ChatActivityEntry`, `ChatActivityStatus`, `ChatAssistantEntry` to the `chat-types.js` type export list in `packages/shared/src/index.ts`.

- [ ] **Step 4: Add the feed source**

In `apps/server/src/chat/feed.ts`, add `"assistant"` and `"activity"` to whatever `isValidCursorId` treats as integer ids (the same branch `status` uses). Then add next to `listStatusEntries`:

```ts
type StreamPayload = {
  text?: string;
  streaming?: boolean;
  toolKind?: string;
  title?: string;
  status?: ChatActivityStatus;
  locations?: { path: string; line?: number }[];
  diff?: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput?: string | null;
};

async function listStreamEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatAssistantEntry | ChatActivityEntry>[]> {
  const params: unknown[] = [agentId];
  // Both entry types share one source; the cursor clause keys on either.
  const clause =
    cursor && (cursor.type === "assistant" || cursor.type === "activity")
      ? cursorClause(cursor.type, "int", cursor, params)
      : cursorClause("assistant", "int", cursor, params);
  params.push(limit);
  const result = await db.query<{
    id: number;
    kind: string;
    payload: StreamPayload;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, kind, payload, created_at, ${AT_KEY_SQL} AS at_key
       FROM agent_stream_events
      WHERE agent_id = $1 AND kind IN ('assistant','tool_call') ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => {
    const at = row.created_at.toISOString();
    const entry: ChatAssistantEntry | ChatActivityEntry =
      row.kind === "assistant"
        ? {
            type: "assistant",
            id: `stream:${row.id}`,
            text: row.payload.text ?? "",
            streaming: row.payload.streaming === true,
            at,
          }
        : {
            type: "activity",
            id: `stream:${row.id}`,
            toolKind: row.payload.toolKind ?? "other",
            title: row.payload.title ?? "",
            status: row.payload.status ?? "pending",
            locations: row.payload.locations ?? [],
            diff: row.payload.diff ?? null,
            terminalOutput: row.payload.terminalOutput ?? null,
            at,
          };
    return {
      entry,
      atKey: row.at_key,
      rawId: String(row.id),
      idKey: intKey(row.id),
    };
  });
}
```

Read `cursorClause`'s signature before calling it; if its first parameter is the alias rather than the type, pass what `listStatusEntries` passes. In `composeChatFeed` add `listStreamEntries(db, agentId, cursor, limit + 1)` to the `Promise.all` and spread its result into `merged`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dispatch/server exec vitest run test/chat-feed.test.ts && pnpm run check`
Expected: PASS. The web build will fail on the exhaustive `switch` in `chat-feed.tsx`; that is fixed in Task 9. If `pnpm run check` fails only there, note it and continue.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src apps/server/src/chat/feed.ts apps/server/test/chat-feed.test.ts
git commit -m "feat(dsh): assistant and activity chat feed entries from stream rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Per-agent overlay builder

**Files:**

- Create: `apps/server/src/agents/dsh/overlay.ts`
- Test: `apps/server/test/dsh-overlay.test.ts`

**Interfaces:**

- Produces:

```ts
export type OverlayInput = {
  model: string | null; // "provider/model" or null for the profile default
  persona: string; // full system prompt persona text (launch guidance + persona brief + personality)
  providers?: Record<string, ProviderRoute>; // extra llm-pi-ai routes; default { openai: { apiKeyEnv: "OPENAI_API_KEY" } }
};
export type ProviderRoute = {
  apiKeyEnv?: string;
  baseURL?: string;
  api?: string;
  displayName?: string;
  models?: { id: string; contextWindow?: number }[];
};
export function splitModelId(model: string): {
  provider: string;
  model: string;
};
export function buildOverlayYaml(input: OverlayInput): string;
export async function writeOverlay(
  dir: string,
  agentId: string,
  input: OverlayInput
): Promise<string>; // returns file path
```

- [ ] **Step 1: Write the failing test**

`apps/server/test/dsh-overlay.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOverlayYaml,
  splitModelId,
  writeOverlay,
} from "../src/agents/dsh/overlay.js";

describe("splitModelId", () => {
  it("splits provider/model", () => {
    expect(splitModelId("openai/gpt-5.2")).toEqual({
      provider: "openai",
      model: "gpt-5.2",
    });
  });
  it("rejects ids without a slash", () => {
    expect(() => splitModelId("gpt-5.2")).toThrow("provider/model");
  });
});

describe("buildOverlayYaml", () => {
  it("emits llm routes, persona, and default model rows", () => {
    const rows = parse(
      buildOverlayYaml({
        model: "openai/gpt-5.2",
        persona: "You are {{model}} in {{cwd}}.",
      })
    ) as { id: string; config: Record<string, unknown> }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.config]));
    expect(byId["llm-pi-ai"]).toEqual({
      providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } },
    });
    expect(byId["system-prompt"]).toEqual({
      persona: "You are {{model}} in {{cwd}}.",
    });
    expect(byId["agent-default-model"]).toEqual({
      provider: "openai",
      model: "gpt-5.2",
    });
    expect(byId["acp"]).toEqual({ provider: "openai", model: "gpt-5.2" });
  });

  it("omits model rows when no model is chosen", () => {
    const rows = parse(buildOverlayYaml({ model: null, persona: "p" })) as {
      id: string;
    }[];
    expect(rows.map((r) => r.id)).toEqual(["llm-pi-ai", "system-prompt"]);
  });
});

describe("writeOverlay", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it("writes <dir>/<agentId>.patch.yml", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dsh-overlay-"));
    const file = await writeOverlay(dir, "agt_1", {
      model: null,
      persona: "p",
    });
    expect(file).toBe(path.join(dir, "agt_1.patch.yml"));
    expect(await readFile(file, "utf8")).toContain("system-prompt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-overlay.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the builder**

`apps/server/src/agents/dsh/overlay.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

export type ProviderRoute = {
  apiKeyEnv?: string;
  baseURL?: string;
  api?: string;
  displayName?: string;
  models?: { id: string; contextWindow?: number }[];
};

export type OverlayInput = {
  model: string | null;
  persona: string;
  providers?: Record<string, ProviderRoute>;
};

const DEFAULT_PROVIDERS: Record<string, ProviderRoute> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY" },
};

export function splitModelId(model: string): {
  provider: string;
  model: string;
} {
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) {
    throw new Error(`dsh model ids are provider/model; got "${model}"`);
  }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

/**
 * The per-agent `--patch` layer. Each entry replaces the config of the row
 * with that id in the composed acp profile (see the spec's verified facts).
 */
export function buildOverlayYaml(input: OverlayInput): string {
  const rows: { id: string; config: Record<string, unknown> }[] = [
    {
      id: "llm-pi-ai",
      config: { providers: input.providers ?? DEFAULT_PROVIDERS },
    },
    { id: "system-prompt", config: { persona: input.persona } },
  ];
  if (input.model) {
    const selected = splitModelId(input.model);
    rows.push({ id: "agent-default-model", config: selected });
    rows.push({ id: "acp", config: selected });
  }
  return stringify(rows);
}

export async function writeOverlay(
  dir: string,
  agentId: string,
  input: OverlayInput
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agentId}.patch.yml`);
  await writeFile(file, buildOverlayYaml(input), "utf8");
  return file;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agents/dsh/overlay.ts apps/server/test/dsh-overlay.test.ts
git commit -m "feat(dsh): per-agent profile overlay builder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `DshDriver` over ACP

**Files:**

- Modify: `apps/server/package.json` (add `@agentclientprotocol/sdk`)
- Create: `apps/server/src/agents/dsh/driver.ts`
- Create: `apps/server/test/helpers/fake-acp-agent.ts`
- Test: `apps/server/test/dsh-driver.test.ts`

**Interfaces:**

- Produces:

```ts
export type DriverLaunch = {
  agentId: string;
  cwd: string;
  overlayPath: string;
  mcp: { url: string; token: string };
  sessionId: string | null; // resume when set
  env: NodeJS.ProcessEnv;
};
export type DriverUpdate = import("@agentclientprotocol/sdk").SessionUpdate; // re-exported as a type only from this module
export type DriverEvent =
  | { type: "update"; agentId: string; update: DriverUpdate }
  | {
      type: "turn";
      agentId: string;
      state: "started" | "settled";
      stopReason?: string;
      error?: string;
    }
  | {
      type: "exit";
      agentId: string;
      code: number | null;
      signal: string | null;
      stderrTail: string;
    };
export type DriverListener = (event: DriverEvent) => void;

export class DshDriver {
  constructor(opts: {
    dshBin: string;
    dshHome: string;
    spawn?: SpawnFn;
    logger: Logger;
  });
  onEvent(listener: DriverListener): () => void;
  start(launch: DriverLaunch): Promise<{ sessionId: string }>;
  prompt(agentId: string, text: string): Promise<void>; // resolves when the turn settles
  cancel(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>; // close session, then teardown ladder
  isRunning(agentId: string): boolean;
}
```

`SpawnFn` is `(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessLike` where `ChildProcessLike` has `stdin`, `stdout`, `stderr`, `on("exit")`, `kill()`. Tests inject a spawn that returns an in-process fake agent.

- [ ] **Step 1: Install the SDK**

Run: `pnpm --filter @dispatch/server add @agentclientprotocol/sdk@1.4.0`
Expected: `apps/server/package.json` lists it; lockfile updated.

- [ ] **Step 2: Write the fake agent helper**

`apps/server/test/helpers/fake-acp-agent.ts`:

```ts
import { PassThrough } from "node:stream";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import * as acp from "@agentclientprotocol/sdk";

export type FakeTurn = (
  prompt: string,
  emit: (update: acp.SessionUpdate) => Promise<void>
) => Promise<acp.StopReason>;

/**
 * An in-process ACP agent wired to a ChildProcess-like object. The driver's
 * injected `spawn` returns `child`; the fake agent speaks on the other ends.
 */
export function createFakeAcpAgent(
  opts: { turn?: FakeTurn; resumeSessionId?: string } = {}
) {
  const toAgent = new PassThrough(); // driver stdin  -> agent input
  const fromAgent = new PassThrough(); // agent output  -> driver stdout
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: toAgent,
    stdout: fromAgent,
    stderr,
    killed: false,
    kill(signal?: string) {
      this.killed = true;
      queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
      return true;
    },
  });
  const seen = {
    newSession: [] as acp.NewSessionRequest[],
    prompts: [] as string[],
    cancels: 0,
    closes: 0,
  };
  let sessionCounter = 0;
  let connection: acp.AgentSideConnection;

  const agent: acp.Agent = {
    async initialize() {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { close: {}, resume: {} },
        },
        authMethods: [],
      };
    },
    async newSession(params) {
      seen.newSession.push(params);
      return { sessionId: `sess_${++sessionCounter}`, configOptions: [] };
    },
    async resumeSession(params) {
      return { sessionId: params.sessionId, configOptions: [] };
    },
    async prompt(params) {
      const text = params.prompt
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      seen.prompts.push(text);
      const emit = (update: acp.SessionUpdate) =>
        connection.sessionUpdate({ sessionId: params.sessionId, update });
      const stopReason = opts.turn ? await opts.turn(text, emit) : "end_turn";
      return { stopReason };
    },
    async cancel() {
      seen.cancels += 1;
    },
    async closeSession() {
      seen.closes += 1;
      return {};
    },
    async authenticate() {
      return {};
    },
  };

  const stream = acp.ndJsonStream(
    Writable.toWeb(fromAgent),
    Readable.toWeb(toAgent)
  );
  connection = new acp.AgentSideConnection(() => agent, stream);
  return { child, seen, stderr };
}
```

If the SDK's `Agent` interface names the resume/close methods differently (`resumeSession`, `closeSession`, or `unstable_*`), match the names in `acp.d.ts` for 1.4.0; the driver must call the same ones.

- [ ] **Step 3: Write the failing driver test**

`apps/server/test/dsh-driver.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DshDriver, type DriverEvent } from "../src/agents/dsh/driver.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function launch(agentId = "agt_1") {
  return {
    agentId,
    cwd: "/tmp/w",
    overlayPath: "/tmp/w/agt_1.patch.yml",
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    sessionId: null,
    env: { PATH: "/usr/bin" },
  };
}

describe("DshDriver", () => {
  it("spawns dsh with the acp profile, overlay, cwd, env, and attaches the MCP server", async () => {
    const fake = createFakeAcpAgent();
    const spawn = vi.fn(() => fake.child);
    const driver = new DshDriver({
      dshBin: "/bin/dsh",
      dshHome: "/home/dsh",
      spawn,
      logger,
    });
    const { sessionId } = await driver.start(launch());
    expect(sessionId).toBe("sess_1");
    expect(spawn).toHaveBeenCalledWith(
      "/bin/dsh",
      ["--profile", "acp", "--patch", "/tmp/w/agt_1.patch.yml"],
      expect.objectContaining({
        cwd: "/tmp/w",
        env: expect.objectContaining({
          DSH_HOME: "/home/dsh",
          DSH_PERMISSION_MODE: "danger-full-access",
          PATH: "/usr/bin",
        }),
      })
    );
    const req = fake.seen.newSession[0];
    expect(req.cwd).toBe("/tmp/w");
    expect(req.mcpServers).toEqual([
      {
        type: "http",
        name: "dispatch",
        url: "http://127.0.0.1:1/api/mcp/agt_1",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ]);
  });

  it("forwards updates and turn boundaries while a prompt runs", async () => {
    const fake = createFakeAcpAgent({
      turn: async (_p, emit) => {
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        });
        return "end_turn";
      },
    });
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.prompt("agt_1", "hello");
    expect(fake.seen.prompts).toEqual(["hello"]);
    expect(events.map((e) => e.type)).toEqual(["turn", "update", "turn"]);
    expect(events[2]).toMatchObject({
      type: "turn",
      state: "settled",
      stopReason: "end_turn",
    });
  });

  it("resumes when a session id is given", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const { sessionId } = await driver.start({
      ...launch(),
      sessionId: "sess_prev",
    });
    expect(sessionId).toBe("sess_prev");
    expect(fake.seen.newSession).toHaveLength(0);
  });

  it("stop closes the session and reaps the child", async () => {
    const fake = createFakeAcpAgent();
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await driver.stop("agt_1");
    expect(fake.seen.closes).toBe(1);
    expect(driver.isRunning("agt_1")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "exit", agentId: "agt_1" });
  });

  it("a prompt rejected by the agent settles the turn with an error", async () => {
    const fake = createFakeAcpAgent({
      turn: async () => {
        throw new Error("no API key");
      },
    });
    const driver = new DshDriver({
      dshBin: "dsh",
      dshHome: "/h",
      spawn: () => fake.child,
      logger,
    });
    const events: DriverEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start(launch());
    await expect(driver.prompt("agt_1", "x")).rejects.toThrow(/no API key/);
    expect(events.at(-1)).toMatchObject({
      type: "turn",
      state: "settled",
      error: expect.stringContaining("no API key"),
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-driver.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Write the driver**

`apps/server/src/agents/dsh/driver.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type DriverUpdate = acp.SessionUpdate;

export type DriverLaunch = {
  agentId: string;
  cwd: string;
  overlayPath: string;
  mcp: { url: string; token: string };
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
};

export type DriverEvent =
  | { type: "update"; agentId: string; update: DriverUpdate }
  | {
      type: "turn";
      agentId: string;
      state: "started" | "settled";
      stopReason?: string;
      error?: string;
    }
  | {
      type: "exit";
      agentId: string;
      code: number | null;
      signal: string | null;
      stderrTail: string;
    };

export type DriverListener = (event: DriverEvent) => void;

type Logger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
};

export type ChildProcessLike = Pick<
  ChildProcess,
  "stdin" | "stdout" | "stderr" | "on" | "kill" | "killed"
>;
export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessLike;

type Live = {
  child: ChildProcessLike;
  conn: acp.ClientSideConnection;
  sessionId: string;
  stderrTail: string[];
  exited: Promise<{ code: number | null; signal: string | null }>;
};

const STDERR_TAIL_LINES = 20;
const TEARDOWN_STEP_MS = 1500;

export class DshDriver {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<DriverListener>();
  private readonly spawnFn: SpawnFn;

  constructor(
    private readonly opts: {
      dshBin: string;
      dshHome: string;
      spawn?: SpawnFn;
      logger: Logger;
    }
  ) {
    this.spawnFn =
      opts.spawn ??
      ((bin, args, o) =>
        nodeSpawn(bin, args, { ...o, stdio: ["pipe", "pipe", "pipe"] }));
  }

  onEvent(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: DriverEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.opts.logger.warn({ err }, "dsh driver listener threw");
      }
    }
  }

  isRunning(agentId: string): boolean {
    return this.live.has(agentId);
  }

  async start(launch: DriverLaunch): Promise<{ sessionId: string }> {
    if (this.live.has(launch.agentId)) {
      throw new Error(`dsh already running for ${launch.agentId}`);
    }
    const child = this.spawnFn(
      this.opts.dshBin,
      ["--profile", "acp", "--patch", launch.overlayPath],
      {
        cwd: launch.cwd,
        env: {
          ...launch.env,
          DSH_HOME: this.opts.dshHome,
          DSH_PERMISSION_MODE: "danger-full-access",
        },
      }
    );
    const stderrTail: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.on("exit", (code, signal) =>
          resolve({ code, signal: signal ?? null })
        );
      }
    );

    const client: acp.Client = {
      sessionUpdate: async (params) => {
        this.emit({
          type: "update",
          agentId: launch.agentId,
          update: params.update,
        });
      },
      // Permission prompts never fire under danger-full-access; answer allow if one does.
      requestPermission: async (params) => {
        const allow =
          params.options.find((o) => o.kind === "allow_once") ??
          params.options[0];
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      },
    };
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!)
    );
    const conn = new acp.ClientSideConnection(() => client, stream);

    try {
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      });
      const mcpServers: acp.McpServer[] = [
        {
          type: "http",
          name: "dispatch",
          url: launch.mcp.url,
          headers: [
            { name: "Authorization", value: `Bearer ${launch.mcp.token}` },
          ],
        },
      ];
      let sessionId: string;
      if (launch.sessionId) {
        const res = await conn.resumeSession({
          sessionId: launch.sessionId,
          cwd: launch.cwd,
          mcpServers,
        });
        sessionId = res.sessionId ?? launch.sessionId;
      } else {
        const res = await conn.newSession({ cwd: launch.cwd, mcpServers });
        sessionId = res.sessionId;
      }
      const entry: Live = { child, conn, sessionId, stderrTail, exited };
      this.live.set(launch.agentId, entry);
      void exited.then(({ code, signal }) => {
        if (this.live.get(launch.agentId) === entry)
          this.live.delete(launch.agentId);
        this.emit({
          type: "exit",
          agentId: launch.agentId,
          code,
          signal,
          stderrTail: stderrTail.join("\n"),
        });
      });
      return { sessionId };
    } catch (err) {
      child.kill("SIGKILL");
      throw new Error(
        `dsh start failed: ${(err as Error).message}${stderrTail.length ? `\n${stderrTail.join("\n")}` : ""}`
      );
    }
  }

  async prompt(agentId: string, text: string): Promise<void> {
    const entry = this.require(agentId);
    this.emit({ type: "turn", agentId, state: "started" });
    try {
      const res = await entry.conn.prompt({
        sessionId: entry.sessionId,
        prompt: [{ type: "text", text }],
      });
      this.emit({
        type: "turn",
        agentId,
        state: "settled",
        stopReason: res.stopReason,
      });
    } catch (err) {
      const message = (err as Error).message;
      this.emit({ type: "turn", agentId, state: "settled", error: message });
      throw err;
    }
  }

  async cancel(agentId: string): Promise<void> {
    const entry = this.require(agentId);
    await entry.conn.cancel({ sessionId: entry.sessionId });
  }

  async stop(agentId: string): Promise<void> {
    const entry = this.live.get(agentId);
    if (!entry) return;
    try {
      await Promise.race([
        entry.conn.closeSession({ sessionId: entry.sessionId }),
        new Promise((r) => setTimeout(r, TEARDOWN_STEP_MS)),
      ]);
    } catch (err) {
      this.opts.logger.debug(
        { err, agentId },
        "dsh session close failed; continuing teardown"
      );
    }
    entry.child.stdin?.end();
    const exitedIn = (ms: number) =>
      Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
      ]);
    if (!(await exitedIn(TEARDOWN_STEP_MS))) entry.child.kill("SIGTERM");
    if (!(await exitedIn(TEARDOWN_STEP_MS))) entry.child.kill("SIGKILL");
    await entry.exited;
    this.live.delete(agentId);
  }

  private require(agentId: string): Live {
    const entry = this.live.get(agentId);
    if (!entry) throw new Error(`dsh is not running for ${agentId}`);
    return entry;
  }
}
```

Check `acp.d.ts` for the exact client-side method names for resume and close in 1.4.0 (`resumeSession`/`closeSession`, possibly prefixed `unstable_`) and for whether `resumeSession` takes `mcpServers`; adjust both the driver and the fake agent together.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-driver.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/agents/dsh/driver.ts apps/server/test/helpers/fake-acp-agent.ts apps/server/test/dsh-driver.test.ts
git commit -m "feat(dsh): ACP driver with one child process per agent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Stream recorder and usage recorder

**Files:**

- Create: `apps/server/src/agents/dsh/stream-recorder.ts`
- Create: `apps/server/src/agents/dsh/usage-recorder.ts`
- Test: `apps/server/test/dsh-stream-recorder.test.ts`, `apps/server/test/dsh-usage-recorder.test.ts`

**Interfaces:**

- Consumes: `StreamStore` (Task 2), `DriverEvent` (Task 5).
- Produces:

```ts
export class StreamRecorder {
  constructor(store: StreamStore);
  handle(event: DriverEvent): Promise<void>;
}
export class UsageRecorder {
  constructor(db: Queryable);
  handle(
    event: DriverEvent,
    ctx: { sessionId: string; model: string }
  ): Promise<void>;
}
```

`StreamRecorder` payload shapes written to the store:

- `assistant`: `{ text, streaming }`; chunks append to the latest streaming row; a non-chunk update or a settled turn flips `streaming: false`.
- `thought`: `{ text }`, same accumulation.
- `tool_call` (key = toolCallId): `{ toolKind, title, status, locations, diff, terminalOutput }`; `tool_call_update` merges fields present in the update.
- `status`: `{ message }` for a settled turn with an error, or an exit with non-zero code.

- [ ] **Step 1: Write the failing recorder test**

`apps/server/test/dsh-stream-recorder.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { StreamRecorder } from "../src/agents/dsh/stream-recorder.js";
import { StreamStore } from "../src/agents/dsh/stream-store.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: StreamStore;
const A = "agt_rec_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new StreamStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'R', '/tmp', 'running')`,
    [A]
  );
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_stream_events");
});

const chunk = (text: string) => ({
  type: "update" as const,
  agentId: A,
  update: {
    sessionUpdate: "agent_message_chunk" as const,
    content: { type: "text" as const, text },
  },
});

describe("StreamRecorder", () => {
  it("accumulates chunks into one assistant row and settles it at turn end", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({ type: "turn", agentId: A, state: "started" });
    await rec.handle(chunk("Hel"));
    await rec.handle(chunk("lo"));
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      stopReason: "end_turn",
    });
    const rows = await store.list(A, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ text: "Hello", streaming: false });
  });

  it("starts a new assistant row after a tool call interrupts the text", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle(chunk("one"));
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Read x",
        kind: "read",
        status: "pending",
        locations: [{ path: "/w/x" }],
        content: [],
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "diff", path: "/w/x", oldText: "a", newText: "b" }],
      },
    });
    await rec.handle(chunk("two"));
    const rows = (await store.list(A, 10)).reverse();
    expect(rows.map((r) => r.kind)).toEqual([
      "assistant",
      "tool_call",
      "assistant",
    ]);
    expect(rows[0].payload).toEqual({ text: "one", streaming: false });
    expect(rows[1].payload).toMatchObject({
      toolKind: "read",
      title: "Read x",
      status: "completed",
      locations: [{ path: "/w/x" }],
      diff: { path: "/w/x", oldText: "a", newText: "b" },
    });
    expect(rows[2].payload).toEqual({ text: "two", streaming: true });
  });

  it("records a settled error and a crash as status rows", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: "no API key",
    });
    await rec.handle({
      type: "exit",
      agentId: A,
      code: 1,
      signal: null,
      stderrTail: "boom",
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows.map((r) => r.payload.message)).toEqual([
      "no API key",
      "dsh exited with code 1: boom",
    ]);
  });
});
```

- [ ] **Step 2: Write the failing usage test**

`apps/server/test/dsh-usage-recorder.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { UsageRecorder } from "../src/agents/dsh/usage-recorder.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const A = "agt_usage_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'U', '/tmp', 'running')`,
    [A]
  );
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_token_usage WHERE agent_id = $1", [A]);
});

describe("UsageRecorder", () => {
  it("upserts cumulative totals per agent, session, and model", async () => {
    const rec = new UsageRecorder(pool);
    const ctx = { sessionId: "sess_1", model: "openai/gpt-5.2" };
    const usage = (input: number, output: number) => ({
      type: "update" as const,
      agentId: A,
      update: {
        sessionUpdate: "usage_update" as const,
        used: input + output,
        size: 200000,
        usage: { input, output, thought: 0, cache_read: 5, cache_write: 1 },
      },
    });
    await rec.handle(usage(100, 10), ctx);
    await rec.handle(usage(250, 40), ctx);
    const rows = await pool.query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, message_count
         FROM agent_token_usage WHERE agent_id = $1 AND session_id = $2 AND model = $3`,
      [A, "sess_1", "openai/gpt-5.2"]
    );
    expect(rows.rows).toEqual([
      {
        input_tokens: 250,
        output_tokens: 40,
        cache_read_tokens: 5,
        cache_creation_tokens: 1,
        message_count: 2,
      },
    ]);
  });

  it("ignores non-usage updates", async () => {
    const rec = new UsageRecorder(pool);
    await rec.handle(
      { type: "turn", agentId: A, state: "started" },
      { sessionId: "s", model: "m" }
    );
    const rows = await pool.query(
      `SELECT 1 FROM agent_token_usage WHERE agent_id = $1`,
      [A]
    );
    expect(rows.rowCount).toBe(0);
  });
});
```

Read the `Usage` type in the SDK's `types.gen.d.ts` (search `export type Usage`) and match the field names exactly in both the test and the recorder. The column names above come from `UPSERT_SQL` in `token-harvester.ts`; check the table for `NOT NULL` columns (`session_start`, `session_end`) and supply `NOW()` for them.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-stream-recorder.test.ts test/dsh-usage-recorder.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write the stream recorder**

`apps/server/src/agents/dsh/stream-recorder.ts`:

```ts
import type { DriverEvent, DriverUpdate } from "./driver.js";
import type { StreamEventRow, StreamStore } from "./stream-store.js";

type OpenText = { row: StreamEventRow; text: string };

type ToolPayload = {
  toolKind: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: { path: string; line?: number }[];
  diff: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput: string | null;
};

function textOf(content: { type: string; text?: string } | undefined): string {
  return content && content.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

function projectToolContent(content: unknown[] | undefined): {
  diff: ToolPayload["diff"];
  terminalOutput: string | null;
} {
  let diff: ToolPayload["diff"] = null;
  let terminalOutput: string | null = null;
  for (const item of content ?? []) {
    const c = item as {
      type: string;
      path?: string;
      oldText?: string | null;
      newText?: string;
      content?: { type: string; text?: string };
    };
    if (c.type === "diff" && c.path && typeof c.newText === "string") {
      diff = { path: c.path, oldText: c.oldText ?? null, newText: c.newText };
    } else if (c.type === "content" && c.content?.type === "text") {
      terminalOutput = (terminalOutput ?? "") + (c.content.text ?? "");
    }
  }
  return { diff, terminalOutput };
}

/** Folds driver events into agent_stream_events rows. One instance per server; state is per agent. */
export class StreamRecorder {
  private readonly open = new Map<
    string,
    { assistant?: OpenText; thought?: OpenText }
  >();

  constructor(private readonly store: StreamStore) {}

  async handle(event: DriverEvent): Promise<void> {
    if (event.type === "update")
      return this.handleUpdate(event.agentId, event.update);
    if (event.type === "turn") {
      if (event.state === "settled") {
        await this.closeText(event.agentId);
        if (event.error)
          await this.store.append(event.agentId, "status", {
            message: event.error,
          });
      }
      return;
    }
    if (event.type === "exit") {
      await this.closeText(event.agentId);
      if (event.code !== 0) {
        const detail = event.stderrTail ? `: ${event.stderrTail}` : "";
        await this.store.append(event.agentId, "status", {
          message: `dsh exited with ${event.code === null ? `signal ${event.signal}` : `code ${event.code}`}${detail}`,
        });
      }
    }
  }

  private async handleUpdate(
    agentId: string,
    update: DriverUpdate
  ): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.appendText(agentId, "assistant", textOf(update.content));
      case "agent_thought_chunk":
        return this.appendText(agentId, "thought", textOf(update.content));
      case "tool_call": {
        await this.closeText(agentId);
        const { diff, terminalOutput } = projectToolContent(update.content);
        const payload: ToolPayload = {
          toolKind: update.kind ?? "other",
          title: update.title,
          status: update.status ?? "pending",
          locations: (update.locations ?? []).map((l) => ({
            path: l.path,
            ...(l.line != null ? { line: l.line } : {}),
          })),
          diff,
          terminalOutput,
        };
        await this.store.upsertByKey(
          agentId,
          "tool_call",
          update.toolCallId,
          payload
        );
        return;
      }
      case "tool_call_update": {
        const existing = await this.store.upsertByKey(
          agentId,
          "tool_call",
          update.toolCallId,
          {}
        );
        const prev = existing.payload as Partial<ToolPayload>;
        const projected = update.content
          ? projectToolContent(update.content)
          : null;
        const next: ToolPayload = {
          toolKind: update.kind ?? prev.toolKind ?? "other",
          title: update.title ?? prev.title ?? "",
          status: update.status ?? prev.status ?? "pending",
          locations: update.locations
            ? update.locations.map((l) => ({
                path: l.path,
                ...(l.line != null ? { line: l.line } : {}),
              }))
            : (prev.locations ?? []),
          diff: projected?.diff ?? prev.diff ?? null,
          terminalOutput:
            projected?.terminalOutput ?? prev.terminalOutput ?? null,
        };
        await this.store.updatePayload(existing.id, next);
        return;
      }
      default:
        return;
    }
  }

  private async appendText(
    agentId: string,
    kind: "assistant" | "thought",
    delta: string
  ): Promise<void> {
    if (!delta) return;
    const state = this.open.get(agentId) ?? {};
    const other = kind === "assistant" ? "thought" : "assistant";
    if (state[other]) await this.closeText(agentId, other);
    let current = state[kind];
    if (!current) {
      const row = await this.store.append(
        agentId,
        kind,
        kind === "assistant"
          ? { text: delta, streaming: true }
          : { text: delta }
      );
      current = { row, text: delta };
    } else {
      current.text += delta;
      await this.store.updatePayload(
        current.row.id,
        kind === "assistant"
          ? { text: current.text, streaming: true }
          : { text: current.text }
      );
    }
    state[kind] = current;
    this.open.set(agentId, state);
  }

  private async closeText(
    agentId: string,
    only?: "assistant" | "thought"
  ): Promise<void> {
    const state = this.open.get(agentId);
    if (!state) return;
    for (const kind of ["assistant", "thought"] as const) {
      if (only && kind !== only) continue;
      const current = state[kind];
      if (!current) continue;
      await this.store.updatePayload(
        current.row.id,
        kind === "assistant"
          ? { text: current.text, streaming: false }
          : { text: current.text }
      );
      delete state[kind];
    }
  }
}
```

- [ ] **Step 5: Write the usage recorder**

`apps/server/src/agents/dsh/usage-recorder.ts`:

```ts
import type { Queryable } from "../../chat/feed.js";
import type { DriverEvent } from "./driver.js";

const UPSERT = `INSERT INTO agent_token_usage
  (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens,
   output_tokens, message_count, session_start, session_end)
 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW(), NOW())
 ON CONFLICT (agent_id, session_id, model)
 DO UPDATE SET
   input_tokens = EXCLUDED.input_tokens,
   cache_creation_tokens = EXCLUDED.cache_creation_tokens,
   cache_read_tokens = EXCLUDED.cache_read_tokens,
   output_tokens = EXCLUDED.output_tokens,
   message_count = agent_token_usage.message_count + 1,
   session_end = NOW(),
   harvested_at = NOW()`;

/** Writes ACP usage_update totals (cumulative per session) into agent_token_usage. */
export class UsageRecorder {
  constructor(private readonly db: Queryable) {}

  async handle(
    event: DriverEvent,
    ctx: { sessionId: string; model: string }
  ): Promise<void> {
    if (
      event.type !== "update" ||
      event.update.sessionUpdate !== "usage_update"
    )
      return;
    const u = event.update.usage;
    if (!u) return;
    await this.db.query(UPSERT, [
      event.agentId,
      ctx.sessionId,
      ctx.model,
      u.input ?? 0,
      u.cache_write ?? 0,
      u.cache_read ?? 0,
      u.output ?? 0,
    ]);
  }
}
```

Match the `Usage` field names to the SDK type. If `agent_token_usage` lacks `harvested_at` or has other required columns, read migration `0018`-ish for that table (`grep -l agent_token_usage apps/server/src/db/migrations/*`) and adjust.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-stream-recorder.test.ts test/dsh-usage-recorder.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/agents/dsh/stream-recorder.ts apps/server/src/agents/dsh/usage-recorder.ts apps/server/test/dsh-stream-recorder.test.ts apps/server/test/dsh-usage-recorder.test.ts
git commit -m "feat(dsh): fold ACP updates into stream rows and token usage

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Supervisor and manager wiring

**Files:**

- Create: `apps/server/src/agents/dsh/supervisor.ts`
- Modify: `apps/server/src/agents/manager.ts` (constructor, `completeSetup`, `stopAgent`, `startAgent`, archive/delete paths)
- Modify: `apps/server/src/agents/activity-monitor.ts` (skip dsh)
- Test: `apps/server/test/dsh-supervisor.test.ts`

**Interfaces:**

- Consumes: `DshDriver`, `StreamRecorder`, `UsageRecorder`, `writeOverlay`, `dispatchMcpUrl` and `createAgentMcpToken` from `apps/server/src/agents/tmux/mcp-url.ts` and `apps/server/src/server/auth.ts` (check exact export names with grep), `buildLaunchGuidance` or whatever `command-builder.ts` uses to produce `launchGuidance` (grep `launchGuidance` in that file and reuse the same function).
- Produces:

```ts
export type SupervisorDeps = {
  pool: Pool;
  config: AppConfig;
  logger: Logger;
  driver?: DshDriver; // injectable for tests
  getAgent: (id: string) => Promise<AgentRecord | null>;
  setCliSessionId: (id: string, sessionId: string) => Promise<void>;
  setLatestEvent: (
    id: string,
    input: { type: AgentLatestEventType; message: string }
  ) => Promise<void>;
  publishChat: (agentId: string) => void; // ChatService.publishChanged
  personaPromptFor: (agent: AgentRecord) => Promise<string>; // launch guidance + persona/personality
};
export class DshSupervisor {
  constructor(deps: SupervisorDeps);
  start(agentId: string): Promise<void>; // builds overlay, starts driver, stores session id, sets idle
  prompt(agentId: string, text: string): Promise<void>; // sets working, resolves when settled, sets idle
  stop(agentId: string): Promise<void>;
  isRunning(agentId: string): boolean;
}
```

- [ ] **Step 1: Write the failing test**

`apps/server/test/dsh-supervisor.test.ts` (uses the fake ACP agent and a fake pool):

```ts
import { describe, expect, it, vi } from "vitest";
import { DshDriver } from "../src/agents/dsh/driver.js";
import { DshSupervisor } from "../src/agents/dsh/supervisor.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function build(turn?: Parameters<typeof createFakeAcpAgent>[0]["turn"]) {
  const fake = createFakeAcpAgent({ turn });
  const driver = new DshDriver({
    dshBin: "dsh",
    dshHome: "/tmp/dsh-home-test",
    spawn: () => fake.child,
    logger,
  });
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const events: { type: string; message: string }[] = [];
  const deps = {
    pool: { query } as never,
    config: {
      dshBin: "dsh",
      dshHome: "/tmp/dsh-home-test",
      host: "127.0.0.1",
      port: 1,
      authToken: "secret",
      scheme: "http",
    } as never,
    logger,
    driver,
    getAgent: vi.fn(async (id: string) => ({
      id,
      type: "dsh",
      cwd: "/tmp/w",
      model: "openai/gpt-5.2",
      cliSessionId: null,
    })) as never,
    setCliSessionId: vi.fn(async () => {}),
    setLatestEvent: vi.fn(
      async (_id: string, input: { type: string; message: string }) => {
        events.push(input);
      }
    ),
    publishChat: vi.fn(),
    personaPromptFor: vi.fn(async () => "PERSONA"),
  };
  return { fake, deps, events, sup: new DshSupervisor(deps) };
}

describe("DshSupervisor", () => {
  it("start writes the overlay, records the session id, and marks idle", async () => {
    const { sup, deps, fake, events } = build();
    await sup.start("agt_1");
    expect(deps.setCliSessionId).toHaveBeenCalledWith("agt_1", "sess_1");
    expect(fake.seen.newSession[0].cwd).toBe("/tmp/w");
    expect(events.at(-1)).toEqual({
      type: "idle",
      message: "dsh session started.",
    });
  });

  it("prompt marks working, then idle when the turn settles", async () => {
    const { sup, events } = build(async (_p, emit) => {
      await emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      });
      return "end_turn";
    });
    await sup.start("agt_1");
    await sup.prompt("agt_1", "go");
    expect(events.map((e) => e.type)).toEqual(["idle", "working", "idle"]);
  });

  it("prompt failure surfaces as idle with the error message", async () => {
    const { sup, events } = build(async () => {
      throw new Error("no API key for provider route");
    });
    await sup.start("agt_1");
    await sup.prompt("agt_1", "go");
    expect(events.at(-1)).toMatchObject({
      type: "idle",
      message: expect.stringContaining("no API key"),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-supervisor.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the supervisor**

`apps/server/src/agents/dsh/supervisor.ts`:

```ts
import path from "node:path";
import type { Pool } from "pg";
import type { AgentLatestEventType, AgentRecord } from "@dispatch/shared";

import type { AppConfig } from "../../config.js";
import { createAgentMcpToken } from "../../server/auth.js";
import { dispatchMcpUrl } from "../tmux/mcp-url.js";
import { DshDriver, type DriverEvent } from "./driver.js";
import { writeOverlay } from "./overlay.js";
import { StreamRecorder } from "./stream-recorder.js";
import { StreamStore } from "./stream-store.js";
import { UsageRecorder } from "./usage-recorder.js";

type Logger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
};

export type SupervisorDeps = {
  pool: Pool;
  config: AppConfig;
  logger: Logger;
  driver?: DshDriver;
  getAgent: (id: string) => Promise<AgentRecord | null>;
  setCliSessionId: (id: string, sessionId: string) => Promise<void>;
  setLatestEvent: (
    id: string,
    input: { type: AgentLatestEventType; message: string }
  ) => Promise<void>;
  publishChat: (agentId: string) => void;
  personaPromptFor: (agent: AgentRecord) => Promise<string>;
};

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

export class DshSupervisor {
  private readonly driver: DshDriver;
  private readonly streams: StreamRecorder;
  private readonly usage: UsageRecorder;
  private readonly context = new Map<
    string,
    { sessionId: string; model: string }
  >();

  constructor(private readonly deps: SupervisorDeps) {
    this.driver =
      deps.driver ??
      new DshDriver({
        dshBin: deps.config.dshBin,
        dshHome: deps.config.dshHome,
        logger: deps.logger,
      });
    this.streams = new StreamRecorder(new StreamStore(deps.pool));
    this.usage = new UsageRecorder(deps.pool);
    this.driver.onEvent((event) => void this.onEvent(event));
  }

  isRunning(agentId: string): boolean {
    return this.driver.isRunning(agentId);
  }

  async start(agentId: string): Promise<void> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.type !== "dsh")
      throw new Error(`${agentId} is not a dsh agent`);
    const overlayDir = path.join(this.deps.config.dshHome, "overlays");
    const overlayPath = await writeOverlay(overlayDir, agentId, {
      model: agent.model ?? null,
      persona: await this.deps.personaPromptFor(agent),
    });
    const env: NodeJS.ProcessEnv = {};
    for (const key of PASSTHROUGH_ENV)
      if (process.env[key]) env[key] = process.env[key];
    env.DISPATCH_AGENT_ID = agentId;
    const { sessionId } = await this.driver.start({
      agentId,
      cwd: agent.cwd,
      overlayPath,
      mcp: {
        url: dispatchMcpUrl(this.deps.config, agentId),
        token: createAgentMcpToken(this.deps.config.authToken, agentId),
      },
      sessionId: agent.cliSessionId ?? null,
      env,
    });
    this.context.set(agentId, { sessionId, model: agent.model ?? "default" });
    await this.deps.setCliSessionId(agentId, sessionId);
    await this.deps.setLatestEvent(agentId, {
      type: "idle",
      message: "dsh session started.",
    });
  }

  async prompt(agentId: string, text: string): Promise<void> {
    await this.deps.setLatestEvent(agentId, {
      type: "working",
      message: "Working on the latest message.",
    });
    try {
      await this.driver.prompt(agentId, text);
      await this.deps.setLatestEvent(agentId, {
        type: "idle",
        message: "Turn finished.",
      });
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn({ err, agentId }, "dsh prompt failed");
      await this.deps.setLatestEvent(agentId, {
        type: "idle",
        message: `Turn failed: ${message}`.slice(0, 200),
      });
    }
  }

  async stop(agentId: string): Promise<void> {
    await this.driver.stop(agentId);
    this.context.delete(agentId);
  }

  private async onEvent(event: DriverEvent): Promise<void> {
    try {
      await this.streams.handle(event);
      const ctx = this.context.get(event.agentId);
      if (ctx) await this.usage.handle(event, ctx);
      this.deps.publishChat(event.agentId);
      if (event.type === "exit" && event.code !== 0) {
        await this.deps.setLatestEvent(event.agentId, {
          type: "blocked",
          message: `dsh exited (${event.code ?? event.signal}).`,
        });
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId: event.agentId },
        "dsh event handling failed"
      );
    }
  }
}
```

Check the signature of `dispatchMcpUrl` (it may take `(config, agentId, jobRunId?)`) and of `createAgentMcpToken` in `apps/server/src/server/auth.ts`; import from wherever `command-builder.ts` imports them.

- [ ] **Step 4: Wire the manager**

In `apps/server/src/agents/manager.ts`:

1. Import `DshSupervisor` and add a field `private dshSupervisor: DshSupervisor | null = null;`.
2. Add `attachDshSupervisor(sup: DshSupervisor): void { this.dshSupervisor = sup; }` beside `attachDiffStatsRefresher`, and `getDshSupervisor(): DshSupervisor | null`.
3. Add a public `async setCliSessionId(id: string, sessionId: string)` that runs `UPDATE agents SET cli_session_id = $2, updated_at = NOW() WHERE id = $1` (reuse `claimCliSessionId` if it already does this).
4. In `completeSetup`, after `populateGitContext` and before the setup-script unlink:

```ts
if (agent.type === "dsh" && this.dshSupervisor) {
  try {
    await this.dshSupervisor.start(id);
  } catch (error) {
    const message = errorMessage(error);
    await this.setAgentStatus(id, "error", message);
    await this.setSystemLatestEvent(id, {
      type: "blocked",
      message: `dsh failed to start: ${message}`.slice(0, 200),
    });
    throw new AgentError(`dsh failed to start: ${message}`, 500);
  }
} else {
  await this.setSystemLatestEvent(
    id,
    agent.type === "terminal"
      ? { type: "idle", message: "Terminal session started." }
      : { type: "idle", message: "Session started." }
  );
}
```

(Replace the existing `setSystemLatestEvent` call with this block.)

5. In `stopAgent`, before `runtime.stopSession`, add `if (agent.type === "dsh") await this.dshSupervisor?.stop(id);`. Do the same in the archive and delete paths where the tmux session is killed (grep `killSession(` in the manager and add the supervisor stop beside each).
6. In `startAgent` (the restart path), after `runtime.launch({ payload: agent-command })` succeeds, add `if (agent.type === "dsh") await this.dshSupervisor?.start(id);` so a restart resumes the stored session id.

In the server composition root where `AgentManager` and `ChatService` are constructed (grep `attachDiffStatsRefresher(` outside the manager to find it), construct the supervisor:

```ts
const dshSupervisor = new DshSupervisor({
  pool,
  config,
  logger: app.log,
  getAgent: (id) => agentManager.getAgent(id),
  setCliSessionId: (id, sid) => agentManager.setCliSessionId(id, sid),
  setLatestEvent: (id, input) =>
    agentManager.upsertLatestEvent(id, input).then(() => undefined),
  publishChat: (id) => chatService.publishChanged(id),
  personaPromptFor: async (agent) => buildDshPersona(agent),
});
agentManager.attachDshSupervisor(dshSupervisor);
```

`buildDshPersona` lives in `apps/server/src/agents/dsh/persona.ts` (create it in this task): it returns the same `launchGuidance` string `command-builder.ts` builds for CLI agents (extract that builder into an exported function if it is inline), followed by two newlines and the agent's persona prompt or active personality prompt when present. Find how `command-builder.ts` receives `personalityPrompt` and `appendedSystemPrompt` and source them the same way (the persona launch path stores the persona prompt in `agentArgs` as `--append-system-prompt`; parse it out with `normalizeAgentArgsForType("claude", agent.agentArgs).appendedSystemPrompt`).

7. In `apps/server/src/agents/activity-monitor.ts`, skip agents whose `type === "dsh"` in the poll loop (the supervisor owns their working/idle).

- [ ] **Step 5: Run tests and type check**

Run: `pnpm --filter @dispatch/server exec vitest run test/dsh-supervisor.test.ts test/agent-lifecycle-runtime.test.ts test/agent-startup.test.ts && pnpm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agents/dsh apps/server/src/agents/manager.ts apps/server/src/agents/activity-monitor.ts apps/server/src/server apps/server/src/index.ts apps/server/test/dsh-supervisor.test.ts
git commit -m "feat(dsh): supervisor starts, prompts, and stops dsh from the agent lifecycle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Route prompts to dsh

**Files:**

- Modify: `apps/server/src/server/agent-prompts.ts:26-75`
- Test: `apps/server/test/agent-prompts.test.ts`

**Interfaces:**

- Consumes: `agentManager.getDshSupervisor()` and `agentManager.getAgent(id)`.
- Produces: unchanged `EnqueueAgentPrompt` signature. For dsh agents `held` is always `false` and `delivery` resolves when the prompt is accepted by the driver (not when the turn settles), so chat and message rows flip to `delivered: true` promptly.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/agent-prompts.test.ts`, extending `build()` so `agentManager` also has `getAgent` and `getDshSupervisor`:

```ts
it("routes dsh agents to the supervisor instead of the pane", async () => {
  const prompt = vi.fn(async () => {});
  const { enqueueAgentPrompt, agentManager } = build();
  agentManager.getAgent = vi.fn(async () => ({
    id: "agt_d",
    type: "dsh",
  })) as never;
  agentManager.getDshSupervisor = vi.fn(() => ({
    isRunning: () => true,
    prompt,
  })) as never;
  const { held, delivery } = await enqueueAgentPrompt("agt_d", "hello dsh");
  expect(held).toBe(false);
  await delivery;
  expect(prompt).toHaveBeenCalledWith("agt_d", "hello dsh");
  expect(sendCommand).not.toHaveBeenCalled();
});

it("fails loudly when the dsh process is not running", async () => {
  const { enqueueAgentPrompt, agentManager } = build();
  agentManager.getAgent = vi.fn(async () => ({
    id: "agt_d",
    type: "dsh",
  })) as never;
  agentManager.getDshSupervisor = vi.fn(() => ({
    isRunning: () => false,
    prompt: vi.fn(),
  })) as never;
  await expect(enqueueAgentPrompt("agt_d", "x")).rejects.toThrow(
    /dsh is not running/
  );
});
```

In `build()`, give `agentManager` default `getAgent: vi.fn(async () => ({ id: "agt_1", type: "claude" }))` and `getDshSupervisor: vi.fn(() => null)` so the existing tests keep passing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/server exec vitest run test/agent-prompts.test.ts`
Expected: FAIL, the dsh test still hits the pane path.

- [ ] **Step 3: Add the branch**

In `createPromptInjector`'s `enqueueAgentPrompt`, before `getTerminalAccess`:

```ts
const agent = await agentManager.getAgent(agentId);
if (agent?.type === "dsh") {
  const supervisor = agentManager.getDshSupervisor();
  if (!supervisor || !supervisor.isRunning(agentId)) {
    throw new Error(
      "dsh is not running for this agent — prompt cannot be delivered."
    );
  }
  // The turn runs in the background; delivery means "accepted", matching
  // what pane injection promises for CLI agents.
  const turn = supervisor.prompt(agentId, prompt);
  turn.catch((error) =>
    appLog.warn({ err: error, agentId }, "dsh turn failed")
  );
  return { held: false, delivery: Promise.resolve() };
}
```

Update the `AgentManager` type expectation in this file if it uses a narrowed structural type.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dispatch/server exec vitest run test/agent-prompts.test.ts && pnpm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/agent-prompts.ts apps/server/test/agent-prompts.test.ts
git commit -m "feat(dsh): deliver prompts and messages to dsh over ACP instead of the pane

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Render assistant and activity entries in the Chat tab

**Files:**

- Modify: `apps/web/src/components/app/chat/chat-entries.tsx` (append two components)
- Modify: `apps/web/src/components/app/chat/chat-feed.tsx:170-186` (`authorKey`) and `:356-400` (render switch)
- Modify: `apps/web/src/components/app/agent-pane.tsx` (default tab Chat for dsh; grep `Console` there)
- Test: `apps/web/src/components/app/chat/chat-feed.test.tsx`

**Interfaces:**

- Consumes: `ChatAssistantEntry`, `ChatActivityEntry` from `@dispatch/shared`.
- Produces: `AssistantEntryView`, `ActivityEntryView` exported from `chat-entries.tsx` with the same `{ entry, grouped, rule, ctx }` props shape `ReviewEntryView` takes.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/app/chat/chat-feed.test.tsx`, following that file's existing render helper:

```tsx
it("renders assistant text and a tool activity row", () => {
  renderFeed([
    {
      type: "assistant",
      id: "stream:1",
      text: "I will read the file.",
      streaming: false,
      at: "2026-09-04T10:00:00Z",
    },
    {
      type: "activity",
      id: "stream:2",
      toolKind: "read",
      title: "Read README.md",
      status: "completed",
      locations: [{ path: "/w/README.md" }],
      diff: null,
      terminalOutput: null,
      at: "2026-09-04T10:00:01Z",
    },
  ]);
  expect(screen.getByText("I will read the file.")).toBeInTheDocument();
  expect(screen.getByText("Read README.md")).toBeInTheDocument();
  expect(screen.getByLabelText("completed")).toBeInTheDocument();
});

it("shows a streaming indicator while an assistant message is open", () => {
  renderFeed([
    {
      type: "assistant",
      id: "stream:1",
      text: "Thinking",
      streaming: true,
      at: "2026-09-04T10:00:00Z",
    },
  ]);
  expect(screen.getByLabelText("streaming")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dispatch/web exec vitest run src/components/app/chat/chat-feed.test.tsx`
Expected: FAIL. TypeScript rejects the entry types in the switch, or the text is not found.

- [ ] **Step 3: Add the views**

Append to `chat-entries.tsx` (reuse `Post` and whatever markdown renderer `ChatMessageView` uses; grep `Markdown` in that file):

```tsx
export function AssistantEntryView({
  entry,
  grouped,
  rule,
  ctx,
}: {
  entry: ChatAssistantEntry;
  grouped: boolean;
  rule: boolean;
  ctx: FeedContext;
}): JSX.Element {
  return (
    <Post
      author={{ key: "agent", name: ctx.agentName, kind: "agent" }}
      at={entry.at}
      grouped={grouped}
      rule={rule}
    >
      <ChatMarkdown text={entry.text} />
      {entry.streaming ? (
        <span
          aria-label="streaming"
          className="ml-1 inline-block h-3 w-1.5 animate-pulse rounded-sm bg-status-working align-baseline"
        />
      ) : null}
    </Post>
  );
}

const ACTIVITY_STATUS_CLASS: Record<ChatActivityEntry["status"], string> = {
  pending: "bg-muted-foreground/40",
  in_progress: "bg-status-working",
  completed: "bg-status-done",
  failed: "bg-status-blocked",
};

export function ActivityEntryView({
  entry,
  grouped,
  rule,
}: {
  entry: ChatActivityEntry;
  grouped: boolean;
  rule: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = entry.diff !== null || entry.terminalOutput !== null;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 py-0.5 pl-10 pr-4 text-xs text-muted-foreground",
        !grouped && "mt-2",
        rule && "border-t border-border/40 pt-2"
      )}
    >
      <button
        type="button"
        className={cn(
          "flex items-center gap-2 text-left",
          expandable ? "cursor-pointer hover:text-foreground" : "cursor-default"
        )}
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
      >
        <span
          aria-label={entry.status}
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            ACTIVITY_STATUS_CLASS[entry.status]
          )}
        />
        <span className="font-mono uppercase tracking-wide opacity-70">
          {entry.toolKind}
        </span>
        <span className="truncate text-foreground/80">{entry.title}</span>
        {entry.locations[0] ? (
          <span className="truncate font-mono opacity-60">
            {entry.locations[0].path}
          </span>
        ) : null}
      </button>
      {open && entry.diff ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-terminal text-[11px]">
          {renderUnifiedDiff(entry.diff.oldText ?? "", entry.diff.newText)}
        </pre>
      ) : null}
      {open && entry.terminalOutput ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-terminal text-[11px] whitespace-pre-wrap">
          {entry.terminalOutput}
        </pre>
      ) : null}
    </div>
  );
}

function renderUnifiedDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) out.push(`  ${a[i] ?? ""}`);
    else {
      if (i < a.length) out.push(`- ${a[i]}`);
      if (i < b.length) out.push(`+ ${b[i]}`);
    }
  }
  return out.join("\n");
}
```

Replace `ChatMarkdown` with the actual markdown component name used by `ChatMessageView`, and `ctx.agentName` with however `chatMessageAuthor` reads the agent's display name from `FeedContext`. Import `useState` and `cn` if not already imported.

- [ ] **Step 4: Wire the feed**

In `chat-feed.tsx` `authorKey`, add:

```ts
    case "assistant":
      return "agent";
    case "activity":
      return "agent";
```

In the render switch add:

```tsx
            case "assistant":
              return <AssistantEntryView entry={entry} grouped={row.grouped} rule={row.rule} ctx={ctx} />;
            case "activity":
              return <ActivityEntryView entry={entry} grouped={row.grouped} rule={row.rule} ctx={ctx} />;
```

Anywhere else the file narrows on `entry.type` for grouping or read receipts (lines ~240-275), treat `assistant` like an agent chat message and `activity` like `status` for unread counting.

In `agent-pane.tsx`, where the initial tab is chosen, default to the Chat tab when `agent.type === "dsh"` (keep the persisted choice if the user changed it).

- [ ] **Step 5: Run tests, type check, and finalize web**

Run: `pnpm --filter @dispatch/web exec vitest run src/components/app/chat && pnpm run check && pnpm run finalize:web`
Expected: PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(dsh): render assistant text and tool activity in the Chat tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end with a fake `dsh` shim

**Files:**

- Create: `e2e/fixtures/fake-dsh.mjs`
- Modify: `scripts/e2e-isolated.sh` (export `DISPATCH_DSH_BIN` pointing at the shim; a tmux run is required for setup to complete, so this spec sets `E2E_AGENT_RUNTIME=tmux` in its own describe and skips when tmux is missing)
- Create: `e2e/dsh-agent.spec.ts`

**Interfaces:**

- Consumes: the ACP agent side of `@agentclientprotocol/sdk` (installed under `apps/server`; the shim resolves it via `createRequire` from `apps/server/package.json`).

- [ ] **Step 1: Write the shim**

`e2e/fixtures/fake-dsh.mjs`:

```js
#!/usr/bin/env node
// Fake `dsh` for E2E: speaks ACP on stdio, ignores --profile/--patch, and
// scripts one turn: a tool call plus an assistant message echoing the prompt.
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(here, "../../apps/server/package.json")
);
const acp = require("@agentclientprotocol/sdk");

let conn;
const agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "fake-dsh", version: "0.0.0" },
      agentCapabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {}, resume: {} },
      },
      authMethods: [],
    };
  },
  async authenticate() {
    return {};
  },
  async newSession(params) {
    process.stderr.write(
      `fake-dsh newSession mcp=${JSON.stringify(params.mcpServers?.map((s) => s.name))}\n`
    );
    return { sessionId: `fake_${Date.now()}`, configOptions: [] };
  },
  async resumeSession(params) {
    return { sessionId: params.sessionId, configOptions: [] };
  },
  async prompt(params) {
    const text = params.prompt
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const emit = (update) =>
      conn.sessionUpdate({ sessionId: params.sessionId, update });
    await emit({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read README.md",
      kind: "read",
      status: "in_progress",
      locations: [{ path: `${params.cwd ?? process.cwd()}/README.md` }],
      content: [],
    });
    await emit({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
    });
    for (const piece of ["You said: ", text]) {
      await emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: piece },
      });
    }
    await emit({
      sessionUpdate: "usage_update",
      used: 120,
      size: 200000,
      usage: {
        input: 100,
        output: 20,
        thought: 0,
        cache_read: 0,
        cache_write: 0,
      },
    });
    return { stopReason: "end_turn" };
  },
  async cancel() {},
  async closeSession() {
    return {};
  },
};

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);
conn = new acp.AgentSideConnection(() => agent, stream);
process.stdin.on("end", () => process.exit(0));
```

Run `chmod +x e2e/fixtures/fake-dsh.mjs`.

In `scripts/e2e-isolated.sh`, next to the other exports:

```sh
export DISPATCH_DSH_BIN="${DISPATCH_DSH_BIN:-$PWD/e2e/fixtures/fake-dsh.mjs}"
export DISPATCH_DSH_HOME="/tmp/dispatch-dsh-home-${RUN_ID}"
```

- [ ] **Step 2: Write the spec**

`e2e/dsh-agent.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import {
  cleanupE2EAgents,
  createAgentViaAPI,
  loadApp,
  setEnabledAgentTypesViaAPI,
} from "./helpers";

const tmux = process.env.DISPATCH_AGENT_RUNTIME === "tmux";

test.describe("dsh agent", () => {
  test.skip(!tmux, "dsh setup completes through the tmux setup script");
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("appears in the type picker, streams into the Chat tab, and accepts a chat message", async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "dsh"]);
    const agent = await createAgentViaAPI(request, {
      type: "dsh",
      cwd: process.cwd(),
      useWorktree: true,
    });
    await loadApp(page);
    await page.getByRole("link", { name: agent.name }).click();
    await expect(page.getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    const composer = page.getByPlaceholder(/message/i);
    await composer.fill("hello harness");
    await composer.press("Enter");

    await expect(page.getByText("Read README.md")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("You said: hello harness")).toBeVisible({
      timeout: 20_000,
    });

    const res = await request.get(`/api/v1/agents/${agent.id}`, {
      headers: {
        Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
      },
    });
    const body = (await res.json()) as {
      agent: { latestEvent: { type: string } | null };
    };
    expect(body.agent.latestEvent?.type).toBe("idle");
  });
});
```

Check `e2e/helpers.ts` for the exact selectors the chat-surface spec uses for the composer and tab, and the base URL the `request` fixture needs; copy them.

- [ ] **Step 3: Run the E2E**

Run: `E2E_AGENT_RUNTIME=tmux pnpm run test:e2e -- e2e/dsh-agent.spec.ts`
Expected: PASS. If the chat surface is behind the `chat_surface_enabled` flag, enable it through the same API the chat-surface spec uses before loading the app.

- [ ] **Step 4: Run the full suites**

Run: `pnpm run check && pnpm run test && pnpm run test:e2e`
Expected: PASS. Note any pre-existing flake by name.

- [ ] **Step 5: Commit**

```bash
git add e2e scripts/e2e-isolated.sh
git commit -m "test(dsh): end-to-end against a fake ACP dsh shim

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Live validation and hand-off

**Files:**

- Modify: `docs/superpowers/specs/2026-09-04-dsh-harness-design.md` (status line only)

- [ ] **Step 1: Start an isolated stack**

Use the `repo_dev_up` MCP tool. Export `DISPATCH_DSH_BIN` to the real `dsh` (install with `pnpm add -g @deepseek-ai/dsh` if absent) and one of `DEEPSEEK_API_KEY` or `OPENAI_API_KEY` in the environment the stack inherits.

- [ ] **Step 2: Launch a dsh agent from the UI**

Enable the dsh type in Settings, create an agent with a worktree, pick a model, and send "List the top-level files and tell me what this repo is." Confirm: status goes working then idle without the agent calling `dispatch_event`; assistant text and activity rows appear; the token panel shows usage for the session; a cross-agent message from a Claude agent lands as a prompt.

- [ ] **Step 3: Screenshot and publish**

Capture the Chat tab with Playwright and publish with `dispatch_share_file`. Call `browser_close`.

- [ ] **Step 4: Update the spec status and commit**

Change the spec's status line to `Status: prototype implemented (see docs/superpowers/plans/2026-09-04-dsh-harness.md); live-validated <date> against <provider>.` and commit:

```bash
git add docs/superpowers/specs/2026-09-04-dsh-harness-design.md
git commit -m "docs(dsh): record prototype validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Leave the dev stack running and report its URLs and the `repo_dev_down` cleanup command.
