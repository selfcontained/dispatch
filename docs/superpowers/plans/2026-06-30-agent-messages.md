# Agent Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist agent-to-agent messages and surface them in a per-agent sidebar "Messages" tab and a "Messages" tab in the History detail view.

**Architecture:** Messages become persisted artifacts (like pins/brain/feedback). The existing `dispatch_send_message` handler keeps its ephemeral tmux delivery unchanged, but additionally writes a row to a new `agent_messages` table and publishes a `message.created` SSE event. The web app reads messages via new REST endpoints and renders them in two places, subscribing to SSE for live updates.

**Tech Stack:** Fastify + PostgreSQL (`pg`) backend, `node-pg-migrate` migrations, React + Vite + TanStack Query frontend, Vitest (unit), Playwright (E2E). Package manager is `pnpm`; the server's `pnpm` scripts are Bun-based and auto-run `prepare:runtime-assets` (which re-embeds migration SQL) before check/test/build.

## Global Constraints

- Use `pnpm` for all commands (never `npm`).
- Same-repo-only send rule is **unchanged** — do not lift the cross-repo restriction in `sendMessage`. The schema stores repo roots so cross-repo can be enabled later without a migration.
- This feature is **view-only** in the UI — no composing/replying from the browser.
- Backend imports use relative paths with `.js` extensions (e.g. `../messages/store.js`).
- New migrations are picked up automatically by `prepare:runtime-assets`; no manual codegen step. Migrations run on server start (and via `repo_dev_up`).
- Follow existing patterns: DB query modules live under `apps/server/src/<domain>/`; camelCase is exposed at the API boundary.
- Before marking complete: `pnpm run check`, `pnpm run finalize:web` (web changed), `pnpm run test` (backend changed), `pnpm run test:e2e`.

---

### Task 1: `agent_messages` table + `MessageStore` query module

**Files:**
- Create: `apps/server/src/db/migrations/0029_agent-messages.sql`
- Create: `apps/server/src/messages/store.ts`
- Test: `apps/server/test/message-store.test.ts`

**Interfaces:**
- Produces:
  - `type StoredMessage = { id: string; senderAgentId: string; recipientAgentId: string; senderName: string; recipientName: string; content: string; delivered: boolean; readAt: string | null; senderRepoRoot: string | null; recipientRepoRoot: string | null; createdAt: string }`
  - `class MessageStore { constructor(pool: Pool); insertMessage(input: InsertMessageInput): Promise<StoredMessage>; listForAgent(agentId: string): Promise<StoredMessage[]>; countUnreadForAgent(agentId: string): Promise<number>; markReadForAgent(agentId: string): Promise<number> }`
  - `type InsertMessageInput = Omit<StoredMessage, "id" | "readAt" | "createdAt">`

- [ ] **Step 1: Write the migration SQL**

Create `apps/server/src/db/migrations/0029_agent-messages.sql`:

