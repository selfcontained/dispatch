# Quick Phrases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Quick Phrases" button to the terminal top rail that lets users save text phrases and inject them into active agent tmux sessions with one click.

**Architecture:** New `quick_phrases` DB table with CRUD REST endpoints, a new `POST /api/v1/agents/:id/terminal/inject` endpoint that uses `TmuxTerminal.sendCommand()` for server-side tmux injection, and a `QuickPhrasesButton` React component using a shadcn Popover with React Query for data fetching.

**Tech Stack:** PostgreSQL, Fastify, React, React Query, shadcn/ui Popover, Lucide icons, Jotai (none needed), Radix UI

---

## File Structure

| Action | Path                                                   | Responsibility                |
| ------ | ------------------------------------------------------ | ----------------------------- |
| Create | `apps/server/src/db/migrations/0028_quick-phrases.sql` | DB migration                  |
| Create | `apps/server/src/db/quick-phrases.ts`                  | CRUD query functions          |
| Create | `apps/server/src/routes/quick-phrases.ts`              | REST route handlers           |
| Modify | `apps/server/src/server.ts`                            | Register quick-phrases routes |
| Modify | `apps/server/src/routes/agents/terminal-routes.ts`     | Add inject endpoint           |
| Create | `apps/server/test/quick-phrases.test.ts`               | Server integration tests      |
| Create | `apps/web/src/components/app/quick-phrases-button.tsx` | Popover UI component          |
| Modify | `apps/web/src/components/app/agents-view.tsx`          | Mount button in top rail      |

---

### Task 1: Database Migration

**Files:**

- Create: `apps/server/src/db/migrations/0028_quick-phrases.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Verify migration loads**

Run: `pnpm run check` from repo root.
Expected: No type errors (migration is just SQL, but this confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db/migrations/0028_quick-phrases.sql
git commit -m "feat(quick-phrases): add quick_phrases migration"
```

---

### Task 2: Database CRUD Functions

**Files:**

- Create: `apps/server/src/db/quick-phrases.ts`

- [ ] **Step 1: Write the CRUD module**

Follow the pattern in `apps/server/src/db/personalities.ts`. The module exports three functions and one type.

```typescript
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type QuickPhrase = {
  id: string;
  text: string;
  sortOrder: number;
  createdAt: string;
};

type QuickPhraseRow = {
  id: string;
  text: string;
  sort_order: number;
  created_at: Date;
};

function rowToQuickPhrase(row: QuickPhraseRow): QuickPhrase {
  return {
    id: row.id,
    text: row.text,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listQuickPhrases(pool: Pool): Promise<QuickPhrase[]> {
  const result = await pool.query<QuickPhraseRow>(
    "SELECT id, text, sort_order, created_at FROM quick_phrases ORDER BY sort_order ASC, created_at ASC"
  );
  return result.rows.map(rowToQuickPhrase);
}

export async function createQuickPhrase(
  pool: Pool,
  input: { text: string }
): Promise<QuickPhrase> {
  const id = randomUUID();
  const result = await pool.query<QuickPhraseRow>(
    `INSERT INTO quick_phrases (id, text)
     VALUES ($1, $2)
     RETURNING id, text, sort_order, created_at`,
    [id, input.text]
  );
  return rowToQuickPhrase(result.rows[0]!);
}

export async function deleteQuickPhrase(
  pool: Pool,
  id: string
): Promise<boolean> {
  const result = await pool.query("DELETE FROM quick_phrases WHERE id = $1", [
    id,
  ]);
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 2: Verify types**

Run: `pnpm run check`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db/quick-phrases.ts
git commit -m "feat(quick-phrases): add CRUD query functions"
```

---

### Task 3: REST Route Handlers for Quick Phrases CRUD

**Files:**

- Create: `apps/server/src/routes/quick-phrases.ts`
- Modify: `apps/server/src/server.ts:637-639` (after personality routes registration)

- [ ] **Step 1: Write the route module**

Follow the pattern in `apps/server/src/routes/personalities.ts`.