```sql
-- Agent-to-agent messages: durable record of dispatch_send_message deliveries.
-- Delivery itself stays ephemeral (tmux injection); this table is for viewing.

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY,
  sender_agent_id text NOT NULL,
  recipient_agent_id text NOT NULL,
  sender_name text NOT NULL,
  recipient_name text NOT NULL,
  content text NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  -- Stored even though sender/recipient repo roots are equal today (same-repo
  -- send rule). Present so cross-repo messaging becomes a config flip, not a
  -- migration.
  sender_repo_root text,
  recipient_repo_root text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_sender_created_idx
  ON agent_messages (sender_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_messages_recipient_created_idx
  ON agent_messages (recipient_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_messages_recipient_unread_idx
  ON agent_messages (recipient_agent_id) WHERE read_at IS NULL;
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/message-store.test.ts` (modeled on `test/brain-store-queries.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";

import { MessageStore } from "../src/messages/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let pool: Pool;
let store: MessageStore;

const REPO = "/repo/msg-test";
const A = "agt_msg_a";
const B = "agt_msg_b";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new MessageStore(pool);
});

afterAll(async () => {
  await teardownTestDb();
});

describe("MessageStore", () => {
  it("inserts and lists messages for both participants", async () => {
    const inserted = await store.insertMessage({
      senderAgentId: A,
      recipientAgentId: B,
      senderName: "Alice",
      recipientName: "Bob",
      content: "hello bob",
      delivered: true,
      senderRepoRoot: REPO,
      recipientRepoRoot: REPO,
    });
    expect(inserted.id).toBeTruthy();
    expect(inserted.readAt).toBeNull();
    expect(inserted.delivered).toBe(true);

    const forSender = await store.listForAgent(A);
    const forRecipient = await store.listForAgent(B);
    expect(forSender.map((m) => m.content)).toContain("hello bob");
    expect(forRecipient.map((m) => m.content)).toContain("hello bob");
  });

  it("counts and clears unread for the recipient only", async () => {
    await store.insertMessage({
      senderAgentId: B,
      recipientAgentId: A,
      senderName: "Bob",
      recipientName: "Alice",
      content: "hi alice",
      delivered: true,
      senderRepoRoot: REPO,
      recipientRepoRoot: REPO,
    });

    // A received one message ("hi alice") -> unread 1. A sent one -> not counted.
    expect(await store.countUnreadForAgent(A)).toBe(1);

    const cleared = await store.markReadForAgent(A);
    expect(cleared).toBe(1);
    expect(await store.countUnreadForAgent(A)).toBe(0);
    // Marking A read must not touch B's unread.
    expect(await store.countUnreadForAgent(B)).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/server && pnpm exec vitest run test/message-store.test.ts`
Expected: FAIL — `Cannot find module '../src/messages/store.js'` (and/or table does not exist).

- [ ] **Step 4: Implement `MessageStore`**

Create `apps/server/src/messages/store.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type StoredMessage = {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  senderName: string;
  recipientName: string;
  content: string;
  delivered: boolean;
  readAt: string | null;
  senderRepoRoot: string | null;
  recipientRepoRoot: string | null;
  createdAt: string;
};

export type InsertMessageInput = Omit<
  StoredMessage,
  "id" | "readAt" | "createdAt"
>;

type Row = {
  id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  sender_name: string;
  recipient_name: string;
  content: string;
  delivered: boolean;
  read_at: Date | null;
  sender_repo_root: string | null;
  recipient_repo_root: string | null;
  created_at: Date;
};

function toStoredMessage(row: Row): StoredMessage {
  return {
    id: row.id,
    senderAgentId: row.sender_agent_id,
    recipientAgentId: row.recipient_agent_id,
    senderName: row.sender_name,
    recipientName: row.recipient_name,
    content: row.content,
    delivered: row.delivered,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    senderRepoRoot: row.sender_repo_root,
    recipientRepoRoot: row.recipient_repo_root,
    createdAt: row.created_at.toISOString(),
  };
}

export class MessageStore {
  constructor(private readonly pool: Pool) {}

  async insertMessage(input: InsertMessageInput): Promise<StoredMessage> {
    const result = await this.pool.query<Row>(
      `INSERT INTO agent_messages
         (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name,
          content, delivered, sender_repo_root, recipient_repo_root)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        randomUUID(),
        input.senderAgentId,
        input.recipientAgentId,
        input.senderName,
        input.recipientName,
        input.content,
        input.delivered,
        input.senderRepoRoot,
        input.recipientRepoRoot,
      ]
    );
    return toStoredMessage(result.rows[0]);
  }

  async listForAgent(agentId: string): Promise<StoredMessage[]> {
    const result = await this.pool.query<Row>(
      `SELECT * FROM agent_messages
        WHERE sender_agent_id = $1 OR recipient_agent_id = $1
        ORDER BY created_at ASC`,
      [agentId]
    );
    return result.rows.map(toStoredMessage);
  }

  async countUnreadForAgent(agentId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agent_messages
        WHERE recipient_agent_id = $1 AND read_at IS NULL`,
      [agentId]
    );
    return Number(result.rows[0].count);
  }

  async markReadForAgent(agentId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE agent_messages SET read_at = now()
        WHERE recipient_agent_id = $1 AND read_at IS NULL`,
      [agentId]
    );
    return result.rowCount ?? 0;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/server && pnpm exec vitest run test/message-store.test.ts`
Expected: PASS (both tests). `prepare:runtime-assets` re-embeds the new migration automatically when the test DB migrates.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrations/0029_agent-messages.sql apps/server/src/messages/store.ts apps/server/test/message-store.test.ts
git commit -m "feat(messages): add agent_messages table and MessageStore"
```

---

### Task 2: Persist + broadcast in the `sendMessage` handler

**Files:**
- Modify: `apps/server/src/server/mcp-handlers.ts` (the `sendMessage` method, ~lines 847–947)
- Test: `apps/server/test/mcp-handlers.test.ts` (extend the existing `dispatch_send_message` / `sendMessage` coverage)

**Interfaces:**
- Consumes: `MessageStore` from Task 1; existing `pool`, `publishUiEvent`, `appLog`, `sendAgentPrompt`, `resolveRepoRoot` already in the handler factory scope.
- Produces: a persisted row per send + a `{ type: "message.created"; senderAgentId; recipientAgentId }` UI event.

- [ ] **Step 1: Add the import**

At the top of `apps/server/src/server/mcp-handlers.ts`, add with the other imports:

```ts
import { MessageStore } from "../messages/store.js";
```

- [ ] **Step 2: Rewrite the delivery/return block of `sendMessage`**

Replace the current try/catch + return at the end of `sendMessage` (the block from `const envelope = ...` return, currently ~lines 920–946) with:

```ts
      const envelope = JSON.stringify({
        from: sender.name,
        senderId: agentId,
        message: input.message,
        replyTarget: agentId,
      });
      const prompt = `--- DISPATCH MESSAGE ---\n${envelope}\n--- END MESSAGE ---\nReply with dispatch_send_message using the replyTarget above.`;

      // Deliver first: a persistence failure must never block delivery.
      let delivered = false;
      let deliveryError: unknown = null;
      try {
        await sendAgentPrompt(target.id, prompt, { swallowFailure: false });
        delivered = true;
      } catch (err) {
        deliveryError = err;
        appLog.error(
          { err, senderId: agentId, targetId: target.id },
          "dispatch_send_message: tmux delivery failed"
        );
      }

      // Record the message (including failed deliveries) so it is viewable.
      const messageStore = new MessageStore(pool);
      await messageStore
        .insertMessage({
          senderAgentId: agentId,
          recipientAgentId: target.id,
          senderName: sender.name,
          recipientName: target.name,
          content: input.message,
          delivered,
          senderRepoRoot,
          // Same repo today (send rule); stored for future cross-repo support.
          recipientRepoRoot: senderRepoRoot,
        })
        .catch((err) =>
          appLog.error(
            { err, senderId: agentId, targetId: target.id },
            "dispatch_send_message: failed to persist message"
          )
        );

      publishUiEvent({
        type: "message.created",
        senderAgentId: agentId,
        recipientAgentId: target.id,
      });

      if (!delivered) {
        throw deliveryError instanceof Error
          ? deliveryError
          : new Error(`Failed to deliver message to "${target.name}".`);
      }

      appLog.info(
        { senderId: agentId, targetId: target.id },
        "dispatch_send_message: delivered"
      );
      return {
        delivered: true,
        targetAgentId: target.id,
        targetAgentName: target.name,
      };
```

- [ ] **Step 3: Add a failing test for persistence**

In `apps/server/test/mcp-handlers.test.ts`, find the existing test(s) exercising the `sendMessage` handler (search the file for `sendMessage` / `dispatch_send_message`). Reuse that harness (same handler-construction helper and mocked `agentManager`/`sendAgentPrompt`/`publishUiEvent`) to add:

```ts
it("persists a row and emits message.created on send", async () => {
  // Arrange the harness so two running agents share a repo root and
  // sendAgentPrompt resolves (see the existing sendMessage test for setup).
  // publishUiEvent is a vi.fn() captured by the harness.

  await handlers.sendMessage("agt_sender", {
    target: "agt_receiver",
    message: "ping",
    senderRepoRoot: "/repo",
  });

  const rows = await pool.query(
    "SELECT sender_agent_id, recipient_agent_id, content, delivered FROM agent_messages WHERE content = $1",
    ["ping"]
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].delivered).toBe(true);

  expect(publishUiEvent).toHaveBeenCalledWith(
    expect.objectContaining({ type: "message.created" })
  );
});
```

Note: if the existing `mcp-handlers.test.ts` harness does not already provide a real `pool` (it uses heavy mocks), wire the handler's `pool` to a `setupTestDb()` pool + `runTestMigrations()` in this test's `beforeAll` (as `test/message-store.test.ts` does) so the row is queryable. If integrating a real DB into that mock-heavy file proves noisy, place this test in a new `apps/server/test/send-message-persistence.test.ts` that constructs the handlers with a real pool and stubs only `agentManager`, `sendAgentPrompt`, and `publishUiEvent`.

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `cd apps/server && pnpm exec vitest run test/mcp-handlers.test.ts`
Expected: FAILS before Step 2's change is in place (no row / no event); PASSES after.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/server/mcp-handlers.ts apps/server/test/mcp-handlers.test.ts
git commit -m "feat(messages): persist and broadcast messages on send"
```

---

### Task 3: REST endpoints for reading + marking messages read

**Files:**
- Create: `apps/server/src/routes/messages.ts`
- Modify: `apps/server/src/server.ts` (register the new routes near `registerMediaRoutes`, ~line 572)
- Test: `apps/server/test/messages-routes.test.ts`

**Interfaces:**
- Consumes: `MessageStore` (Task 1); Fastify `app`, `pool`, `agentManager`, `publishUiEvent` (as passed to `registerMediaRoutes`).
- Produces:
  - `GET /api/v1/agents/:id/messages` → `{ messages: StoredMessage[] }`
  - `POST /api/v1/agents/:id/messages/read` → `{ ok: true; updated: number }`, and publishes `{ type: "message.read"; agentId }`.
  - `registerMessagesRoutes(app, deps)`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/messages-routes.test.ts`. Model the app bootstrap on `test/media-routes.test.ts` (use `test/helpers/inject-app.ts` if it provides an app factory). Minimal shape:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { registerMessagesRoutes } from "../src/routes/messages.js";