```typescript
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  createQuickPhrase,
  deleteQuickPhrase,
  listQuickPhrases,
} from "../db/quick-phrases.js";

const TEXT_MAX = 1000;

type QuickPhraseRouteDeps = {
  pool: Pool;
};

export async function registerQuickPhraseRoutes(
  app: FastifyInstance,
  deps: QuickPhraseRouteDeps
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/quick-phrases", async () => {
    const phrases = await listQuickPhrases(pool);
    return { phrases };
  });

  app.post("/api/v1/quick-phrases", async (request, reply) => {
    const body = request.body as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!text) {
      return reply.code(400).send({ error: "text is required." });
    }
    if (text.length > TEXT_MAX) {
      return reply
        .code(400)
        .send({ error: `text must be ${TEXT_MAX} characters or fewer.` });
    }

    const phrase = await createQuickPhrase(pool, { text });
    return reply.code(201).send({ phrase });
  });

  app.delete("/api/v1/quick-phrases/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const removed = await deleteQuickPhrase(pool, id);
    if (!removed) {
      return reply.code(404).send({ error: "Phrase not found." });
    }
    return reply.code(204).send();
  });
}
```

- [ ] **Step 2: Register routes in server.ts**

In `apps/server/src/server.ts`, add the import near the other route imports (around line 115) and register after personality routes (around line 639).

Add import:

```typescript
import { registerQuickPhraseRoutes } from "./routes/quick-phrases.js";
```

Add registration after the `registerPersonalityRoutes` call (after line 639):

```typescript
// --- Quick Phrases ---

await registerQuickPhraseRoutes(app, { pool });
```

- [ ] **Step 3: Verify types**