import { MessageStore } from "../src/messages/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";

let app: FastifyInstance;
let pool: Pool;
const A = "agt_route_a";
const B = "agt_route_b";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  // Seed agents so the :id existence check passes.
  await pool.query(
    "INSERT INTO agents (id, name, type, status, cwd) VALUES ($1,$2,'claude','running','/repo'), ($3,$4,'claude','running','/repo') ON CONFLICT (id) DO NOTHING",
    [A, "Alice", B, "Bob"]
  );
  const store = new MessageStore(pool);
  await store.insertMessage({
    senderAgentId: A, recipientAgentId: B, senderName: "Alice",
    recipientName: "Bob", content: "hi", delivered: true,
    senderRepoRoot: "/repo", recipientRepoRoot: "/repo",
  });

  app = Fastify();
  await registerMessagesRoutes(app, {
    pool,
    agentManager: { getAgent: async (id: string) => ({ id }) } as never,
    publishUiEvent: () => {},
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await teardownTestDb();
});

describe("messages routes", () => {
  it("lists messages for an agent", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/agents/${B}/messages` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toContain("hi");
  });

  it("marks messages read", async () => {
    const res = await app.inject({ method: "POST", url: `/api/v1/agents/${B}/messages/read` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { updated: number }).updated).toBe(1);
  });

  it("404s for unknown agent", async () => {
    const res = await app.inject({ method: "GET", url: `/api/v1/agents/agt_missing/messages` });
    expect(res.statusCode).toBe(404);
  });
});
```

(If `test/helpers/inject-app.ts` exposes a shared app builder used by `media-routes.test.ts`, prefer it over hand-building Fastify — match the sibling test's style.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/server && pnpm exec vitest run test/messages-routes.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/messages.js'`.

- [ ] **Step 3: Implement the routes**

Create `apps/server/src/routes/messages.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import { MessageStore } from "../messages/store.js";

type MessagesRouteDeps = {
  pool: Pool;
  agentManager: AgentManager;
  publishUiEvent: (event: unknown) => void;
};

export async function registerMessagesRoutes(
  app: FastifyInstance,
  deps: MessagesRouteDeps
): Promise<void> {
  const store = new MessageStore(deps.pool);

  app.get("/api/v1/agents/:id/messages", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const exists = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    if (exists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const messages = await store.listForAgent(id);
    return { messages };
  });

  app.post("/api/v1/agents/:id/messages/read", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const exists = await deps.pool.query("SELECT 1 FROM agents WHERE id = $1", [
      id,
    ]);
    if (exists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const updated = await store.markReadForAgent(id);
    if (updated > 0) {
      deps.publishUiEvent({ type: "message.read", agentId: id });
    }
    return { ok: true, updated };
  });
}
```

- [ ] **Step 4: Register the routes in `server.ts`**

In `apps/server/src/server.ts`, add the import alongside the other route imports (near line 107):

```ts
import { registerMessagesRoutes } from "./routes/messages.js";
```

And register it right after the `registerMediaRoutes(...)` call (after ~line 578):

```ts
  await registerMessagesRoutes(app, {
    pool,
    agentManager,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/server && pnpm exec vitest run test/messages-routes.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/messages.ts apps/server/src/server.ts apps/server/test/messages-routes.test.ts
git commit -m "feat(messages): add read + mark-read REST endpoints"
```

---

### Task 4: Frontend data layer — `useAgentMessages` hook + SSE wiring

**Files:**
- Create: `apps/web/src/hooks/use-agent-messages.ts`
- Modify: `apps/web/src/hooks/use-sse.ts` (add `message.created` and `message.read` to the `UiEvent` union + handlers)

**Interfaces:**
- Produces:
  - `type AgentMessage = { id: string; senderAgentId: string; recipientAgentId: string; senderName: string; recipientName: string; content: string; delivered: boolean; readAt: string | null; createdAt: string }`
  - `useAgentMessages(agentId: string | null): { messages: AgentMessage[]; unreadCount: number; markRead: () => void }`

- [ ] **Step 1: Add the SSE event types**

In `apps/web/src/hooks/use-sse.ts`, add two members to the `UiEvent` union (after the `brain.changed` entry, ~line 42):

```ts
  | { type: "message.created"; senderAgentId: string; recipientAgentId: string }
  | { type: "message.read"; agentId: string }
```

- [ ] **Step 2: Handle the events**

In `use-sse.ts`, inside `handleSSEMessage`, add after the `brain.changed` block (~line 192):

```ts
        if (payload.type === "message.created") {
          void queryClient.invalidateQueries({
            queryKey: ["messages", payload.senderAgentId],
            exact: true,
          });
          void queryClient.invalidateQueries({
            queryKey: ["messages", payload.recipientAgentId],
            exact: true,
          });
          return;
        }

        if (payload.type === "message.read") {
          void queryClient.invalidateQueries({
            queryKey: ["messages", payload.agentId],
            exact: true,
          });
          return;
        }
```

- [ ] **Step 3: Write the hook**

Create `apps/web/src/hooks/use-agent-messages.ts`:

```ts
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type AgentMessage = {
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  senderName: string;
  recipientName: string;
  content: string;
  delivered: boolean;
  readAt: string | null;
  createdAt: string;
};

export function useAgentMessages(agentId: string | null) {
  const queryClient = useQueryClient();

  const { data: messages = [] } = useQuery<AgentMessage[]>({
    queryKey: ["messages", agentId],
    queryFn: async () => {
      const payload = await api<{ messages: AgentMessage[] }>(
        `/api/v1/agents/${agentId}/messages`
      );
      return payload.messages ?? [];
    },
    enabled: !!agentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const unreadCount = useMemo(
    () =>
      messages.filter(
        (m) => m.recipientAgentId === agentId && m.readAt === null
      ).length,
    [messages, agentId]
  );

  const markMutation = useMutation({
    mutationFn: async () => {
      if (!agentId) return;
      await api(`/api/v1/agents/${agentId}/messages/read`, { method: "POST" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["messages", agentId],
        exact: true,
      });
    },
  });

  const markRead = useCallback(() => {
    if (agentId && unreadCount > 0) markMutation.mutate();
  }, [agentId, unreadCount, markMutation]);

  return { messages, unreadCount, markRead };
}
```

Note: confirm `api()` accepts a second `RequestInit`-style argument for `{ method: "POST" }` by checking `apps/web/src/lib/api.ts`. If its signature differs (e.g. `api.post(url)`), use that form instead — match the existing call sites (e.g. the media "seen" POST or notifications ack).

- [ ] **Step 4: Type-check**

Run: `pnpm run check`
Expected: PASS (no type errors from the new union members or hook).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/use-agent-messages.ts apps/web/src/hooks/use-sse.ts
git commit -m "feat(messages): add useAgentMessages hook and SSE wiring"
```

---

### Task 5: `MessagesPanel` component (per-agent conversation threads)

**Files:**
- Create: `apps/web/src/components/app/messages-panel.tsx`

**Interfaces:**
- Consumes: `AgentMessage`, `useAgentMessages` (Task 4).
- Produces: `MessagesPanel({ agentId }: { agentId: string | null }): JSX.Element`

- [ ] **Step 1: Implement the panel**

Create `apps/web/src/components/app/messages-panel.tsx` (grouping + empty/loading states modeled on `brain-tab-content.tsx`):

```tsx
import { useMemo } from "react";
import { MessageSquare, ArrowUpRight, ArrowDownLeft } from "lucide-react";

import { useAgentMessages, type AgentMessage } from "@/hooks/use-agent-messages";
import { cn } from "@/lib/utils";

type Thread = {
  otherId: string;
  otherName: string;
  messages: AgentMessage[];
};

function groupByParticipant(
  messages: AgentMessage[],
  agentId: string
): Thread[] {
  const threads = new Map<string, Thread>();
  for (const m of messages) {
    const isSent = m.senderAgentId === agentId;
    const otherId = isSent ? m.recipientAgentId : m.senderAgentId;
    const otherName = isSent ? m.recipientName : m.senderName;
    const existing = threads.get(otherId);
    if (existing) {
      existing.messages.push(m);
    } else {
      threads.set(otherId, { otherId, otherName, messages: [m] });
    }
  }
  return Array.from(threads.values());
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function MessagesPanel({
  agentId,
}: {
  agentId: string | null;
}): JSX.Element {
  const { messages } = useAgentMessages(agentId);

  const threads = useMemo(
    () => (agentId ? groupByParticipant(messages, agentId) : []),
    [messages, agentId]
  );

  if (!agentId) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">No agent selected.</div>
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">This agent has no messages yet.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-y-auto">
      {threads.map((thread) => (
        <div key={thread.otherId} className="border-b border-border">
          <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {thread.otherName}
          </div>
          <div className="flex flex-col gap-1 px-3 pb-3">
            {thread.messages.map((m) => {
              const isSent = m.senderAgentId === agentId;
              return (
                <div
                  key={m.id}
                  className={cn(
                    "rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs",
                    m.readAt === null && !isSent && "border-primary/40"
                  )}
                  data-testid="message-item"
                >
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {isSent ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownLeft className="h-3 w-3" />
                    )}
                    <span>{isSent ? "Sent" : "Received"}</span>
                    <span>·</span>
                    <span>{relativeTime(m.createdAt)}</span>
                    {!m.delivered && (
                      <span className="text-destructive">· not delivered</span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-foreground">
                    {m.content}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
```

Note: `Date.now()`/`new Date()` are fine in browser code — this is the web app, not a workflow script.

- [ ] **Step 2: Type-check**

Run: `pnpm run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app/messages-panel.tsx
git commit -m "feat(messages): add MessagesPanel with conversation threads"
```

---

### Task 6: Wire the Messages tab into the sidebar

**Files:**
- Modify: `apps/web/src/lib/store.ts` (extend `MediaSidebarTab`, ~line 102)
- Modify: `apps/web/src/components/app/media-sidebar.tsx` (add tab button + mounted panel; extend props)
- Modify: `apps/web/src/components/app/agents-view.tsx` (compute unread count, pass props, mark-read on tab open)

**Interfaces:**
- Consumes: `MessagesPanel` (Task 5), `useAgentMessages` (Task 4).
- Produces: a fourth sidebar tab `"messages"` with an unread badge.

- [ ] **Step 1: Extend the tab union**

In `apps/web/src/lib/store.ts` line 102:

```ts
export type MediaSidebarTab = "pins" | "media" | "brain" | "messages";
```

- [ ] **Step 2: Add the tab button + panel in `media-sidebar.tsx`**

Add `unreadMessageCount: number` to the `MediaSidebarContentProps` signature (the destructured params at ~line 388 and the `& { unseenMediaCount: number }` intersection) — extend to `& { unseenMediaCount: number; unreadMessageCount: number }`, and destructure `unreadMessageCount`.

Add the import at the top:

```tsx
import { MessagesPanel } from "@/components/app/messages-panel";
```

Add a new tab button after the Brain button (after ~line 472), following the exact pattern of the Media button (destructive badge):

```tsx
          <button
            onClick={() => setActiveTab("messages")}
            className={cn(
              "relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "messages"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Messages
            {activeTab === "messages" ? (
              <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-foreground" />
            ) : null}
            {unreadMessageCount > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[8px] text-destructive-foreground">
                {unreadMessageCount}
              </span>
            )}
          </button>
```

Add the mounted panel after the Brain panel `</div>` (after ~line 552):

```tsx
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "messages" && "hidden"
        )}
      >
        <MessagesPanel agentId={selectedAgentId} />
      </div>
```

- [ ] **Step 3: Wire data + mark-read in `agents-view.tsx`**

In `apps/web/src/components/app/agents-view.tsx`:

- Import the hook near the other hook imports:

```tsx
import { useAgentMessages } from "@/hooks/use-agent-messages";
```

- Call it alongside `useMedia(...)` (~line 230) using the same focused agent id:

```tsx
  const { unreadCount: unreadMessageCount, markRead: markMessagesRead } =
    useAgentMessages(focusedAgentId);
```

- Mark messages read when the Messages tab becomes active. Add an effect near the sidebar state (after `useMediaSidebarState(...)`, ~line 161):

```tsx
  useEffect(() => {
    if (mediaActiveTab === "messages") markMessagesRead();
  }, [mediaActiveTab, markMessagesRead]);
```

Use whatever the local variable for the active tab is called from `useMediaSidebarState` (inspect the destructure — it is the `activeTab` value passed to `MediaSidebarContent`). If `useEffect` is not yet imported in this file, add it to the React import.

- Pass `unreadMessageCount` to **both** `MediaSidebarContent` usages (the two render sites at ~line 704 and the header/props at ~666 already pass `unseenMediaCount`). Add:

```tsx
            unreadMessageCount={unreadMessageCount}
```

- [ ] **Step 4: Verify build + type-check**

Run: `pnpm run check && pnpm run finalize:web`
Expected: PASS (type check + production build).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/store.ts apps/web/src/components/app/media-sidebar.tsx apps/web/src/components/app/agents-view.tsx
git commit -m "feat(messages): add Messages tab to the agent sidebar"
```

---

### Task 7: History detail — backend query + Messages tab

**Files:**
- Modify: `apps/server/src/routes/activity.ts` (add a `messages` query to `GET /api/v1/history/agents/:id`, ~lines 582–678)
- Modify: `apps/web/src/hooks/use-agent-history.ts` (add `messages` to `HistoryAgentDetail`)
- Modify: `apps/web/src/components/app/agent-history-detail.tsx` (add `"messages"` to `DetailTab`, tab button, panel)
- Create: `apps/web/src/components/app/message-timeline.tsx`
- Test: `apps/server/test/activity-routes.test.ts` (extend the history-detail coverage)

**Interfaces:**
- Consumes: `agent_messages` table (Task 1); `AgentMessage` type (Task 4).
- Produces: `HistoryAgentDetail.messages: AgentMessage[]`; a `MessageTimeline` component.

- [ ] **Step 1: Add the messages query to the history detail endpoint**

In `apps/server/src/routes/activity.ts`, add a sixth query to the `Promise.all([...])` in `GET /api/v1/history/agents/:id` (after the `feedbackResult` query, ~line 661):

```ts
      deps.pool.query<{
        id: string;
        senderAgentId: string;
        recipientAgentId: string;
        senderName: string;
        recipientName: string;
        content: string;
        delivered: boolean;
        readAt: string | null;
        createdAt: string;
      }>(
        `SELECT id,
                sender_agent_id AS "senderAgentId",
                recipient_agent_id AS "recipientAgentId",
                sender_name AS "senderName",
                recipient_name AS "recipientName",
                content, delivered,
                read_at AS "readAt",
                created_at AS "createdAt"
           FROM agent_messages
          WHERE sender_agent_id = $1 OR recipient_agent_id = $1
          ORDER BY created_at ASC
          LIMIT 500`,
        [id]
      ),
```

Update the destructure to capture it:

```ts
    const [
      eventsResult,
      tokenResult,
      tokenByModelResult,
      mediaResult,
      feedbackResult,
      messagesResult,
    ] = await Promise.all([
```

And add to the returned object (after `feedback: feedbackResult.rows,`):

```ts
      messages: messagesResult.rows,
```

- [ ] **Step 2: Add a failing backend test**

In `apps/server/test/activity-routes.test.ts`, find the existing test for `GET /api/v1/history/agents/:id`. Seed a message for the agent under test and assert it comes back:

```ts
it("includes agent messages in the history detail", async () => {
  // Seed a message where the history agent (agt_history) is the sender.
  await pool.query(
    `INSERT INTO agent_messages
       (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name, content, delivered)
     VALUES (gen_random_uuid(), $1, 'agt_other', 'Hist', 'Other', 'history msg', true)`,
    ["agt_history"]
  );
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/history/agents/agt_history`,
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { messages: Array<{ content: string }> };
  expect(body.messages.map((m) => m.content)).toContain("history msg");
});
```

Use the agent id that the existing detail test already seeds (adjust `agt_history` / `agt_other` to match that file's fixtures). `gen_random_uuid()` requires `pgcrypto`; if the test DB lacks it, insert an explicit uuid string instead.

- [ ] **Step 3: Run backend tests (fail → pass)**

Run: `cd apps/server && pnpm exec vitest run test/activity-routes.test.ts`
Expected: FAILS before Step 1's change (no `messages` key), PASSES after.

- [ ] **Step 4: Extend the frontend detail type**

In `apps/web/src/hooks/use-agent-history.ts`, import the message type and add it to `HistoryAgentDetail`:

```ts
import { type AgentMessage } from "@/hooks/use-agent-messages";
```

Add to the `HistoryAgentDetail` type (after `feedback: HistoryFeedbackItem[];`):

```ts
  messages: AgentMessage[];
```

- [ ] **Step 5: Create the `MessageTimeline` component**

Create `apps/web/src/components/app/message-timeline.tsx`:

```tsx
import { type AgentMessage } from "@/hooks/use-agent-messages";
import { cn } from "@/lib/utils";

export function MessageTimeline({
  messages,
}: {
  messages: AgentMessage[];
}): JSX.Element {
  return (
    <div className="flex flex-col divide-y divide-border rounded-md border border-border">
      {messages.map((m) => (
        <div key={m.id} className="px-3 py-2 text-xs" data-testid="history-message">
          <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-medium text-foreground">{m.senderName}</span>
            <span>→</span>
            <span className="font-medium text-foreground">{m.recipientName}</span>
            <span>·</span>
            <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
            {!m.delivered && (
              <span className={cn("text-destructive")}>· not delivered</span>
            )}
          </div>
          <div className="whitespace-pre-wrap break-words text-foreground">
            {m.content}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Add the Messages tab to the detail view**

In `apps/web/src/components/app/agent-history-detail.tsx`:

- Import the timeline + type near the top:

```tsx
import { MessageTimeline } from "@/components/app/message-timeline";
import { type AgentMessage } from "@/hooks/use-agent-messages";
```

- Extend the `DetailTab` type (line 97):

```tsx
type DetailTab = "events" | "media" | "pins" | "feedback" | "messages";
```

- Add `messages` to the `DetailTabs` props (the destructure + type block at ~lines 99–113):

```tsx
  messages,
```
```tsx
  messages: AgentMessage[];
```

- Add to the `tabs` array (after the `feedback` entry, ~line 139):

```tsx
    { key: "messages", label: "Messages", count: messages.length },
```

- Add the panel in the content area (after the `feedback` block, ~line 246):

```tsx
          {tab === "messages" && messages.length > 0 && (
            <MessageTimeline messages={messages} />
          )}
          {tab === "messages" && messages.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No messages recorded.
            </p>
          )}
```

- Find where `DetailTabs` is rendered by `AgentHistoryDetail` (below line 269, using `data.feedback` etc.) and pass the new prop:

```tsx
          messages={data.messages}
```

- [ ] **Step 7: Verify build + type-check**

Run: `pnpm run check && pnpm run finalize:web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/routes/activity.ts apps/server/test/activity-routes.test.ts apps/web/src/hooks/use-agent-history.ts apps/web/src/components/app/agent-history-detail.tsx apps/web/src/components/app/message-timeline.tsx
git commit -m "feat(messages): surface messages in History detail view"
```

---

### Task 8: End-to-end test + final verification

**Files:**
- Create: `e2e/agent-messages.spec.ts` (match the existing e2e spec conventions in `e2e/`)

**Interfaces:**
- Consumes: the full stack from Tasks 1–7.

- [ ] **Step 1: Inspect existing e2e patterns**

Read one existing spec under `e2e/` (e.g. how it launches agents, selects one, and opens the sidebar) so the new spec matches helpers, fixtures, and readiness signals. Per repo rules: use `waitUntil: "domcontentloaded"` and wait on concrete UI signals — never `networkidle`.

- [ ] **Step 2: Write the E2E spec**

Create `e2e/agent-messages.spec.ts`. The flow:
1. Start from the isolated e2e stack (the suite provisions its own DB + server).
2. Create/launch two agents in the same repo (reuse the suite's agent-creation helper).
3. Trigger a message from agent A to agent B (via the MCP tool path the suite uses for agent actions, or by seeding through the API the suite exposes).
4. Select agent B, open the sidebar, click the **Messages** tab (`data-testid="message-item"` becomes visible), assert the message content is shown and the unread badge appears then clears after opening.
5. Navigate to `/activity/history/<agentBId>`, open the **Messages** tab, assert `data-testid="history-message"` shows the content.
6. Capture a screenshot and publish it via the `dispatch_share` MCP tool (do not leave it local).

Use the assertions/selectors the sibling specs use; the two `data-testid`s added in Tasks 5 and 7 (`message-item`, `history-message`) are the anchors.

- [ ] **Step 3: Run the E2E suite**

Run: `pnpm run test:e2e`
Expected: PASS, including the new spec. (The suite spins up its own isolated DB + server; safe alongside other agents.)

- [ ] **Step 4: Full pre-completion checks**

Run, in order, and fix any failures:

```bash
pnpm run check
pnpm run finalize:web
pnpm run test
pnpm run test:e2e
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/agent-messages.spec.ts
git commit -m "test(messages): e2e coverage for sidebar + history messages"
```

---

## Notes for the implementer

- **Ordering matters:** Tasks 1→3 are backend and independently testable; 4→7 are frontend and depend on the endpoints from 1–3; Task 8 validates the whole stack. Do them in order.
- **Same-repo rule is intentional.** Do not "fix" the repo-root filter in `sendMessage` — cross-repo is explicitly out of scope. The `sender_repo_root`/`recipient_repo_root` columns exist so that lifting the rule later needs no migration.
- **Delivery-first is intentional.** In Task 2, injection happens before the DB write and the write is wrapped in `.catch` so a persistence failure never stops an agent from receiving its message.
- **`api()` signature:** Task 4 assumes `api(url, init)` supports POST. Verify against `apps/web/src/lib/api.ts` and existing POST call sites (media "seen", notifications ack) before finalizing the mutation.