Run: `pnpm run check`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/quick-phrases.ts apps/server/src/server.ts
git commit -m "feat(quick-phrases): add CRUD REST endpoints"
```

---

### Task 4: Terminal Inject Endpoint

**Files:**

- Modify: `apps/server/src/routes/agents/terminal-routes.ts:118` (before the websocket route)

- [ ] **Step 1: Add the inject endpoint**

Add this route inside `registerAgentTerminalRoutes`, before the `app.get("/api/v1/agents/:id/terminal/ws"` websocket route (before line 120 in `terminal-routes.ts`). The `TmuxTerminal` import already exists at line 6.

```typescript
app.post("/api/v1/agents/:id/terminal/inject", async (request, reply) => {
  const params = request.params as { id?: string };
  const body = request.body as { text?: unknown } | null;
  const id = params.id ?? "";
  const text = typeof body?.text === "string" ? body.text : "";

  if (!text) {
    return reply.code(400).send({ error: "text is required." });
  }

  try {
    const access = await deps.agentManager.getTerminalAccess(id);
    if (access.mode !== "tmux") {
      return reply.code(409).send({ error: access.message });
    }

    const terminal = new TmuxTerminal(access.sessionName);
    await terminal.sendCommand(text);
    return reply.code(204).send();
  } catch (error) {
    return deps.handleAgentError(reply, error);
  }
});
```

- [ ] **Step 2: Verify types**

Run: `pnpm run check`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/routes/agents/terminal-routes.ts
git commit -m "feat(quick-phrases): add terminal inject endpoint"
```

---

### Task 5: Server Integration Tests

**Files:**

- Create: `apps/server/test/quick-phrases.test.ts`

- [ ] **Step 1: Write tests for CRUD endpoints**

Follow the pattern in `apps/server/test/agents-routes.test.ts`. Uses `useInjectApp()` for the test harness.

```typescript
import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string,
  payload?: unknown
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  const headers: Record<string, string> = { cookie };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
  }
  return ctx.app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM quick_phrases");
});

describe("GET /api/v1/quick-phrases", () => {
  it("returns empty list when no phrases exist", async () => {
    const res = await authedInject("GET", "/api/v1/quick-phrases");
    expect(res.statusCode).toBe(200);
    expect(res.json().phrases).toEqual([]);
  });

  it("returns created phrases in order", async () => {
    await authedInject("POST", "/api/v1/quick-phrases", { text: "yes" });
    await authedInject("POST", "/api/v1/quick-phrases", { text: "continue" });
    const res = await authedInject("GET", "/api/v1/quick-phrases");
    expect(res.statusCode).toBe(200);
    const { phrases } = res.json();
    expect(phrases).toHaveLength(2);
    expect(phrases[0].text).toBe("yes");
    expect(phrases[1].text).toBe("continue");
  });
});

describe("POST /api/v1/quick-phrases", () => {
  it("creates a phrase and returns it", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "looks good",
    });
    expect(res.statusCode).toBe(201);
    const { phrase } = res.json();
    expect(phrase.text).toBe("looks good");
    expect(phrase.id).toBeDefined();
    expect(phrase.sortOrder).toBe(0);
    expect(phrase.createdAt).toBeDefined();
  });

  it("rejects empty text", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects text over 1000 characters", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "x".repeat(1001),
    });
    expect(res.statusCode).toBe(400);
  });

  it("trims whitespace", async () => {
    const res = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "  hello  ",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().phrase.text).toBe("hello");
  });
});

describe("DELETE /api/v1/quick-phrases/:id", () => {
  it("deletes an existing phrase", async () => {
    const createRes = await authedInject("POST", "/api/v1/quick-phrases", {
      text: "delete me",
    });
    const { id } = createRes.json().phrase;
    const res = await authedInject("DELETE", `/api/v1/quick-phrases/${id}`);
    expect(res.statusCode).toBe(204);

    const listRes = await authedInject("GET", "/api/v1/quick-phrases");
    expect(listRes.json().phrases).toHaveLength(0);
  });

  it("returns 404 for non-existent phrase", async () => {
    const res = await authedInject(
      "DELETE",
      "/api/v1/quick-phrases/00000000-0000-0000-0000-000000000000"
    );
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm run test -- apps/server/test/quick-phrases.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/quick-phrases.test.ts
git commit -m "test(quick-phrases): add integration tests for CRUD endpoints"
```

---

### Task 6: Quick Phrases Button Component

**Files:**

- Create: `apps/web/src/components/app/quick-phrases-button.tsx`

- [ ] **Step 1: Write the component**

This is a self-contained popover component. It uses React Query for data, the `api` helper for requests, and shadcn Popover for the UI. The `onInject` callback lets the parent handle the tmux injection call.

```tsx
import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type QuickPhrase = {
  id: string;
  text: string;
  sortOrder: number;
  createdAt: string;
};

export function QuickPhrasesButton({
  agentId,
  focusTerminal,
}: {
  agentId: string;
  focusTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [newText, setNewText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["quick-phrases"],
    queryFn: () => api<{ phrases: QuickPhrase[] }>("/api/v1/quick-phrases"),
    staleTime: 60_000,
  });

  const phrases = data?.phrases ?? [];

  const createMutation = useMutation({
    mutationFn: (text: string) =>
      api<{ phrase: QuickPhrase }>("/api/v1/quick-phrases", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
      setNewText("");
      inputRef.current?.focus();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      api<null>(`/api/v1/quick-phrases/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-phrases"] });
    },
  });

  const injectMutation = useMutation({
    mutationFn: (text: string) =>
      api<null>(`/api/v1/agents/${agentId}/terminal/inject`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    onSuccess: () => {
      setOpen(false);
      focusTerminal();
    },
  });

  const handleAdd = useCallback(() => {
    const trimmed = newText.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  }, [newText, createMutation]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="pointer-events-auto"
          title="Quick phrases"
          data-testid="quick-phrases-button"
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-border px-3 py-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Quick Phrases
          </h4>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {phrases.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No phrases yet — add one below
            </div>
          ) : (
            phrases.map((phrase) => (
              <div
                key={phrase.id}
                className="group flex items-center gap-1 border-b border-border/50 last:border-b-0"
              >
                <button
                  type="button"
                  className={cn(
                    "flex-1 truncate px-3 py-2 text-left text-sm text-foreground hover:bg-white/[0.06]",
                    injectMutation.isPending && "pointer-events-none opacity-50"
                  )}
                  onClick={() => injectMutation.mutate(phrase.text)}
                  title={phrase.text}
                >
                  {phrase.text}
                </button>
                <button
                  type="button"
                  className="mr-1 hidden rounded p-1 text-muted-foreground hover:bg-white/[0.1] hover:text-foreground group-hover:block"
                  onClick={() => deleteMutation.mutate(phrase.id)}
                  title="Remove phrase"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
        <form
          className="flex items-center gap-1 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        >
          <Input
            ref={inputRef}
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Add a phrase…"
            className="h-7 flex-1 text-xs"
            maxLength={1000}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            disabled={!newText.trim() || createMutation.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Verify types**

Run: `pnpm run check`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app/quick-phrases-button.tsx
git commit -m "feat(quick-phrases): add QuickPhrasesButton component"
```

---

### Task 7: Mount Button in Top Rail

**Files:**

- Modify: `apps/web/src/components/app/agents-view.tsx`

- [ ] **Step 1: Add the import**

Add this import near the other component imports at the top of `agents-view.tsx` (around line 31, after the `TerminalPane` import):

```typescript
import { QuickPhrasesButton } from "@/components/app/quick-phrases-button";
```

- [ ] **Step 2: Add the button in the top rail**

The button should be in the top-left area, right of the sidebar toggle button when it's visible, and in the same position when the sidebar is open. Replace the block at lines 557-569:

```tsx
{
  !leftPanelOpen ? (
    <div className="pointer-events-none absolute left-3 top-3 z-10">
      <Button
        size="icon"
        variant="ghost"
        className="pointer-events-auto"
        onClick={() => handleSetLeftPanelOpen(true)}
        title="Open sidebar"
      >
        <PanelRightOpen className="h-4 w-4" />
      </Button>
    </div>
  ) : null;
}
```

with:

```tsx
<div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1">
  {!leftPanelOpen ? (
    <Button
      size="icon"
      variant="ghost"
      className="pointer-events-auto"
      onClick={() => handleSetLeftPanelOpen(true)}
      title="Open sidebar"
    >
      <PanelRightOpen className="h-4 w-4" />
    </Button>
  ) : null}
  {hasActiveAgent && connState === "connected" ? (
    <QuickPhrasesButton
      agentId={focusedAgentId!}
      focusTerminal={focusTerminal}
    />
  ) : null}
</div>
```

This wraps both buttons in a flex container so the quick phrases button sits right of the sidebar toggle. The container is always rendered (no conditional on leftPanelOpen), and the quick phrases button appears when there's an active connected session.

- [ ] **Step 3: Verify types**

Run: `pnpm run check`
Expected: No type errors.

- [ ] **Step 4: Run web finalization**

Run: `pnpm run finalize:web`
Expected: Type check and production build both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/agents-view.tsx
git commit -m "feat(quick-phrases): mount button in terminal top rail"
```

---

### Task 8: E2E and Final Validation

**Files:** None new — runs existing test suites and validates behavior.

- [ ] **Step 1: Run unit tests**

Run: `pnpm run test -- apps/server/test/quick-phrases.test.ts`
Expected: All quick-phrases tests pass.

- [ ] **Step 2: Run full server unit tests**

Run: `pnpm run test`
Expected: All tests pass (no regressions).

- [ ] **Step 3: Run E2E tests**

Run: `pnpm run test:e2e`
Expected: All existing E2E tests still pass.

- [ ] **Step 4: Start dev server and validate UI**

Run: Use `repo_dev_up` MCP tool to start an isolated dev instance.

Validation checklist:

1. With an active agent session, verify the `MessageSquare` icon appears in the top-left rail
2. When the left sidebar is collapsed, verify the icon sits right of the sidebar toggle
3. When the left sidebar is open, verify the icon is still visible
4. Click the icon — verify popover opens with "No phrases yet" empty state
5. Type a phrase and click the add button — verify it appears in the list
6. Click a phrase — verify popover closes (injection will only work if there's a real tmux session)
7. Hover a phrase — verify the X delete button appears
8. Click delete — verify the phrase is removed
9. Without an active agent selected, verify the icon is hidden

- [ ] **Step 5: Capture screenshot and share**

Use Playwright to navigate to the app, take a screenshot of the quick phrases popover open state, and share via `dispatch_share`.

- [ ] **Step 6: Final commit if any fixes were needed**

If any fixes were made during validation, commit them.
