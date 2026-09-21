# Provider Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a running Dispatch agent from one provider to another, Claude Code to Codex for example, and keep going in the same session: same agent, same feed, same worktree.

**Architecture:** `HarnessSupervisor.switchEngine` stops only the engine process, starts the other engine in the same worktree, and queues a briefing in front of its next prompt. The briefing is a pure function over Dispatch's own record in `agent_stream_events`. One session per engine is remembered, so returning to a provider resumes natively with a short catch-up. Each switch writes one `agent_engine_handoffs` row, which is both the stored briefing and the marker the feed shows.

**Tech Stack:** TypeScript, Bun, Fastify, PostgreSQL, Vitest, React, TanStack Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-provider-switch-and-limit-card-design.md`, sections 3, 4 and 5. This is build step 2 of 3. It assumes step 1 (`2026-09-21-limit-card.md`) has landed, and only Task 8's last step depends on it. Step 3 (`2026-09-21-handoff-compression.md`) adds summarizing for long sessions; here the briefing is replay only.

## Global Constraints

- Setting `harness_engine_switch_enabled`, default on. Unset reads as on; an explicit `"false"` is honoured.
- A switch either completes or leaves the agent exactly where it was.
- Everything that can refuse does so before anything stops.
- `agents.cli_session_id` and `agents.model` are written **last**, together. A restart mid-switch must find the old state or the new one, never a half-switched agent.
- A switch must **not** call `HarnessSupervisor.stop()`. `stop()` fails every queued prompt and kills Dispatch-managed background processes; the spec promises both survive. Use the engine-only stop added in Task 4.
- A switch to a fresh session must **not** re-send the agent's launch prompt. `start()` sends it whenever there is no stored session; the override added in Task 4 suppresses it.
- The briefing never contains a diff or command output.
- The briefing opens with the sentence that ends "If this summary and the files disagree, trust the files."
- If no model was called to build a briefing, none is called here. Compression is plan 3.
- The exact text sent is stored and readable. "View handoff" is required, not optional.
- A switch deletes any scheduled limit resume (plan 1): the user has taken over.
- No em-dashes in prose, comments, or commit messages. American spelling. Conventional commits, lowercase subject after the colon.
- Web unit tests on Node 25 need `NODE_OPTIONS=--no-experimental-webstorage`.
- Run server tests with `pnpm --filter @dispatch/server test -- <file>`.

## Where this plan and the spec were reconciled

Writing this plan against the code found four places the first draft of the spec was wrong. The spec has been corrected; they are listed because each is a trap for anyone working from memory of the brainstorm.

- **The marker is a feed entry, not a `status` row.** `assembleTurns` does not project `status` rows and the web drops every feed entry of that type (`chat-feed.tsx:242`, `chat-pane.tsx:324`).
- **`HarnessSupervisor.stop()` cannot be used.** It fails the queue and kills background processes. Task 4 adds an engine-only stop.
- **`start()` re-sends the launch prompt on any fresh session.** Task 4 adds an override that suppresses it.
- **A typed prompt's text is not on the turn row.** Task 3b loads the session through the chat lookup.

## File Structure

| File                                                           | Responsibility                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/db/migrations/0060_agent-engine-handoffs.sql` | `agent_engine_sessions` and `agent_engine_handoffs`                  |
| `apps/server/src/agents/harness/engine-sessions.ts`            | Store for both tables                                                |
| `apps/server/src/agents/harness/handoff.ts`                    | Pure: build the briefing text from assembled turns and facts         |
| `apps/server/src/agents/harness/handoff-facts.ts`              | Read the live facts: branch, uncommitted summary, tasks, pins        |
| `apps/server/src/chat/turns.ts`                                | `loadSessionTurns`: the whole session as assembled turns             |
| `apps/server/src/harness-switch-settings.ts`                   | The setting                                                          |
| `apps/server/src/agents/harness/supervisor.ts`                 | `start` override, engine-only stop, pending briefing, `switchEngine` |
| `apps/server/src/routes/agents/harness-routes.ts`              | Preview, switch, and read-handoff routes                             |
| `apps/server/src/chat/feed.ts`, `feed-cursor.ts`               | The `switch` feed entry                                              |
| `packages/shared/src/chat-types.ts`, `harness-types.ts`        | Wire types                                                           |
| `apps/web/src/components/app/harness/switch-dialog.tsx`        | The confirm step                                                     |
| `apps/web/src/components/app/harness/use-engine-switch.ts`     | Preview query, switch mutation                                       |
| `apps/web/src/components/app/chat/switch-entry-view.tsx`       | The marker row and "View handoff"                                    |

---

### Task 1: Remember a session per engine, and every handoff

**Files:**

- Create: `apps/server/src/db/migrations/0060_agent-engine-handoffs.sql`
- Create: `apps/server/src/agents/harness/engine-sessions.ts`
- Test: `apps/server/test/harness-engine-sessions.test.ts`

**Interfaces:**

- Produces:

```ts
export type EngineSession = { sessionId: string; lastSeenSeq: number };
export type HandoffRow = {
  id: number;
  agentId: string;
  fromEngine: string;
  toEngine: string;
  outcome: "switched" | "failed";
  failure: string | null;
  briefing: string;
  createdAt: Date;
};
export class EngineSessionStore {
  getSession(agentId: string, engine: string): Promise<EngineSession | null>;
  saveSession(agentId: string, engine: string, s: EngineSession): Promise<void>;
  recordHandoff(
    input: Omit<HandoffRow, "id" | "createdAt">
  ): Promise<HandoffRow>;
  getHandoff(agentId: string, id: number): Promise<HandoffRow | null>;
}
```

- [ ] **Step 1: Write the migration**

Create `apps/server/src/db/migrations/0060_agent-engine-handoffs.sql`:

```sql
-- One remembered engine session per (agent, engine). `agents.cli_session_id`
-- stays "the current one"; this is what makes returning to a provider cheap:
-- it resumes its own session and is briefed only on turns after last_seen_seq.
CREATE TABLE IF NOT EXISTS agent_engine_sessions (
  agent_id      text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine        text NOT NULL,
  session_id    text NOT NULL,
  last_seen_seq integer NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, engine)
);

-- One row per provider switch: the exact briefing that was sent, and the
-- marker the feed shows. A serial id, not a uuid, because the feed's cursor
-- breaks ties on an integer id for every source but chat.
CREATE TABLE IF NOT EXISTS agent_engine_handoffs (
  id          serial PRIMARY KEY,
  agent_id    text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  from_engine text NOT NULL,
  to_engine   text NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('switched', 'failed')),
  failure     text,
  briefing    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_engine_handoffs_agent_created
  ON agent_engine_handoffs (agent_id, created_at DESC, id DESC);
```

- [ ] **Step 2: Write the failing tests**

Create `apps/server/test/harness-engine-sessions.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { EngineSessionStore } from "../src/agents/harness/engine-sessions.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
let store: EngineSessionStore;
const A = "agt_engine_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new EngineSessionStore(pool);
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'E', '/tmp', 'running')`,
    [A]
  );
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_engine_sessions");
  await pool.query("DELETE FROM agent_engine_handoffs");
});

describe("EngineSessionStore", () => {
  it("remembers one session per engine and replaces it on a later save", async () => {
    expect(await store.getSession(A, "claude")).toBeNull();
    await store.saveSession(A, "claude", { sessionId: "c-1", lastSeenSeq: 12 });
    await store.saveSession(A, "codex", { sessionId: "x-1", lastSeenSeq: 30 });
    await store.saveSession(A, "claude", { sessionId: "c-2", lastSeenSeq: 44 });
    expect(await store.getSession(A, "claude")).toEqual({
      sessionId: "c-2",
      lastSeenSeq: 44,
    });
    expect(await store.getSession(A, "codex")).toEqual({
      sessionId: "x-1",
      lastSeenSeq: 30,
    });
  });

  it("stores a handoff and reads it back for its own agent only", async () => {
    const row = await store.recordHandoff({
      agentId: A,
      fromEngine: "claude",
      toEngine: "codex",
      outcome: "switched",
      failure: null,
      briefing: "You are taking over a session in progress.",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(await store.getHandoff(A, row.id)).toMatchObject({
      fromEngine: "claude",
      toEngine: "codex",
      outcome: "switched",
      briefing: "You are taking over a session in progress.",
    });
    expect(await store.getHandoff("agt_someone_else", row.id)).toBeNull();
  });

  it("records a failed switch with its reason", async () => {
    const row = await store.recordHandoff({
      agentId: A,
      fromEngine: "claude",
      toEngine: "codex",
      outcome: "failed",
      failure: "codex-acp was not found on the server's PATH",
      briefing: "",
    });
    expect((await store.getHandoff(A, row.id))?.failure).toContain("codex-acp");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-engine-sessions.test.ts`
Expected: FAIL, cannot resolve `engine-sessions.js`.

- [ ] **Step 4: Write the store**

Create `apps/server/src/agents/harness/engine-sessions.ts`:

```ts
import type { Queryable } from "../../chat/store.js";

export type EngineSession = { sessionId: string; lastSeenSeq: number };

export type HandoffRow = {
  id: number;
  agentId: string;
  fromEngine: string;
  toEngine: string;
  outcome: "switched" | "failed";
  failure: string | null;
  /** The exact text sent to the incoming engine; empty for a failed switch. */
  briefing: string;
  createdAt: Date;
};

type HandoffDbRow = {
  id: number;
  agent_id: string;
  from_engine: string;
  to_engine: string;
  outcome: "switched" | "failed";
  failure: string | null;
  briefing: string;
  created_at: Date;
};

const toHandoff = (r: HandoffDbRow): HandoffRow => ({
  id: r.id,
  agentId: r.agent_id,
  fromEngine: r.from_engine,
  toEngine: r.to_engine,
  outcome: r.outcome,
  failure: r.failure,
  briefing: r.briefing,
  createdAt: r.created_at,
});

/**
 * What a provider switch needs to remember: the session each engine left
 * behind, and the briefing each switch sent.
 */
export class EngineSessionStore {
  constructor(private readonly db: Queryable) {}

  async getSession(
    agentId: string,
    engine: string
  ): Promise<EngineSession | null> {
    const result = await this.db.query<{
      session_id: string;
      last_seen_seq: number;
    }>(
      `SELECT session_id, last_seen_seq FROM agent_engine_sessions
        WHERE agent_id = $1 AND engine = $2`,
      [agentId, engine]
    );
    const row = result.rows[0];
    return row
      ? { sessionId: row.session_id, lastSeenSeq: row.last_seen_seq }
      : null;
  }

  async saveSession(
    agentId: string,
    engine: string,
    session: EngineSession
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_engine_sessions
         (agent_id, engine, session_id, last_seen_seq)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, engine)
       DO UPDATE SET session_id = EXCLUDED.session_id,
                     last_seen_seq = EXCLUDED.last_seen_seq,
                     updated_at = now()`,
      [agentId, engine, session.sessionId, session.lastSeenSeq]
    );
  }

  async recordHandoff(
    input: Omit<HandoffRow, "id" | "createdAt">
  ): Promise<HandoffRow> {
    const result = await this.db.query<HandoffDbRow>(
      `INSERT INTO agent_engine_handoffs
         (agent_id, from_engine, to_engine, outcome, failure, briefing)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.agentId,
        input.fromEngine,
        input.toEngine,
        input.outcome,
        input.failure,
        input.briefing,
      ]
    );
    return toHandoff(result.rows[0]);
  }

  /** Scoped to the agent, so one agent's id cannot read another's briefing. */
  async getHandoff(agentId: string, id: number): Promise<HandoffRow | null> {
    const result = await this.db.query<HandoffDbRow>(
      `SELECT * FROM agent_engine_handoffs WHERE agent_id = $1 AND id = $2`,
      [agentId, id]
    );
    return result.rows[0] ? toHandoff(result.rows[0]) : null;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-engine-sessions.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrations/0060_agent-engine-handoffs.sql \
  apps/server/src/agents/harness/engine-sessions.ts \
  apps/server/test/harness-engine-sessions.test.ts
git commit -m "feat(harness): remember a session per engine and every handoff sent"
```

---

### Task 2: Build the briefing

**Files:**

- Create: `apps/server/src/agents/harness/handoff.ts`
- Test: `apps/server/test/harness-handoff.test.ts`

**Interfaces:**

- Consumes: `AssembledTurn` from `apps/server/src/chat/turns.ts`.
- Produces:

```ts
export type HandoffFacts = {
  branch: string | null;
  /** e.g. "3 files changed, 41 insertions(+), 7 deletions(-)"; null when clean. */
  uncommitted: string | null;
  tasks: { content: string; status: string }[];
  pins: { label: string; value: string }[];
};
export const HANDOFF_BUDGET_TOKENS = 24_000;
export function estimateTokens(text: string): number;
export function buildHandoff(input: {
  turns: AssembledTurn[];
  /** Only turns whose anchor seq is greater are included; null for all. */
  sinceSeq: number | null;
  turnSeqs: number[]; // parallel to `turns`: each turn's anchor seq
  facts: HandoffFacts;
  fromEngineLabel: string;
  budgetTokens?: number;
}): { text: string; omittedTurns: number; estimatedTokens: number };
```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/harness-handoff.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildHandoff, estimateTokens } from "../src/agents/harness/handoff.js";
import type { AssembledTurn } from "../src/chat/turns.js";

const FACTS = {
  branch: "feat/parser",
  uncommitted: "3 files changed, 41 insertions(+), 7 deletions(-)",
  tasks: [
    { content: "Read the parser", status: "completed" },
    { content: "Split the tokenizer", status: "pending" },
  ],
  pins: [{ label: "Dev server", value: "http://localhost:5173" }],
};

function turn(
  id: number,
  prompt: string,
  answer: string | null,
  steps: {
    label: string;
    status: "ok" | "error" | "running";
    cut?: boolean;
  }[] = [],
  finalResult: "ok" | "error" | "interrupted" = "ok"
): AssembledTurn {
  return {
    id: `turn:${id}`,
    prompt: { source: "chat", text: prompt, attachments: [] },
    trace: {
      startedAt: "2026-09-20T10:00:00.000Z",
      endedAt: "2026-09-20T10:01:00.000Z",
      finalResult,
      steps: steps.map((s, i) => ({
        id: `stream:${id}${i}`,
        kind: "execute",
        label: s.label,
        status: s.status,
        startedAt: "2026-09-20T10:00:00.000Z",
        detail: {
          terminalOutput: "SECRET_TOKEN=abc123 from a terminal",
          diff: { path: "a.ts", oldText: "old", newText: "DIFF BODY" },
        },
      })),
    },
    result: answer === null ? null : { text: answer, streaming: false },
  } as AssembledTurn;
}

const build = (turns: AssembledTurn[], extra = {}) =>
  buildHandoff({
    turns,
    turnSeqs: turns.map((_, i) => (i + 1) * 10),
    sinceSeq: null,
    facts: FACTS,
    fromEngineLabel: "Claude Code",
    ...extra,
  });

describe("buildHandoff", () => {
  it("opens with the situation and the rule that the files win", () => {
    const { text } = build([turn(1, "fix the parser", "Done.")]);
    expect(text.startsWith("--- DISPATCH: HANDOFF ---")).toBe(true);
    expect(text).toContain(
      "taking over a session in progress from Claude Code"
    );
    expect(text).toContain(
      "If this summary and the files disagree, trust the files."
    );
    expect(text.trimEnd().endsWith("--- END DISPATCH: HANDOFF ---")).toBe(true);
  });

  it("states the hard facts", () => {
    const { text } = build([turn(1, "fix the parser", "Done.")]);
    expect(text).toContain("Branch: feat/parser");
    expect(text).toContain("3 files changed, 41 insertions(+), 7 deletions(-)");
    expect(text).toContain("[done] Read the parser");
    expect(text).toContain("[todo] Split the tokenizer");
    expect(text).toContain("Dev server: http://localhost:5173");
  });

  it("replays prompts and answers in full and each step as one line", () => {
    const { text } = build([
      turn(1, "fix the parser", "I rewrote tokenize().", [
        { label: "pnpm test", status: "ok" },
        { label: "Edit parser.ts", status: "error" },
      ]),
    ]);
    expect(text).toContain("User: fix the parser");
    expect(text).toContain("Agent: I rewrote tokenize().");
    expect(text).toContain("- pnpm test (done)");
    expect(text).toContain("- Edit parser.ts (failed)");
  });

  it("never carries a diff or command output", () => {
    const { text } = build([
      turn(1, "p", "a", [{ label: "cat .env", status: "ok" }]),
    ]);
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("DIFF BODY");
  });

  it("says a turn was cut, so the newcomer does not assume it finished", () => {
    const { text } = build([
      turn(
        1,
        "refactor it",
        null,
        [{ label: "pnpm build", status: "error" }],
        "interrupted"
      ),
    ]);
    expect(text).toContain("This turn was cut off before it finished.");
  });

  it("keeps the newest turns and says how many older ones it left out", () => {
    const long = "x".repeat(4_000);
    const turns = Array.from({ length: 30 }, (_, i) =>
      turn(i + 1, `prompt ${i + 1}`, long)
    );
    const out = build(turns, { budgetTokens: 5_000 });
    expect(out.omittedTurns).toBeGreaterThan(0);
    expect(out.text).toContain("prompt 30");
    expect(out.text).not.toContain("User: prompt 1\n");
    expect(out.text).toContain(
      `${out.omittedTurns} earlier turns were omitted`
    );
    expect(out.estimatedTokens).toBeLessThanOrEqual(5_000 + 1_200);
  });

  it("always keeps the newest turn, even alone over budget", () => {
    const out = build([turn(1, "p", "y".repeat(80_000))], {
      budgetTokens: 1_000,
    });
    expect(out.omittedTurns).toBe(0);
    expect(out.text).toContain("User: p");
  });

  it("briefs a returning engine only on what happened since it left", () => {
    const turns = [
      turn(1, "first", "one"),
      turn(2, "second", "two"),
      turn(3, "third", "three"),
    ];
    const out = buildHandoff({
      turns,
      turnSeqs: [10, 20, 30],
      sinceSeq: 20,
      facts: FACTS,
      fromEngineLabel: "Codex",
    });
    expect(out.text).toContain("You are resuming this session.");
    expect(out.text).toContain("User: third");
    expect(out.text).not.toContain("User: first");
    expect(out.text).not.toContain("User: second");
  });

  it("says so when nothing happened while a returning engine was away", () => {
    const out = buildHandoff({
      turns: [turn(1, "first", "one")],
      turnSeqs: [10],
      sinceSeq: 10,
      facts: FACTS,
      fromEngineLabel: "Codex",
    });
    expect(out.text).toContain("No turns ran while you were away.");
  });

  it("estimates tokens at about four characters each", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-handoff.test.ts`
Expected: FAIL, cannot resolve `handoff.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/agents/harness/handoff.ts`:

```ts
import type { AssembledTurn } from "../../chat/turns.js";

export type HandoffFacts = {
  branch: string | null;
  /** A `git diff --shortstat` line; null when the tree is clean. */
  uncommitted: string | null;
  tasks: { content: string; status: string }[];
  pins: { label: string; value: string }[];
};

/**
 * Room for the conversation part of a briefing. The facts and the framing sit
 * outside it. Sized so a first switch costs a fraction of a turn's context
 * (the average turn on a real host carries 100k to 400k tokens).
 */
export const HANDOFF_BUDGET_TOKENS = 24_000;

/** Close enough for a budget: English prose and code run near 4 chars a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TASK_MARK: Record<string, string> = {
  completed: "[done]",
  in_progress: "[doing]",
  pending: "[todo]",
};

const STEP_WORD: Record<string, string> = {
  ok: "done",
  error: "failed",
  // A settled turn has no running step (the recorder settles them), but a
  // briefing built mid-turn can: say what is true.
  running: "did not finish",
};

function renderTurn(turn: AssembledTurn): string {
  const who =
    turn.prompt.source === "chat" || turn.prompt.source === "launch"
      ? "User"
      : turn.prompt.source === "agent"
        ? `Agent ${turn.prompt.senderName ?? "peer"}`
        : "Dispatch";
  const lines = [`${who}: ${turn.prompt.text.trim()}`];
  // One line per top-level step: what it was and how it ended. No output and
  // no diff. Both are large, both are already reflected on disk, and a secret
  // that scrolled past in a terminal must not be re-sent to a second provider.
  for (const step of turn.trace.steps) {
    if (step.kind === "note" || step.kind === "think") continue;
    lines.push(`- ${step.label} (${STEP_WORD[step.status] ?? step.status})`);
  }
  if (turn.result?.text.trim()) lines.push(`Agent: ${turn.result.text.trim()}`);
  if (turn.trace.finalResult === "interrupted") {
    lines.push("This turn was cut off before it finished.");
  } else if (turn.trace.finalResult === "error") {
    lines.push("This turn ended in an error.");
  }
  return lines.join("\n");
}

function renderFacts(facts: HandoffFacts): string {
  const lines = ["Current state, read from disk a moment ago:"];
  lines.push(`Branch: ${facts.branch ?? "(not a git checkout)"}`);
  lines.push(`Uncommitted changes: ${facts.uncommitted ?? "none"}`);
  if (facts.tasks.length > 0) {
    lines.push("Task list:");
    for (const task of facts.tasks) {
      lines.push(`  ${TASK_MARK[task.status] ?? "[todo]"} ${task.content}`);
    }
  }
  if (facts.pins.length > 0) {
    lines.push("Pinned for the user:");
    for (const pin of facts.pins) lines.push(`  ${pin.label}: ${pin.value}`);
  }
  return lines.join("\n");
}

/**
 * The incoming engine's entire memory of the session, as one message.
 *
 * A pure function over Dispatch's own record, so it is testable as text in,
 * text out, and so the text that was sent can be stored and read back. No
 * model is called: a session that outgrows the budget has its oldest turns
 * left out and says how many. Compressing them is a later layer.
 *
 * The newest turn is always kept, even alone over budget: it holds the live
 * thread, and a briefing without it is worse than a long one.
 */
export function buildHandoff(input: {
  turns: AssembledTurn[];
  sinceSeq: number | null;
  turnSeqs: number[];
  facts: HandoffFacts;
  fromEngineLabel: string;
  budgetTokens?: number;
}): { text: string; omittedTurns: number; estimatedTokens: number } {
  const budget = input.budgetTokens ?? HANDOFF_BUDGET_TOKENS;
  const resuming = input.sinceSeq !== null;
  const candidates = input.turns.filter(
    (_, i) => input.sinceSeq === null || input.turnSeqs[i] > input.sinceSeq
  );

  const kept: string[] = [];
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const rendered = renderTurn(candidates[i]);
    const cost = estimateTokens(rendered);
    if (kept.length > 0 && used + cost > budget) break;
    kept.unshift(rendered);
    used += cost;
  }
  const omittedTurns = candidates.length - kept.length;

  const situation = resuming
    ? [
        "You are resuming this session. Another coding agent," +
          ` ${input.fromEngineLabel}, worked in it while you were away.`,
        "Below is what happened since your last turn. The files on disk are the" +
          " source of truth. If this summary and the files disagree, trust the files.",
      ]
    : [
        "You are taking over a session in progress from" +
          ` ${input.fromEngineLabel}, another coding agent. You have no memory` +
          " of it; this message is everything you know.",
        "The files on disk are the source of truth. If this summary and the" +
          " files disagree, trust the files.",
        "Command output and diffs are left out on purpose: read the files.",
      ];

  const conversation =
    kept.length === 0
      ? resuming
        ? "No turns ran while you were away."
        : "No turns have run in this session yet."
      : [
          omittedTurns > 0
            ? `${omittedTurns} earlier turns were omitted to keep this short.` +
              " The newest follow, oldest first."
            : "The conversation so far, oldest first.",
          "",
          kept.join("\n\n"),
        ].join("\n");

  const text = [
    "--- DISPATCH: HANDOFF ---",
    situation.join("\n"),
    "",
    renderFacts(input.facts),
    "",
    conversation,
    "--- END DISPATCH: HANDOFF ---",
  ].join("\n");
  return { text, omittedTurns, estimatedTokens: estimateTokens(text) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-handoff.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agents/harness/handoff.ts \
  apps/server/test/harness-handoff.test.ts
git commit -m "feat(harness): build a provider handoff from Dispatch's own record"
```

---

### Task 3: Read the live facts

**Files:**

- Create: `apps/server/src/agents/harness/handoff-facts.ts`
- Test: `apps/server/test/harness-handoff-facts.test.ts`

**Interfaces:**

- Consumes: `HandoffFacts` (Task 2), `runCommand` from `apps/server/src/shared/lib/run-command.ts`, `AgentRecord.pins`.
- Produces: `gatherHandoffFacts(input: { cwd: string; tasks: { content: string; status: string }[]; pins: { label: string; value: string }[]; run?: typeof runCommand }): Promise<HandoffFacts>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/harness-handoff-facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { gatherHandoffFacts } from "../src/agents/harness/handoff-facts.js";

const runner =
  (answers: Record<string, { exitCode: number; stdout: string }>) =>
  async (_cmd: string, args: string[]) => {
    const key = args.join(" ");
    const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected git ${key}`);
    return { ...hit[1], stderr: "" };
  };

describe("gatherHandoffFacts", () => {
  it("reads the branch and a one-line summary of uncommitted work", async () => {
    const facts = await gatherHandoffFacts({
      cwd: "/w",
      tasks: [{ content: "t", status: "pending" }],
      pins: [{ label: "l", value: "v" }],
      run: runner({
        "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "feat/parser\n" },
        "diff --shortstat HEAD": {
          exitCode: 0,
          stdout: " 3 files changed, 41 insertions(+), 7 deletions(-)\n",
        },
        "status --porcelain": { exitCode: 0, stdout: " M a.ts\n?? new.ts\n" },
      }) as never,
    });
    expect(facts.branch).toBe("feat/parser");
    expect(facts.uncommitted).toBe(
      "3 files changed, 41 insertions(+), 7 deletions(-), 1 untracked file"
    );
    expect(facts.tasks).toEqual([{ content: "t", status: "pending" }]);
    expect(facts.pins).toEqual([{ label: "l", value: "v" }]);
  });

  it("reports a clean tree as null", async () => {
    const facts = await gatherHandoffFacts({
      cwd: "/w",
      tasks: [],
      pins: [],
      run: runner({
        "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
        "diff --shortstat HEAD": { exitCode: 0, stdout: "" },
        "status --porcelain": { exitCode: 0, stdout: "" },
      }) as never,
    });
    expect(facts.uncommitted).toBeNull();
  });

  it("does not fail the switch when the folder is not a git checkout", async () => {
    const facts = await gatherHandoffFacts({
      cwd: "/not-git",
      tasks: [],
      pins: [],
      run: (async () => {
        throw new Error("fatal: not a git repository");
      }) as never,
    });
    expect(facts.branch).toBeNull();
    expect(facts.uncommitted).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-handoff-facts.test.ts`
Expected: FAIL, cannot resolve `handoff-facts.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/agents/harness/handoff-facts.ts`:

```ts
import { runCommand } from "../../shared/lib/run-command.js";
import type { HandoffFacts } from "./handoff.js";

/**
 * The part of a briefing that is read, not recalled: where the working tree
 * stands right now. A briefing can be stale; these cannot, because they are
 * taken at the moment of the switch.
 *
 * Every git call is best-effort. An agent whose folder is not a checkout
 * still switches; it just gets no branch line.
 */
export async function gatherHandoffFacts(input: {
  cwd: string;
  tasks: { content: string; status: string }[];
  pins: { label: string; value: string }[];
  run?: typeof runCommand;
}): Promise<HandoffFacts> {
  const run = input.run ?? runCommand;
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const result = await run("git", args, { cwd: input.cwd });
      return result.exitCode === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  };
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
  const shortstat = (await git(["diff", "--shortstat", "HEAD"]))?.trim() ?? "";
  const untracked = ((await git(["status", "--porcelain"])) ?? "")
    .split("\n")
    .filter((line) => line.startsWith("??")).length;
  const parts = [
    shortstat,
    untracked > 0
      ? `${untracked} untracked file${untracked === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  return {
    branch: branch || null,
    uncommitted: parts.length > 0 ? parts.join(", ") : null,
    tasks: input.tasks,
    pins: input.pins,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-handoff-facts.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agents/harness/handoff-facts.ts \
  apps/server/test/harness-handoff-facts.test.ts
git commit -m "feat(harness): read the working tree's state for a handoff"
```

---

### Task 3b: Load the whole session as turns

**Files:**

- Modify: `apps/server/src/chat/turns.ts`
- Test: `apps/server/test/chat-turns-db.test.ts` (the file that covers `listTurnEntries` against a database; find it with `grep -rln listTurnEntries apps/server/test`)

**Interfaces:**

- Produces: `loadSessionTurns(db: Queryable, agentId: string, maxRows?: number): Promise<{ turns: AssembledTurn[]; seqs: number[] }>`.

`listTurnEntries` pages for the feed and returns feed entries. A briefing needs the assembled turns of the whole session, with each turn's anchor seq. It also needs the chat lookup `listTurnEntries` does: **a turn a Chat message started stores only that message's id**, and `assembleTurns` fills in the text from the map it is handed. Assembling with an empty map, which is the obvious shortcut, produces a briefing in which every prompt the user typed is blank.

- [ ] **Step 1: Write the failing test**

In that test file, using its existing pool, agent id and row-insert helpers:

```ts
describe("loadSessionTurns", () => {
  it("returns every turn oldest first, with the text of a chat prompt and each anchor's seq", async () => {
    const messageId = randomUUID();
    await pool.query(
      `INSERT INTO agent_chat_messages
         (id, agent_id, author_kind, kind, text, attachments, delivered)
       VALUES ($1, $2, 'user', 'reply', 'split the tokenizer', '[]'::jsonb, true)`,
      [messageId, A]
    );
    const store = new StreamStore(pool);
    const first = await store.append(A, "turn", {
      state: "settled",
      stopReason: "end_turn",
      prompt: { source: "chat", chatMessageId: messageId },
    });
    await store.append(A, "assistant", { text: "Done.", streaming: false });
    const second = await store.append(A, "turn", {
      state: "settled",
      stopReason: "cancelled",
      prompt: { source: "system", text: "continue" },
    });

    const { turns, seqs } = await loadSessionTurns(pool, A);
    expect(turns).toHaveLength(2);
    expect(seqs).toEqual([first.seq, second.seq]);
    // The text came from agent_chat_messages, not from the turn row.
    expect(turns[0].prompt.text).toBe("split the tokenizer");
    expect(turns[0].result?.text).toBe("Done.");
    expect(turns[1].trace.finalResult).toBe("interrupted");
  });

  it("keeps only the newest rows of a very long session", async () => {
    const store = new StreamStore(pool);
    for (let i = 0; i < 6; i += 1) {
      await store.append(A, "turn", {
        state: "settled",
        prompt: { source: "system", text: `p${i}` },
      });
    }
    const { turns } = await loadSessionTurns(pool, A, 3);
    expect(turns.map((t) => t.prompt.text)).toEqual(["p3", "p4", "p5"]);
  });
});
```

Clear `agent_stream_events` and `agent_chat_messages` for `A` in that describe's `beforeEach` if the file does not already.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dispatch/server test -- <that file>`
Expected: FAIL, `loadSessionTurns` is not exported.

- [ ] **Step 3: Write the loader**

In `apps/server/src/chat/turns.ts`, after `loadLatestTurnEntry`:

```ts
/**
 * A briefing reads at most this many of the session's newest stream rows.
 * It keeps only what fits a token budget anyway, so rows older than this
 * could never reach it; the bound is on the query, not on the feature.
 */
const SESSION_TURNS_MAX_ROWS = 4_000;

/**
 * The agent's session as assembled turns, oldest first, with each turn's
 * anchor seq. For readers that need the conversation itself and not a page
 * of feed entries: a provider handoff.
 *
 * Goes through `loadChatMessages`, as `listTurnEntries` does. A turn a Chat
 * message started stores only the message's id, so assembling without the
 * lookup yields turns whose user prompts are all empty.
 */
export async function loadSessionTurns(
  db: Queryable,
  agentId: string,
  maxRows = SESSION_TURNS_MAX_ROWS
): Promise<{ turns: AssembledTurn[]; seqs: number[] }> {
  const result = await db.query<StreamRowResult>(
    `SELECT * FROM (
       SELECT id, seq, kind, key, payload, created_at, updated_at
         FROM agent_stream_events
        WHERE agent_id = $1
        ORDER BY seq DESC
        LIMIT $2
     ) AS newest
     ORDER BY seq ASC`,
    [agentId, maxRows]
  );
  let source: TurnSourceRow[] = result.rows.map((r) => ({
    id: Number(r.id),
    seq: r.seq,
    kind: r.kind,
    key: r.key,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  // A cut that falls mid-turn would present that turn's tail as a group of
  // its own. Start at the first turn row the window holds.
  if (result.rows.length === maxRows) {
    const firstTurn = source.findIndex((row) => row.kind === "turn");
    source = firstTurn > 0 ? source.slice(firstTurn) : source;
  }
  const chat = await loadChatMessages(db, agentId, chatPromptIds(source));
  const groups = groupTurnRows(source);
  const turns = assembleTurns(source, chat);
  return {
    turns,
    seqs: groups.map((group) => (group.turn ?? group.rows[0]).seq),
  };
}
```

`StreamRowResult` declares `at_key`, which this query does not select; type the query as `Omit<StreamRowResult, "at_key">` if the compiler objects.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @dispatch/server test -- <that file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/chat/turns.ts
git add -u apps/server/test
git commit -m "feat(chat): load a whole session as assembled turns"
```

---

### Task 4: Supervisor primitives the switch needs

**Files:**

- Modify: `apps/server/src/agents/harness/supervisor.ts` (`start`, a new `stopEngineOnly`, `runTurn`)
- Test: `apps/server/test/harness-supervisor.test.ts`

**Interfaces:**

- Produces:
  - `start(agentId, override?: { model: string; sessionId: string | null; skipLaunchPrompt: true }): Promise<{ resumed: boolean; sessionId: string }>`. With an override it does **not** write `agents.cli_session_id`; the caller does, last.
  - `private stopEngineOnly(agentId): Promise<void>`
  - `private readonly pendingBriefing = new Map<string, string>()`, prepended to the next prompt after the persona.

Three existing behaviors of the supervisor are wrong for a switch, and each gets a seam here rather than a special case inside `switchEngine`:

1. `start()` reads the engine from `agents.model` and the session from `agents.cli_session_id`. A switch must start the _new_ engine while the record still names the _old_ one, because `agents.model` is written last.
2. `start()` sends the agent's launch prompt whenever there is no stored session. A fresh session on a second provider is not a first launch.
3. `stop()` fails every queued prompt and stops Dispatch-managed background processes. A switch keeps both.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/harness-supervisor.test.ts`, inside `describe("HarnessSupervisor message queue", ...)`:

```ts
it("starts on an override without sending the launch prompt again", async () => {
  const { sup, fake } = await build({ launchPrompt: "LAUNCH PROMPT" });
  await sup.start("agt_1", {
    model: "codex/default",
    sessionId: null,
    skipLaunchPrompt: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fake.seen.prompts).toEqual([]);
  await sup.stop("agt_1");
});

it("puts a pending briefing in front of the next prompt, once", async () => {
  const { sup, fake } = await build({ turn: async () => "end_turn" });
  await sup.start("agt_1");
  sup.setPendingBriefing("agt_1", "BRIEFING TEXT");
  await sup.enqueuePrompt("agt_1", "first").settled;
  await sup.enqueuePrompt("agt_1", "second").settled;
  expect(fake.seen.prompts[0]).toContain("BRIEFING TEXT");
  expect(fake.seen.prompts[0]?.endsWith("first")).toBe(true);
  expect(fake.seen.prompts[1]).toBe("second");
  await sup.stop("agt_1");
});
```

If `build()` already sends a launch prompt in another test, that test is the control: with no override, the launch prompt is sent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-supervisor.test.ts`
Expected: FAIL. `start` accepts one argument and `setPendingBriefing` does not exist.

- [ ] **Step 3: Add the override to `start`**

Change the signature and the three places that read the record:

```ts
  async start(
    agentId: string,
    /**
     * Start on an engine and session other than the ones on the agent record.
     * A provider switch needs this: it must bring the new engine up while the
     * record still names the old one, so that a failure can fall back and a
     * restart mid-switch never finds a half-switched agent.
     */
    override?: {
      model: string;
      sessionId: string | null;
      /** A second provider's fresh session is not a first launch. */
      skipLaunchPrompt: true;
    }
  ): Promise<{ resumed: boolean }> {
```

Replace:

```ts
const { engine, model } = splitModelId(agent.model ?? DEFAULT_HARNESS_MODEL);
```

with:

```ts
const { engine, model } = splitModelId(
  override?.model ?? agent.model ?? DEFAULT_HARNESS_MODEL
);
const storedSessionId = override
  ? override.sessionId
  : (agent.cliSessionId ?? null);
```

In the `this.driver.start({ ... })` call, replace `sessionId: agent.cliSessionId ?? null,` with `sessionId: storedSessionId,`.

In the `setLatestEvent` call that chooses between "Session resumed.", "Session restarted…" and "Session ready.", replace `agent.cliSessionId` with `storedSessionId`.

Replace the launch-prompt block's condition:

```ts
    if (!agent.cliSessionId || neverRan) {
```

with:

```ts
    if (!override?.skipLaunchPrompt && (!agent.cliSessionId || neverRan)) {
```

`start()` also writes the session id to the agent record (`await this.deps.setCliSessionId(agentId, sessionId);`). Under an override that write must wait. If it happened here and the server restarted before `agents.model` was updated, boot would find the old engine named beside the new engine's session id, try to resume a session that engine never had, and fall back to a fresh one, losing the old engine's memory for nothing. Guard it, and hand the id back so the caller can write both fields together at the end:

```ts
if (!override) await this.deps.setCliSessionId(agentId, sessionId);
```

and change the method's return type and its final line to:

```ts
  ): Promise<{ resumed: boolean; sessionId: string }> {
```

```ts
return { resumed, sessionId };
```

`restoreRunning` and the agent manager read only `resumed`, so the extra field breaks no caller.

One more line needs care. `neverRan` is agent-scoped, so after a switch it is false and a `first_prompt` engine on a fresh session still gets its persona, because the condition is `!resumed || neverRan`. That is already correct: leave it.

- [ ] **Step 4: Add the engine-only stop and the pending briefing**

Beside `pendingPersona`:

```ts
  /**
   * A provider handoff waiting for the agent's next prompt. Same delivery as
   * the persona: prepended once, to whatever turn runs next.
   */
  private readonly pendingBriefing = new Map<string, string>();

  setPendingBriefing(agentId: string, text: string): void {
    this.pendingBriefing.set(agentId, text);
  }
```

In `runTurn`, **above** the existing persona block. Each block prepends to `text`, so the one that runs first ends up nearest the prompt, and the wanted order is persona, then briefing, then prompt: who you are, what has happened, what is being asked.

```ts
const briefing = this.pendingBriefing.get(agentId);
if (briefing !== undefined) {
  this.pendingBriefing.delete(agentId);
  text = `${briefing}\n\n${text}`;
}
// (the existing persona block follows, and prepends in front of this)
```

In `stop()`, add `this.pendingBriefing.delete(agentId);` beside the `pendingPersona` delete.

Add the narrow stop, directly above `stop()`:

```ts
  /**
   * Stop the engine process and nothing else. `stop()` also fails everything
   * queued and stops the agent's background processes, which is right for an
   * agent that is going away and wrong for one that is changing provider:
   * its queue and its dev server carry on.
   */
  private async stopEngineOnly(agentId: string): Promise<void> {
    await this.driver.stop(agentId);
    this.context.delete(agentId);
    this.turnReply.delete(agentId);
    this.pendingPersona.delete(agentId);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-supervisor.test.ts && pnpm --filter @dispatch/server check`
Expected: PASS; no type errors. `stopEngineOnly` is unused until Task 5; if the linter flags it, the commit waits for Task 5 and the two are committed together.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agents/harness/supervisor.ts \
  apps/server/test/harness-supervisor.test.ts
git commit -m "refactor(harness): let a session start on an engine the record does not name yet"
```

---

### Task 5: `switchEngine`

**Files:**

- Create: `apps/server/src/harness-switch-settings.ts`
- Modify: `apps/server/src/agents/harness/supervisor.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/test/harness-switch.test.ts`

**Interfaces:**

- Consumes: Tasks 1 to 4; `holdQueue` and `interruptAndWait` (already on the supervisor).
- Produces:

```ts
export const CONTINUE_AFTER_SWITCH_PROMPT: string;
export type SwitchPreview = {
  available: boolean;
  /** Why not, in words for the picker. Absent when available. */
  reason?: string;
  /** False when the engine has a remembered session to resume. */
  fresh: boolean;
  estimatedTokens: number;
  /** The last turn failed or was stopped: the dialog ticks the box. */
  lastTurnCut: boolean;
};
previewSwitch(agentId: string, newModel: string): Promise<SwitchPreview>;
switchEngine(agentId: string, newModel: string, opts: { continueTask: boolean }):
  Promise<{ handoffId: number; resumed: boolean }>;
```

New `SupervisorDeps`: `engineSessions: EngineSessionStore`, `engineAvailability: (engine: HarnessEngineId) => Promise<string | null>` (null when usable, else the reason), `loadTurns: (agentId: string) => Promise<{ turns: AssembledTurn[]; seqs: number[] }>`, `cancelLimitResume?: (agentId: string) => Promise<unknown>`, `switchEnabled?: () => Promise<boolean>`.

- [ ] **Step 1: Write the setting**

Create `apps/server/src/harness-switch-settings.ts`:

```ts
import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether a Dispatch agent can be moved to another provider mid-session.
 * On by default. Off, the model picker lists the current provider only and
 * the switch routes refuse.
 *
 * Unset reads as on; an explicit `"false"` is honoured.
 */
const HARNESS_ENGINE_SWITCH_KEY = "harness_engine_switch_enabled";

export async function isHarnessEngineSwitchEnabled(
  pool: Pool
): Promise<boolean> {
  return (await getSetting(pool, HARNESS_ENGINE_SWITCH_KEY)) !== "false";
}

export async function setHarnessEngineSwitchEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, HARNESS_ENGINE_SWITCH_KEY, enabled ? "true" : "false");
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/server/test/harness-switch.test.ts`. The existing `build()` helper in `harness-supervisor.test.ts` hands the driver one fake child for every spawn, which cannot model two engines. This file builds its own, with a new fake per spawn.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HarnessDriver } from "../src/agents/harness/driver.js";
import {
  CONTINUE_AFTER_SWITCH_PROMPT,
  HarnessSupervisor,
} from "../src/agents/harness/supervisor.js";
import { createFakeAcpAgent, type FakeTurn } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
let home = "";
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = "";
});

const cancellable: FakeTurn = async (_p, _emit, _ask, signal) => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 400);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return signal.aborted ? "cancelled" : "end_turn";
};

async function build(
  opts: {
    turn?: FakeTurn;
    /** Binaries that fail to resolve. */
    missing?: string[];
    /** Engines that report themselves unusable, with the reason. */
    unavailable?: Record<string, string>;
    remembered?: Record<string, { sessionId: string; lastSeenSeq: number }>;
  } = {}
) {
  home = await mkdtemp(path.join(os.tmpdir(), "harness-switch-"));
  const spawns: { bin: string; fake: ReturnType<typeof createFakeAcpAgent> }[] =
    [];
  const resolveBinary = async (bin: string) => {
    if (opts.missing?.some((m) => bin.includes(m))) {
      throw new Error(`${bin} was not found on the server's PATH`);
    }
    return bin;
  };
  const driver = new HarnessDriver({
    spawn: (bin: string) => {
      const fake = createFakeAcpAgent({ turn: opts.turn });
      spawns.push({ bin, fake });
      return fake.child;
    },
    resolveBinary,
    logger,
  });
  let nextId = 1;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    await new Promise((r) => setTimeout(r, 1));
    if (/INSERT INTO agent_stream_events/.test(sql)) {
      const id = nextId++;
      return {
        rows: [
          {
            id,
            agent_id: params?.[0],
            seq: id,
            kind: params?.[1],
            key: params?.[2],
            payload: JSON.parse(String(params?.[3])),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const agent = {
    id: "agt_1",
    type: "dispatch",
    cwd: home,
    mediaDir: null,
    model: "claude/default" as string | null,
    cliSessionId: null as string | null,
    pins: [],
  };
  const sessions = new Map(Object.entries(opts.remembered ?? {}));
  const handoffs: Record<string, unknown>[] = [];
  const cancelledResumes: string[] = [];
  const deps = {
    pool: { query } as never,
    config: {
      claudeHarnessBin: "/bin/claude-agent-acp",
      codexHarnessBin: "/bin/codex-acp",
      geminiBin: "/bin/gemini",
      opencodeBin: "/bin/opencode",
      claudeBin: "/bin/claude",
      codexBin: "/bin/codex",
      codexBinConfigured: false,
      dispatchBinDir: "/opt/dispatch/bin",
      port: 1,
      tls: null,
      authToken: "secret",
      mediaRoot: path.join(home, "media"),
    },
    logger,
    driver,
    resolveBinary,
    getAgent: vi.fn(async () => ({ ...agent })) as never,
    setCliSessionId: vi.fn(async (_id: string, s: string) => {
      agent.cliSessionId = s;
    }),
    setAgentModel: vi.fn(async (_id: string, m: string | null) => {
      agent.model = m;
    }),
    setLatestEvent: vi.fn(async () => {}),
    publishHarness: vi.fn(),
    personaPromptFor: vi.fn(async () => "PERSONA"),
    launchPromptFor: vi.fn(async () => "LAUNCH PROMPT"),
    listRunningAgentIds: vi.fn(async () => [] as string[]),
    markStartFailed: vi.fn(async () => {}),
    engineSessions: {
      getSession: async (_a: string, engine: string) =>
        sessions.get(engine) ?? null,
      saveSession: async (_a: string, engine: string, s: never) => {
        sessions.set(engine, s);
      },
      recordHandoff: async (input: Record<string, unknown>) => {
        handoffs.push(input);
        return { id: handoffs.length, createdAt: new Date(), ...input };
      },
      getHandoff: async () => null,
    } as never,
    engineAvailability: async (engine: string) =>
      opts.unavailable?.[engine] ?? null,
    loadTurns: async () => ({ turns: [], seqs: [] }),
    cancelLimitResume: async (id: string) => {
      cancelledResumes.push(id);
    },
  };
  const sup = new HarnessSupervisor(deps as never);
  return { sup, spawns, agent, sessions, handoffs, cancelledResumes, deps };
}

const prompts = (s: { fake: ReturnType<typeof createFakeAcpAgent> }) =>
  s.fake.seen.prompts;

describe("switchEngine", () => {
  it("moves the agent to the other engine and briefs it on the next prompt", async () => {
    const { sup, spawns, agent, handoffs } = await build({
      turn: async () => "end_turn",
    });
    await sup.start("agt_1");
    // The launch prompt ran on the first engine.
    await new Promise((r) => setTimeout(r, 40));
    const result = await sup.switchEngine("agt_1", "codex/default", {
      continueTask: false,
    });
    expect(result.resumed).toBe(false);
    expect(spawns.map((s) => s.bin)).toEqual([
      "/bin/claude-agent-acp",
      "/bin/codex-acp",
    ]);
    expect(agent.model).toBe("codex/default");
    expect(handoffs[0]).toMatchObject({
      fromEngine: "claude",
      toEngine: "codex",
      outcome: "switched",
    });
    // Nothing runs until the user speaks, and the launch prompt is not re-sent.
    await new Promise((r) => setTimeout(r, 40));
    expect(prompts(spawns[1])).toEqual([]);
    await sup.enqueuePrompt("agt_1", "carry on").settled;
    expect(prompts(spawns[1])[0]).toContain("--- DISPATCH: HANDOFF ---");
    expect(prompts(spawns[1])[0]?.endsWith("carry on")).toBe(true);
    await sup.stop("agt_1");
  });

  it("continues the interrupted task by itself when asked", async () => {
    const { sup, spawns } = await build({ turn: async () => "end_turn" });
    await sup.start("agt_1");
    await new Promise((r) => setTimeout(r, 40));
    await sup.switchEngine("agt_1", "codex/default", { continueTask: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(prompts(spawns[1])).toHaveLength(1);
    expect(prompts(spawns[1])[0]).toContain(CONTINUE_AFTER_SWITCH_PROMPT);
    await sup.stop("agt_1");
  });

  it("stops a running turn first, and keeps what was queued behind it", async () => {
    const { sup, spawns } = await build({ turn: cancellable });
    await sup.start("agt_1");
    const queued = sup.enqueuePrompt("agt_1", "queued behind the switch");
    await new Promise((r) => setTimeout(r, 40));
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    await queued.started;
    expect(spawns[0].fake.seen.cancels).toBe(1);
    // It ran on the new engine, not the old one, and was not failed.
    expect(prompts(spawns[0])).not.toContain("queued behind the switch");
    expect(prompts(spawns[1])[0]?.endsWith("queued behind the switch")).toBe(
      true
    );
    await sup.stop("agt_1");
  });

  it("refuses before stopping anything when the target cannot run", async () => {
    const { sup, spawns, agent, handoffs } = await build({
      turn: async () => "end_turn",
      unavailable: { codex: "Codex is not signed in on the server." },
    });
    await sup.start("agt_1");
    await expect(
      sup.switchEngine("agt_1", "codex/default", { continueTask: false })
    ).rejects.toThrow("Codex is not signed in on the server.");
    expect(spawns).toHaveLength(1);
    expect(sup.isRunning("agt_1")).toBe(true);
    expect(agent.model).toBe("claude/default");
    expect(handoffs).toEqual([]);
    await sup.stop("agt_1");
  });

  it("refuses a switch to the engine it is already on", async () => {
    const { sup } = await build({ turn: async () => "end_turn" });
    await sup.start("agt_1");
    await expect(
      sup.switchEngine("agt_1", "claude/claude-opus-5", { continueTask: false })
    ).rejects.toThrow("already running on Claude Code");
    await sup.stop("agt_1");
  });

  it("falls back to the old engine when the new one will not start", async () => {
    const { sup, spawns, agent, handoffs } = await build({
      turn: async () => "end_turn",
      missing: ["codex-acp"],
    });
    await sup.start("agt_1");
    await expect(
      sup.switchEngine("agt_1", "codex/default", { continueTask: false })
    ).rejects.toThrow("codex-acp was not found");
    // The old engine is back, from its saved session, and the record never moved.
    expect(sup.isRunning("agt_1")).toBe(true);
    expect(agent.model).toBe("claude/default");
    expect(spawns.map((s) => s.bin)).toEqual([
      "/bin/claude-agent-acp",
      "/bin/claude-agent-acp",
    ]);
    expect(handoffs[0]).toMatchObject({ outcome: "failed" });
    expect(String(handoffs[0].failure)).toContain("codex-acp");
    await sup.stop("agt_1");
  });

  it("resumes a remembered session and sends only a catch-up", async () => {
    const { sup, spawns } = await build({
      turn: async () => "end_turn",
      remembered: { codex: { sessionId: "codex-old", lastSeenSeq: 3 } },
    });
    await sup.start("agt_1");
    const result = await sup.switchEngine("agt_1", "codex/default", {
      continueTask: false,
    });
    expect(result.resumed).toBe(true);
    await sup.enqueuePrompt("agt_1", "hello again").settled;
    expect(prompts(spawns[1])[0]).toContain("You are resuming this session.");
    await sup.stop("agt_1");
  });

  it("saves the outgoing engine's session so a return trip can resume it", async () => {
    const { sup, sessions, agent } = await build({
      turn: async () => "end_turn",
    });
    await sup.start("agt_1");
    const claudeSession = agent.cliSessionId;
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(sessions.get("claude")?.sessionId).toBe(claudeSession);
    await sup.stop("agt_1");
  });

  it("cancels a scheduled limit resume: the user has taken over", async () => {
    const { sup, cancelledResumes } = await build({
      turn: async () => "end_turn",
    });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(cancelledResumes).toEqual(["agt_1"]);
    await sup.stop("agt_1");
  });
});

describe("previewSwitch", () => {
  it("says whether the target starts fresh and whether it can run", async () => {
    const { sup } = await build({
      turn: async () => "end_turn",
      remembered: { codex: { sessionId: "x", lastSeenSeq: 1 } },
      unavailable: { opencode: "OpenCode is not installed on the server." },
    });
    await sup.start("agt_1");
    expect(await sup.previewSwitch("agt_1", "codex/default")).toMatchObject({
      available: true,
      fresh: false,
    });
    expect(await sup.previewSwitch("agt_1", "opencode/default")).toMatchObject({
      available: false,
      reason: "OpenCode is not installed on the server.",
      fresh: true,
    });
    await sup.stop("agt_1");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-switch.test.ts`
Expected: FAIL. `switchEngine`, `previewSwitch` and `CONTINUE_AFTER_SWITCH_PROMPT` do not exist.

- [ ] **Step 4: Implement**

In `apps/server/src/agents/harness/supervisor.ts`, add the imports:

```ts
import type { AssembledTurn } from "../../chat/turns.js";
import type { EngineSessionStore } from "./engine-sessions.js";
import { buildHandoff } from "./handoff.js";
import { gatherHandoffFacts } from "./handoff-facts.js";
```

Add to `SupervisorDeps`:

```ts
  engineSessions: EngineSessionStore;
  /** Null when the engine can run here; otherwise why not, for the picker. */
  engineAvailability: (engine: HarnessEngineId) => Promise<string | null>;
  /** The agent's turns as the feed assembles them, with each turn's anchor seq. */
  loadTurns: (
    agentId: string
  ) => Promise<{ turns: AssembledTurn[]; seqs: number[] }>;
  /** A switch means the user took over: drop a scheduled limit resume. */
  cancelLimitResume?: (agentId: string) => Promise<unknown>;
  switchEnabled?: () => Promise<boolean>;
```

Beside `RESTART_PROMPT`:

```ts
/** Sent as the first turn after a switch when the user asked to continue. */
export const CONTINUE_AFTER_SWITCH_PROMPT = [
  "--- DISPATCH: PROVIDER SWITCH ---",
  "The user moved this session to you from another provider and asked you to continue the task that was in progress.",
  "Check the current state of anything that was being changed, then continue from where it stopped. Do not redo a step the handoff says finished.",
  "--- END DISPATCH: PROVIDER SWITCH ---",
].join("\n");
```

Add the two methods above `sendQueuedNow`:

```ts
  private engineLabel(engine: HarnessEngineId): string {
    return HARNESS_ENGINES.find((item) => item.id === engine)?.label ?? engine;
  }

  private async handoffFor(
    agentId: string,
    fromEngine: HarnessEngineId,
    sinceSeq: number | null
  ): Promise<{ text: string; estimatedTokens: number; lastSeq: number }> {
    const agent = await this.deps.getAgent(agentId);
    const { turns, seqs } = await this.deps.loadTurns(agentId);
    const newestPlan = [...turns].reverse().find((t) => t.plan)?.plan ?? [];
    const facts = await gatherHandoffFacts({
      cwd: agent?.cwd ?? process.cwd(),
      tasks: newestPlan.map((t) => ({ content: t.content, status: t.status })),
      // A shortcut pin's value is a prompt to send back, not a fact about
      // the work, and it can run to 2,000 characters. The rest are what the
      // user was shown: URLs, ports, branch names, decisions.
      pins: (agent?.pins ?? [])
        .filter((p) => p.type !== "shortcut")
        .map((p) => ({ label: p.label, value: p.value })),
    });
    const built = buildHandoff({
      turns,
      turnSeqs: seqs,
      sinceSeq,
      facts,
      fromEngineLabel: this.engineLabel(fromEngine),
    });
    return {
      text: built.text,
      estimatedTokens: built.estimatedTokens,
      lastSeq: seqs.length > 0 ? seqs[seqs.length - 1] : 0,
    };
  }

  async previewSwitch(
    agentId: string,
    newModel: string
  ): Promise<SwitchPreview> {
    const target = splitModelId(newModel).engine;
    const current = this.context.get(agentId)?.engine ?? target;
    const remembered = await this.deps.engineSessions.getSession(
      agentId,
      target
    );
    const reason = await this.deps.engineAvailability(target);
    const { estimatedTokens } = await this.handoffFor(
      agentId,
      current,
      remembered ? remembered.lastSeenSeq : null
    );
    const last = await this.store.lastTurnSettlement(agentId);
    const running = this.running.has(agentId);
    return {
      available: reason === null,
      ...(reason ? { reason } : {}),
      fresh: remembered === null,
      estimatedTokens,
      // Running now (it will be stopped), or ended some way other than cleanly.
      lastTurnCut: running || Boolean(last?.error),
    };
  }

  /**
   * Move the agent to another provider, in the same session.
   *
   * Everything that can refuse does so first, so a refusal leaves the engine
   * running. Then, with the queue held so nothing queued starts on the old
   * engine in the gap: stop the running turn and wait for it to settle, save
   * the outgoing session, stop the engine and only the engine, start the new
   * one, queue its briefing, and write the record last. If the new engine
   * will not start, the old one is restarted from its saved session and the
   * record never moved.
   */
  async switchEngine(
    agentId: string,
    newModel: string,
    opts: { continueTask: boolean }
  ): Promise<{ handoffId: number; resumed: boolean }> {
    if (this.deps.switchEnabled && !(await this.deps.switchEnabled())) {
      throw new Error("Switching providers is turned off in settings.");
    }
    const from = this.context.get(agentId);
    if (!from) throw new Error("The agent has no running session to switch.");
    const target = splitModelId(newModel).engine;
    if (target === from.engine) {
      throw new Error(
        `The agent is already running on ${this.engineLabel(target)}; change its model from the picker instead.`
      );
    }
    const unavailable = await this.deps.engineAvailability(target);
    if (unavailable) throw new Error(unavailable);

    const agent = await this.deps.getAgent(agentId);
    const previousModel = agent?.model ?? DEFAULT_HARNESS_MODEL;
    const remembered = await this.deps.engineSessions.getSession(
      agentId,
      target
    );
    const hold = this.holdQueue(agentId);
    try {
      await this.interruptAndWait(agentId);
      // Built after the stop, so a turn that was running reads as cut.
      const handoff = await this.handoffFor(
        agentId,
        from.engine,
        remembered ? remembered.lastSeenSeq : null
      );
      await this.deps.engineSessions.saveSession(agentId, from.engine, {
        sessionId: from.sessionId,
        lastSeenSeq: handoff.lastSeq,
      });
      await this.stopEngineOnly(agentId);

      let resumed: boolean;
      let newSessionId: string;
      try {
        ({ resumed, sessionId: newSessionId } = await this.start(agentId, {
          model: newModel,
          sessionId: remembered?.sessionId ?? null,
          skipLaunchPrompt: true,
        }));
      } catch (err) {
        const failure = (err as Error).message;
        await this.deps.engineSessions.recordHandoff({
          agentId,
          fromEngine: from.engine,
          toEngine: target,
          outcome: "failed",
          failure,
          briefing: "",
        });
        // Back onto the engine that was working. The record still names it.
        await this.start(agentId, {
          model: previousModel,
          sessionId: from.sessionId,
          skipLaunchPrompt: true,
        }).catch((restoreErr: unknown) => {
          this.deps.logger.error(
            { err: restoreErr, agentId },
            "could not restore the previous engine after a failed switch"
          );
        });
        this.deps.publishHarness(agentId, true);
        throw err;
      }

      // A remembered session that would not resume came back fresh: it needs
      // the whole story, not the catch-up that was built for a resume.
      const text =
        remembered && !resumed
          ? (await this.handoffFor(agentId, from.engine, null)).text
          : handoff.text;
      this.setPendingBriefing(agentId, text);
      const row = await this.deps.engineSessions.recordHandoff({
        agentId,
        fromEngine: from.engine,
        toEngine: target,
        outcome: "switched",
        failure: null,
        briefing: text,
      });
      await this.deps.cancelLimitResume?.(agentId);
      // Last, and together: a restart before these two lines finds the old
      // engine and its own session on the record, and resumes it as if the
      // switch had never been asked for. The two writes are adjacent and not
      // one transaction; a crash between them leaves the new session id beside
      // the old model, which boot survives by falling back to a fresh session.
      await this.deps.setCliSessionId(agentId, newSessionId);
      await this.deps.setAgentModel?.(agentId, newModel);
      this.deps.publishHarness(agentId, true);
      if (opts.continueTask) {
        this.enqueuePrompt(agentId, CONTINUE_AFTER_SWITCH_PROMPT).settled.catch(
          (err: unknown) => {
            this.deps.logger.warn(
              { err, agentId },
              "the continue turn after a provider switch failed"
            );
          }
        );
        const queuedId = this.pendingOf(agentId).at(-1)?.id;
        hold.release(queuedId);
      }
      return { handoffId: row.id, resumed };
    } finally {
      // A second release is a no-op, so this covers every exit above.
      hold.release();
    }
  }
```

Export the type beside `SupervisorDeps`:

```ts
export type SwitchPreview = {
  available: boolean;
  reason?: string;
  fresh: boolean;
  estimatedTokens: number;
  lastTurnCut: boolean;
};
```

`enqueuePrompt` for a system prompt creates an id of the form `q_<uuid>`; the last pending item is the one just pushed, because the queue is held and nothing else can enqueue between the two lines on this event loop tick.

- [ ] **Step 5: Wire the deps in `server.ts`**

Construct the store beside the supervisor:

```ts
const engineSessions = new EngineSessionStore(pool);
```

In the `new HarnessSupervisor({ ... })` object:

```ts
    engineSessions,
    engineAvailability: async (engine) => {
      const label =
        HARNESS_ENGINES.find((item) => item.id === engine)?.label ?? engine;
      const status = (await harnessAuthReport()).engines.find(
        (item) => item.engineId === engine
      );
      if (!status || status.kind === "unavailable") {
        return `${label} is not installed on the server.`;
      }
      if (status.kind === "not_signed_in") {
        return `${label} is not signed in on the server.`;
      }
      return null;
    },
    loadTurns: (agentId) => loadSessionTurns(pool, agentId),
    cancelLimitResume: (agentId) =>
      limitResumeScheduler?.cancel(agentId) ?? Promise.resolve(false),
    switchEnabled: () => isHarnessEngineSwitchEnabled(pool),
```

`harnessAuthReport` is the function already passed to the system routes as `authReport`; name it and hoist it above the supervisor if it is declared inline. `loadSessionTurns` is from Task 3b.

Imports:

```ts
import { EngineSessionStore } from "./agents/harness/engine-sessions.js";
import { loadSessionTurns } from "./chat/turns.js";
import { isHarnessEngineSwitchEnabled } from "./harness-switch-settings.js";
```

- [ ] **Step 6: Run the tests, then the whole supervisor suite**

Run: `pnpm --filter @dispatch/server test -- test/harness-switch.test.ts test/harness-supervisor.test.ts && pnpm --filter @dispatch/server check`
Expected: PASS, 10 new tests; no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/harness-switch-settings.ts \
  apps/server/src/agents/harness/supervisor.ts apps/server/src/server.ts \
  apps/server/test/harness-switch.test.ts
git commit -m "feat(harness): switch an agent to another provider in the same session"
```

---

### Task 6: Routes

**Files:**

- Modify: `packages/shared/src/harness-types.ts`, `packages/shared/src/index.ts`
- Modify: `apps/server/src/routes/agents/shared.ts`, `harness-routes.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/server/test/harness-routes.test.ts`

**Interfaces:**

- Produces:
  - `GET /api/v1/agents/:id/harness/switch/preview?model=<engine/model>` returns `HarnessSwitchPreview`.
  - `POST /api/v1/agents/:id/harness/switch` body `HarnessSwitchRequest` returns `{ handoffId: number; resumed: boolean }`; `409` with the reason when it refuses.
  - `GET /api/v1/agents/:id/harness/handoffs/:handoffId` returns `HarnessHandoff`.

```ts
export type HarnessSwitchPreview = {
  available: boolean;
  reason?: string;
  fresh: boolean;
  estimatedTokens: number;
  lastTurnCut: boolean;
};
export type HarnessSwitchRequest = { model: string; continueTask: boolean };
export type HarnessHandoff = {
  id: number;
  fromEngine: HarnessEngineId;
  toEngine: HarnessEngineId;
  outcome: "switched" | "failed";
  failure: string | null;
  briefing: string;
  createdAt: string;
};
```

- [ ] **Step 1: Add the shared types**

Add the three types above to `packages/shared/src/harness-types.ts` after `HarnessLimitResume`, and export them from `packages/shared/src/index.ts`.

- [ ] **Step 2: Write the failing tests**

Append to `apps/server/test/harness-routes.test.ts`:

```ts
describe("provider switch routes", () => {
  async function build(opts: { refuse?: string } = {}) {
    const calls: string[] = [];
    const app = Fastify();
    await registerAgentHarnessRoutes(app, {
      pool: ctx.pool,
      appLog: app.log,
      chat: {} as never,
      harness: {
        getConfigOptions: () => null,
        getSessionStartedAt: () => null,
        setConfigOption: async () => [],
        getCommands: () => null,
        listQueued: () => [],
        sendQueuedNow: async () => false,
        removeQueued: () => false,
        interrupt: async () => false,
        runningPromptId: () => null,
        holdQueue: () => ({ release: () => {} }),
        interruptAndWait: async () => false,
        limitResume: {
          schedule: async () => {},
          cancel: async () => false,
          get: async () => null,
        },
        previewSwitch: async (_id: string, model: string) => {
          calls.push(`preview:${model}`);
          return {
            available: true,
            fresh: true,
            estimatedTokens: 1400,
            lastTurnCut: false,
          };
        },
        switchEngine: async (
          _id: string,
          model: string,
          o: { continueTask: boolean }
        ) => {
          calls.push(`switch:${model}:${o.continueTask}`);
          if (opts.refuse) throw new Error(opts.refuse);
          return { handoffId: 5, resumed: false };
        },
        getHandoff: async (_id: string, handoffId: number) =>
          handoffId === 5
            ? {
                id: 5,
                agentId,
                fromEngine: "claude",
                toEngine: "codex",
                outcome: "switched" as const,
                failure: null,
                briefing: "BRIEFING",
                createdAt: new Date("2026-09-21T00:47:00.000Z"),
              }
            : null,
      },
    });
    return { app, calls };
  }

  it("previews a switch", async () => {
    const { app, calls } = await build();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/switch/preview?model=codex/default`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      available: true,
      estimatedTokens: 1400,
    });
    expect(calls).toEqual(["preview:codex/default"]);
    await app.close();
  });

  it("rejects a model id that names no engine", async () => {
    const { app, calls } = await build();
    for (const model of ["", "gpt-6-astra", "nope/model"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/agents/${agentId}/harness/switch/preview?model=${model}`,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
    await app.close();
  });

  it("switches, and answers 409 with the reason when the supervisor refuses", async () => {
    const ok = await build();
    const res = await ok.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/switch`,
      headers: { "content-type": "application/json" },
      payload: { model: "codex/default", continueTask: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ handoffId: 5, resumed: false });
    expect(ok.calls).toEqual(["switch:codex/default:true"]);
    await ok.app.close();

    const refused = await build({
      refuse: "Codex is not signed in on the server.",
    });
    const no = await refused.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/switch`,
      headers: { "content-type": "application/json" },
      payload: { model: "codex/default", continueTask: false },
    });
    expect(no.statusCode).toBe(409);
    expect(no.json().error).toBe("Codex is not signed in on the server.");
    await refused.app.close();
  });

  it("reads a handoff, and 404s for one that is not this agent's", async () => {
    const { app } = await build();
    const hit = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/handoffs/5`,
    });
    expect(hit.json()).toMatchObject({
      id: 5,
      briefing: "BRIEFING",
      createdAt: "2026-09-21T00:47:00.000Z",
    });
    const miss = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/handoffs/6`,
    });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });
});
```

Add `previewSwitch`, `switchEngine` and `getHandoff` stubs to the three earlier `registerAgentHarnessRoutes` calls in this file so they satisfy the widened type.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-routes.test.ts`
Expected: FAIL with 404 on the new paths.

- [ ] **Step 4: Widen the dep type and add the routes**

In `apps/server/src/routes/agents/shared.ts`, in the `harness` object:

```ts
previewSwitch: (agentId: string, model: string) =>
  Promise<import("@dispatch/shared").HarnessSwitchPreview>;
switchEngine: (
  agentId: string,
  model: string,
  opts: { continueTask: boolean }
) => Promise<{ handoffId: number; resumed: boolean }>;
getHandoff: (agentId: string, handoffId: number) =>
  Promise<import("../../agents/harness/engine-sessions.js").HandoffRow | null>;
```

In `harness-routes.ts`, import `splitModelId` from `../../agents/harness/agent-spec.js` and `HarnessHandoff`, `HarnessSwitchRequest` types from `@dispatch/shared`. After the `limit-resume` routes:

```ts
/** A model id that names a known engine, or null. */
const engineModel = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  try {
    splitModelId(value);
    return value;
  } catch {
    return null;
  }
};

app.get("/api/v1/agents/:id/harness/switch/preview", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  const model = engineModel((request.query as { model?: string }).model);
  if (!model) {
    return reply.code(400).send({ error: "model must be an engine/model id." });
  }
  return await deps.harness.previewSwitch(id, model);
});

/**
 * Move the agent to another provider. A refusal is a 409 carrying the
 * supervisor's own sentence, which is written for the user: the engine is
 * not signed in, the agent is already on that engine, the new engine would
 * not start and the old one is back.
 */
app.post("/api/v1/agents/:id/harness/switch", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  const body = (request.body ?? {}) as Partial<HarnessSwitchRequest>;
  const model = engineModel(body.model);
  if (!model) {
    return reply.code(400).send({ error: "model must be an engine/model id." });
  }
  try {
    return await deps.harness.switchEngine(id, model, {
      continueTask: body.continueTask === true,
    });
  } catch (error) {
    deps.appLog.warn({ err: error, agentId: id }, "provider switch refused");
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "Could not switch.",
    });
  }
});

app.get(
  "/api/v1/agents/:id/harness/handoffs/:handoffId",
  async (request, reply) => {
    const params = request.params as { id?: string; handoffId?: string };
    const id = params.id ?? "";
    const handoffId = Number(params.handoffId);
    if (!(await exists(id)) || !Number.isInteger(handoffId)) {
      return reply.code(404).send({ error: "Handoff not found." });
    }
    const row = await deps.harness.getHandoff(id, handoffId);
    if (!row) return reply.code(404).send({ error: "Handoff not found." });
    const response: HarnessHandoff = {
      id: row.id,
      fromEngine: row.fromEngine as HarnessHandoff["fromEngine"],
      toEngine: row.toEngine as HarnessHandoff["toEngine"],
      outcome: row.outcome,
      failure: row.failure,
      briefing: row.briefing,
      createdAt: row.createdAt.toISOString(),
    };
    return response;
  }
);
```

In `server.ts`, in the `harness:` object for `registerAgentRoutes`:

```ts
      previewSwitch: (agentId, model) =>
        harnessSupervisor.previewSwitch(agentId, model),
      switchEngine: (agentId, model, opts) =>
        harnessSupervisor.switchEngine(agentId, model, opts),
      getHandoff: (agentId, handoffId) =>
        engineSessions.getHandoff(agentId, handoffId),
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @dispatch/server test -- test/harness-routes.test.ts && pnpm --filter @dispatch/server check`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/harness-types.ts packages/shared/src/index.ts \
  apps/server/src/routes/agents/shared.ts \
  apps/server/src/routes/agents/harness-routes.ts apps/server/src/server.ts \
  apps/server/test/harness-routes.test.ts
git commit -m "feat(harness): preview and perform a provider switch over the API"
```

---

### Task 7: The marker in the feed

**Files:**

- Modify: `packages/shared/src/chat-types.ts` (`ChatFeedEntry`)
- Modify: `apps/server/src/chat/feed-cursor.ts` (`SOURCE_RANK`, `isValidCursorId`)
- Modify: `apps/server/src/chat/feed.ts` (`composeChatFeed`)
- Modify: `docs/superpowers/specs/2026-09-21-provider-switch-and-limit-card-design.md`
- Test: `apps/server/test/chat-feed.test.ts` (the file that covers `composeChatFeed`; find it with `grep -rln composeChatFeed apps/server/test`)

**Interfaces:**

- Produces:

```ts
export type ChatSwitchEntry = {
  type: "switch";
  id: string; // `switch:<handoff id>`
  handoffId: number;
  fromEngine: HarnessEngineId;
  toEngine: HarnessEngineId;
  outcome: "switched" | "failed";
  failure: string | null;
  at: string;
};
```

- [ ] **Step 1: Write the failing test**

In the `composeChatFeed` test file, using its existing agent fixture and store factory:

```ts
it("lists a provider switch as an entry, in time order with everything else", async () => {
  await pool.query(
    `INSERT INTO agent_engine_handoffs
         (agent_id, from_engine, to_engine, outcome, failure, briefing)
       VALUES ($1, 'claude', 'codex', 'switched', NULL, 'BRIEFING')`,
    [A]
  );
  const feed = await composeChatFeed(store, A);
  const entry = feed.entries.find((e) => e.type === "switch");
  expect(entry).toMatchObject({
    type: "switch",
    fromEngine: "claude",
    toEngine: "codex",
    outcome: "switched",
    failure: null,
  });
  // The briefing is fetched on demand, never carried on the feed.
  expect(JSON.stringify(entry)).not.toContain("BRIEFING");
});
```

Use that file's names for the pool, the store, and the agent id if they differ.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dispatch/server test -- <that file>`
Expected: FAIL, no `switch` entry in the feed.

- [ ] **Step 3: Add the wire type**

In `packages/shared/src/chat-types.ts`, add the `ChatSwitchEntry` type above `ChatFeedEntry`, import `HarnessEngineId` from `./harness-types.js`, and add `| ChatSwitchEntry` to the `ChatFeedEntry` union. Export it from `packages/shared/src/index.ts`.

- [ ] **Step 4: Teach the cursor about it**

In `apps/server/src/chat/feed-cursor.ts`, add to `SOURCE_RANK`. The rank only has to be unique:

```ts
  // A provider switch. Above a turn, so a switch and the turn that follows it
  // in the same microsecond still page in a stable order.
  switch: 7,
```

and in `isValidCursorId`, add `case "switch":` to the group that validates a serial id.

- [ ] **Step 5: Add the source**

In `apps/server/src/chat/feed.ts`, beside `listPinEntries`:

```ts
/**
 * Provider switches, one entry each. The handoff row is the marker: it is
 * written once per switch already, so the feed needs no second write and
 * cannot disagree with the stored briefing. The briefing itself stays off
 * the feed; it can run to tens of kilobytes and is read on demand.
 */
async function listSwitchEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatSwitchEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("switch", "int", cursor, params);
  params.push(limit);
  const result = await db.query<{
    id: number;
    from_engine: ChatSwitchEntry["fromEngine"];
    to_engine: ChatSwitchEntry["toEngine"];
    outcome: ChatSwitchEntry["outcome"];
    failure: string | null;
    created_at: Date;
    at_key: string;
  }>(
    `SELECT id, from_engine, to_engine, outcome, failure, created_at,
            ${AT_KEY_SQL} AS at_key
       FROM agent_engine_handoffs
      WHERE agent_id = $1 ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    entry: {
      type: "switch",
      id: `switch:${row.id}`,
      handoffId: row.id,
      fromEngine: row.from_engine,
      toEngine: row.to_engine,
      outcome: row.outcome,
      failure: row.failure,
      at: row.created_at.toISOString(),
    },
    atKey: row.at_key,
    rawId: String(row.id),
    idKey: intKey(row.id),
  }));
}
```

In `composeChatFeed`, add `switches` to the destructured `Promise.all` result and `listSwitchEntries(db, agentId, cursor, limit + 1),` to the array in the matching position, then `...switches,` to the `merged` spread. Import `ChatSwitchEntry` from `@dispatch/shared`.

After a switch, `publishHarness(agentId, true)` already fires. Check what that event invalidates on the web (`apps/web/src/hooks/use-sse.ts`): if `harness.changed` with `config` does not also invalidate the chat feed, have `switchEngine`'s caller in `server.ts` publish `chat.changed` too, by wrapping the route wiring:

```ts
      switchEngine: async (agentId, model, opts) => {
        try {
          return await harnessSupervisor.switchEngine(agentId, model, opts);
        } finally {
          // A marker row was written either way, switched or failed.
          chatService.publishChanged(agentId);
        }
      },
```

- [ ] **Step 6: Run the tests and typecheck everything**

Run: `pnpm --filter @dispatch/server test -- <that file> && pnpm run check`
Expected: the server passes. **The web typecheck fails**, by design: every exhaustive `switch (entry.type)` in `apps/web` now misses a case. Task 8 Step 5 handles each one. Do not commit the web in a broken state: commit this task together with Task 8 if `pnpm run check` runs in the pre-commit hook.

- [ ] **Step 7: Confirm the spec still agrees**

The spec was corrected when this plan was written: its section 5 describes the marker as a `switch` feed entry, and its `agent_engine_handoffs` table matches Task 1. Read both and fix either if the implementation has moved since.

---

### Task 8: The picker, the dialog, the marker

**Files:**

- Create: `apps/web/src/components/app/harness/use-engine-switch.ts`
- Create: `apps/web/src/components/app/harness/switch-dialog.tsx`
- Create: `apps/web/src/components/app/chat/switch-entry-view.tsx`
- Modify: `apps/web/src/components/app/harness/model-picker.tsx`
- Modify: `apps/web/src/components/app/chat/harness-chrome.tsx`
- Modify: `apps/web/src/components/app/chat/chat-feed.tsx`
- Modify: `apps/web/src/components/app/chat/turn/limit-card.tsx`
- Test: `apps/web/src/components/app/harness/switch-dialog.test.tsx`, `apps/web/src/components/app/chat/switch-entry-view.test.tsx`

**Interfaces:**

- Consumes: the three routes (Task 6), `ChatSwitchEntry` (Task 7), `useAgentModelCatalog("dispatch")` and `useHarnessAuth`.
- Produces: `<SwitchDialog agentId targetModel onClose />`, `<SwitchEntryView entry />`, `useSwitchPreview`, `useEngineSwitch`, `useHandoff`.

- [ ] **Step 1: Write the hooks**

Create `apps/web/src/components/app/harness/use-engine-switch.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  HarnessHandoff,
  HarnessSwitchPreview,
  HarnessSwitchRequest,
} from "@dispatch/shared";

import { api } from "@/lib/api";

import { harnessConfigQueryKey } from "./use-harness-config";
import { harnessQueueQueryKey } from "./use-harness-queue";

/** What a switch to `model` would do, read before the user commits. */
export function useSwitchPreview(agentId: string | null, model: string | null) {
  return useQuery({
    queryKey: ["harness-switch-preview", agentId, model],
    queryFn: () =>
      api<HarnessSwitchPreview>(
        `/api/v1/agents/${agentId}/harness/switch/preview?model=${encodeURIComponent(model ?? "")}`
      ),
    enabled: agentId !== null && model !== null,
    // The estimate moves with every turn; never serve an old one.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useEngineSwitch(agentId: string | null) {
  const queryClient = useQueryClient();
  return useMutation<
    { handoffId: number; resumed: boolean },
    Error,
    HarnessSwitchRequest
  >({
    mutationFn: (input) =>
      api(`/api/v1/agents/${agentId}/harness/switch`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["chat", agentId] });
      void queryClient.invalidateQueries({
        queryKey: harnessConfigQueryKey(agentId),
      });
      void queryClient.invalidateQueries({
        queryKey: harnessQueueQueryKey(agentId),
      });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/** The exact briefing a switch sent. Fetched only when the user asks to see it. */
export function useHandoff(agentId: string | null, handoffId: number | null) {
  return useQuery({
    queryKey: ["harness-handoff", agentId, handoffId],
    queryFn: () =>
      api<HarnessHandoff>(
        `/api/v1/agents/${agentId}/harness/handoffs/${handoffId}`
      ),
    enabled: agentId !== null && handoffId !== null,
    // A handoff never changes once written.
    staleTime: Infinity,
  });
}
```

Confirm `harnessConfigQueryKey` is exported from `use-harness-config.ts` (the SSE hook imports it) and that the agents list query key is `["agents"]`; use the real key if it differs.

- [ ] **Step 2: Write the failing dialog tests**

Create `apps/web/src/components/app/harness/switch-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const S = vi.hoisted(() => ({
  preview: {
    available: true,
    fresh: true,
    estimatedTokens: 14_200,
    lastTurnCut: true,
  } as Record<string, unknown>,
  mutate: vi.fn(async () => ({ handoffId: 1, resumed: false })),
}));
vi.mock("./use-engine-switch", () => ({
  useSwitchPreview: () => ({ data: S.preview, isLoading: false }),
  useEngineSwitch: () => ({ mutateAsync: S.mutate, isPending: false }),
}));

import { SwitchDialog } from "./switch-dialog";

beforeEach(() => {
  S.mutate.mockClear();
  S.preview = {
    available: true,
    fresh: true,
    estimatedTokens: 14_200,
    lastTurnCut: true,
  };
});
afterEach(cleanup);

const dialog = (onClose = vi.fn()) =>
  render(
    <SwitchDialog
      agentId="agt_1"
      fromEngineLabel="Claude Code"
      target={{
        id: "codex/gpt-6-astra",
        label: "GPT-6 Astra",
        engineLabel: "Codex",
      }}
      onClose={onClose}
    />
  );

describe("SwitchDialog", () => {
  it("says what will happen, and what a first visit costs", () => {
    dialog();
    const el = screen.getByTestId("switch-dialog");
    expect(el.textContent).toContain("Switch to Codex · GPT-6 Astra?");
    expect(el.textContent).toContain("Claude Code will stop.");
    expect(el.textContent).toContain("starts fresh");
    expect(el.textContent).toContain("About 14k tokens of briefing");
  });

  it("ticks the continue box when the last turn was cut, and sends it", async () => {
    const onClose = vi.fn();
    dialog(onClose);
    const box = screen.getByTestId("switch-continue") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByTestId("switch-confirm"));
    await waitFor(() =>
      expect(S.mutate).toHaveBeenCalledWith({
        model: "codex/gpt-6-astra",
        continueTask: true,
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("leaves the box clear after a clean finish: there is nothing to resume", () => {
    S.preview = { ...S.preview, lastTurnCut: false };
    dialog();
    expect(
      (screen.getByTestId("switch-continue") as HTMLInputElement).checked
    ).toBe(false);
  });

  it("says a return trip is cheap", () => {
    S.preview = { ...S.preview, fresh: false, estimatedTokens: 900 };
    dialog();
    expect(screen.getByTestId("switch-dialog").textContent).toContain(
      "resumes its earlier session"
    );
  });

  it("explains and disables when the provider cannot run", () => {
    S.preview = {
      available: false,
      reason: "Codex is not signed in on the server.",
      fresh: true,
      estimatedTokens: 0,
      lastTurnCut: false,
    };
    dialog();
    expect(screen.getByTestId("switch-dialog").textContent).toContain(
      "Codex is not signed in on the server."
    );
    expect(
      (screen.getByTestId("switch-confirm") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("shows the server's reason when the switch is refused, and stays open", async () => {
    S.mutate.mockRejectedValueOnce(
      new Error("The agent did not stop in time.")
    );
    const onClose = vi.fn();
    dialog(onClose);
    fireEvent.click(screen.getByTestId("switch-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("switch-error").textContent).toContain(
        "The agent did not stop in time."
      )
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/switch-dialog.test.tsx`
Expected: FAIL, cannot resolve `./switch-dialog`.

- [ ] **Step 4: Write the dialog**

Create `apps/web/src/components/app/harness/switch-dialog.tsx`:

```tsx
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { useEngineSwitch, useSwitchPreview } from "./use-engine-switch";

export type SwitchTarget = { id: string; label: string; engineLabel: string };

/** "14k", "900". */
function tokensLabel(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

/**
 * The confirm step for moving an agent to another provider. A model change
 * inside one provider needs no confirm; this is a bigger act, so it says what
 * will stop, what starts, and what it costs, before anything happens.
 */
export function SwitchDialog({
  agentId,
  fromEngineLabel,
  target,
  onClose,
}: {
  agentId: string;
  fromEngineLabel: string;
  target: SwitchTarget;
  onClose: () => void;
}): JSX.Element {
  const preview = useSwitchPreview(agentId, target.id);
  const switchEngine = useEngineSwitch(agentId);
  const [continueTask, setContinueTask] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cut = preview.data?.lastTurnCut;
  // Ticked when the last turn was cut short, clear after a clean finish.
  // Set once the preview arrives; the user's own change is kept after that.
  useEffect(() => {
    if (cut !== undefined) setContinueTask(cut);
  }, [cut]);

  const data = preview.data;
  const blocked = data ? !data.available : true;
  const onConfirm = () => {
    setError(null);
    switchEngine
      .mutateAsync({ model: target.id, continueTask })
      .then(onClose)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not switch.")
      );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-testid="switch-dialog">
        <DialogHeader>
          <DialogTitle>
            Switch to {target.engineLabel} · {target.label}?
          </DialogTitle>
          <DialogDescription>
            {fromEngineLabel} will stop. {target.engineLabel} starts in the same
            worktree and is briefed on this session.
          </DialogDescription>
        </DialogHeader>
        {data && !data.available ? (
          <p className="text-[12px] text-status-blocked">{data.reason}</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={continueTask}
                onChange={(event) => setContinueTask(event.target.checked)}
                data-testid="switch-continue"
              />
              Continue the interrupted task
            </label>
            {data ? (
              <p className="text-[11px] text-muted-foreground">
                {data.fresh
                  ? `First switch to ${target.engineLabel} in this session, so it starts fresh. About ${tokensLabel(data.estimatedTokens)} tokens of briefing.`
                  : `${target.engineLabel} resumes its earlier session with a short catch-up, about ${tokensLabel(data.estimatedTokens)} tokens.`}
              </p>
            ) : null}
          </>
        )}
        {error ? (
          <p
            className="text-[12px] text-status-blocked"
            data-testid="switch-error"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={blocked || switchEngine.isPending}
            data-testid="switch-confirm"
          >
            {switchEngine.isPending ? "Switching…" : "Switch"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

Run the dialog tests again. Expected: PASS, 6 tests.

- [ ] **Step 5: List the other providers in the picker**

In `apps/web/src/components/app/harness/model-picker.tsx`, add two props:

```tsx
  /**
   * Models on providers other than the running one, from the static catalog.
   * Picking one does not apply a config option: it asks to switch provider.
   */
  otherProviders?: { id: string; label: string; engineLabel: string; unavailableReason?: string }[];
  onPickOtherProvider?: (target: { id: string; label: string; engineLabel: string }) => void;
```

Below the effort select and above the dialog's buttons, render them as a list, not inside the model `Select`, because that select's values are the running engine's config choices and applying one calls `onApply`:

```tsx
{
  otherProviders && otherProviders.length > 0 ? (
    <div
      className="mt-3 border-t border-border pt-3"
      data-testid="picker-other-providers"
    >
      <div className="mb-1 text-[11px] text-muted-foreground">
        Switch provider
      </div>
      <div className="flex flex-col gap-1">
        {otherProviders.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={Boolean(option.unavailableReason)}
            title={option.unavailableReason}
            onClick={() => onPickOtherProvider?.(option)}
            data-testid={`picker-switch-${option.id}`}
            className="flex items-center justify-between rounded px-2 py-1 text-left text-[12px] hover:bg-muted/60 disabled:opacity-50"
          >
            <span>
              {option.engineLabel} · {option.label}
            </span>
            {option.unavailableReason ? (
              <span className="text-[10.5px] text-muted-foreground">
                {option.unavailableReason}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  ) : null;
}
```

In `apps/web/src/components/app/chat/harness-chrome.tsx`, build the list and hold the dialog's target:

```tsx
const catalog = useAgentModelCatalog("dispatch");
const [switchTarget, setSwitchTarget] = useState<SwitchTarget | null>(null);
const otherProviders = useMemo(() => {
  if (!engine) return [];
  return catalog.options
    .filter((option) => !option.id.startsWith(`${engine.id}/`))
    .map((option) => {
      const engineId = option.id.slice(0, option.id.indexOf("/"));
      const status = auth.data?.engines.find((e) => e.engineId === engineId);
      const engineLabel =
        HARNESS_ENGINES.find((e) => e.id === engineId)?.label ?? engineId;
      const unavailableReason =
        !status || status.kind === "unavailable"
          ? "not installed"
          : status.kind === "not_signed_in"
            ? "not signed in"
            : undefined;
      return {
        id: option.id,
        label: option.label,
        engineLabel,
        unavailableReason,
      };
    });
}, [auth.data, catalog.options, engine]);
```

Pass `otherProviders` and `onPickOtherProvider={(target) => { setPickerOpen(false); setSwitchTarget(target); }}` to `<ModelPicker>`, and render the dialog beside it:

```tsx
{
  switchTarget && agentId && engine ? (
    <SwitchDialog
      agentId={agentId}
      fromEngineLabel={engine.label}
      target={switchTarget}
      onClose={() => setSwitchTarget(null)}
    />
  ) : null;
}
```

Add `/switch` to `slashItems` beside `/model`, opening the same picker: copy the `/model` entry and its branch in `onSlashCommand`, with the name `switch` and the description "Switch this session to another provider".

Imports: `HARNESS_ENGINES` from `@dispatch/shared`, `useAgentModelCatalog` from `@/hooks/use-agent-model-catalog`, `SwitchDialog` and `SwitchTarget` from `@/components/app/harness/switch-dialog`. `engine` and `auth` are already in scope in this hook.

**Progress while switching needs no code.** `switchEngine` brings the new engine up through `start()`, which already publishes `agent_start` stages (`prepare`, `connect`, `configure`). `agentStartupStage` in `agent-startup.tsx` reads those, so the startup card shows and the composer disables for the length of the switch, exactly as at first launch. Task 9's end-to-end test asserts the composer comes back enabled afterwards, which is the observable half of this.

- [ ] **Step 6: Write the marker view, test first**

Create `apps/web/src/components/app/chat/switch-entry-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/app/harness/use-engine-switch", () => ({
  useHandoff: (_a: string, id: number | null) => ({
    data: id === null ? undefined : { briefing: "THE EXACT BRIEFING TEXT" },
    isLoading: false,
  }),
}));

import { SwitchEntryView } from "./switch-entry-view";

afterEach(cleanup);

const entry = (over = {}) => ({
  type: "switch" as const,
  id: "switch:5",
  handoffId: 5,
  fromEngine: "claude" as const,
  toEngine: "codex" as const,
  outcome: "switched" as const,
  failure: null,
  at: "2026-09-21T00:47:00.000Z",
  ...over,
});

describe("SwitchEntryView", () => {
  it("marks where the provider changed", () => {
    render(<SwitchEntryView entry={entry()} agentId="agt_1" />);
    expect(screen.getByTestId("chat-switch").textContent).toContain(
      "Switched from Claude Code to Codex"
    );
  });

  it("shows the exact briefing on demand, and not before", () => {
    render(<SwitchEntryView entry={entry()} agentId="agt_1" />);
    expect(screen.queryByText("THE EXACT BRIEFING TEXT")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-switch-view-handoff"));
    expect(screen.getByTestId("chat-switch-briefing").textContent).toContain(
      "THE EXACT BRIEFING TEXT"
    );
  });

  it("says a switch failed, why, and offers no briefing", () => {
    render(
      <SwitchEntryView
        entry={entry({ outcome: "failed", failure: "codex-acp was not found" })}
        agentId="agt_1"
      />
    );
    const el = screen.getByTestId("chat-switch");
    expect(el.textContent).toContain("Could not switch to Codex");
    expect(el.textContent).toContain("codex-acp was not found");
    expect(el.textContent).toContain("Still on Claude Code");
    expect(screen.queryByTestId("chat-switch-view-handoff")).toBeNull();
  });
});
```

Create `apps/web/src/components/app/chat/switch-entry-view.tsx`:

```tsx
import { memo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { HARNESS_ENGINES, type ChatSwitchEntry } from "@dispatch/shared";

import { useHandoff } from "@/components/app/harness/use-engine-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const label = (engine: string) =>
  HARNESS_ENGINES.find((e) => e.id === engine)?.label ?? engine;

/**
 * Where the provider changed. Turns above it ran on one engine and turns
 * below on another. "View handoff" shows the exact text the newcomer was
 * given: when it behaves oddly after a switch, this is how to tell whether
 * the briefing was the cause.
 */
function SwitchEntryViewImpl({
  entry,
  agentId,
}: {
  entry: ChatSwitchEntry;
  agentId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const handoff = useHandoff(agentId, open ? entry.handoffId : null);
  const failed = entry.outcome === "failed";
  const time = new Date(entry.at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div
      className="my-2 flex items-center gap-2 px-4 text-[11px] text-muted-foreground"
      data-testid="chat-switch"
      data-outcome={entry.outcome}
    >
      <div className="h-px flex-1 bg-border" />
      <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      {failed ? (
        <span className="text-status-blocked">
          Could not switch to {label(entry.toEngine)}: {entry.failure}. Still on{" "}
          {label(entry.fromEngine)}.
        </span>
      ) : (
        <span>
          Switched from {label(entry.fromEngine)} to {label(entry.toEngine)} ·{" "}
          {time}
        </span>
      )}
      {failed ? null : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="underline-offset-2 hover:text-foreground hover:underline"
          data-testid="chat-switch-view-handoff"
        >
          View handoff
        </button>
      )}
      <div className="h-px flex-1 bg-border" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Handoff to {label(entry.toEngine)}</DialogTitle>
            <DialogDescription>
              The exact text {label(entry.toEngine)} was given. Diffs and
              command output are left out on purpose.
            </DialogDescription>
          </DialogHeader>
          <pre
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-[11.5px]"
            data-testid="chat-switch-briefing"
          >
            {handoff.isLoading ? "Loading…" : (handoff.data?.briefing ?? "")}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const SwitchEntryView = memo(SwitchEntryViewImpl);
```

- [ ] **Step 7: Render it, and satisfy every exhaustive switch**

In `apps/web/src/components/app/chat/chat-feed.tsx`, add beside `case "pin":`:

```tsx
        case "switch":
          return <SwitchEntryView entry={entry} agentId={ctx.agentId} />;
```

Then run `cd apps/web && npx tsc --noEmit`. Every error it reports is an exhaustive `switch` or a lookup table over `ChatFeedEntry["type"]` that now lacks `"switch"`. For each, give `switch` the same treatment as `pin`: it is a static row, it never groups with a neighbor, it does not count as unread, and it has no growth key. Repeat until `tsc` is clean. Do not add a `default:` to silence one: the exhaustiveness is what caught it.

- [ ] **Step 8: Turn on the limit card's button**

This step needs plan 1. In `apps/web/src/components/app/chat/turn/limit-card.tsx`, add an optional prop `onSwitchProvider?: () => void` and, between the Continue button and "Stop here":

```tsx
{
  onSwitchProvider ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onSwitchProvider}
      data-testid="limit-card-switch"
    >
      Switch provider
    </Button>
  ) : null;
}
```

Thread it from `harness-chrome.tsx` through `useTurnContext` (see `turn-context.tsx`), as `openProviderPicker: () => setPickerOpen(true)`, and pass `onSwitchProvider={openProviderPicker}` where `turn-entry-view.tsx` renders `<LimitCard>`. The card opens the picker, not the dialog: the user still has to choose which provider.

Add to `limit-card.test.tsx`:

```tsx
it("offers Switch provider when the host supplies it", () => {
  const onSwitchProvider = vi.fn();
  card({ onSwitchProvider });
  fireEvent.click(screen.getByTestId("limit-card-switch"));
  expect(onSwitchProvider).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 9: Run the web suite and typecheck**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run && npx tsc --noEmit && cd ../.. && pnpm run check`
Expected: PASS; no type errors anywhere.

- [ ] **Step 10: Commit Tasks 7 and 8 together**

```bash
git add packages/shared apps/server/src/chat apps/server/test \
  apps/web/src/components/app docs/superpowers/specs
git commit -m "feat(chat): switch provider from the model picker, with a marker and its handoff"
```

---

### Task 9: End to end, the setting route, and docs

**Files:**

- Modify: `e2e/harness-agent.spec.ts`
- Modify: `apps/server/src/routes/system.ts`
- Modify: `docs/10-operations-runbook.md`, `release-notes/current.md`

- [ ] **Step 1: Write the end-to-end test**

The fake engine infers which provider it is from its arguments, so a switch between two real adapters' argument shapes exercises two dialects. In `e2e/harness-agent.spec.ts`, after the provider-limit test:

```ts
test("switches provider mid-session and carries on in the same feed", async ({
  page,
  request,
}) => {
  await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
  await setDispatchHarnessViaAPI(request, true);
  await setChatSurface(request, true);
  const repo = makeRepo();
  const agent = await createAgentViaAPI(request, {
    name: `e2e-harness-switch-${Date.now()}`,
    type: "dispatch",
    model: "claude/default",
    cwd: repo,
    useWorktree: true,
  });
  expect(agent.status).toBe("running");

  await loadApp(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await clickAgentRow(page, agent.id);
  await page.getByTestId("center-tab-agent").click();
  const pane = page.getByTestId("chat-pane");
  const input = pane.getByTestId("chat-composer-input");
  await expect(input).toBeEnabled({ timeout: 30_000 });

  await input.fill("say:the parser is in src/parse.ts");
  await input.press("Enter");
  await expect(pane.getByTestId("chat-scroll")).toContainText(
    "the parser is in src/parse.ts",
    { timeout: 30_000 }
  );

  // The picker lists the other provider; picking it asks first.
  await pane.getByTestId("harness-model-chip").click();
  await page.getByTestId("picker-switch-codex/default").click();
  const dialog = page.getByTestId("switch-dialog");
  await expect(dialog).toContainText("Claude Code will stop.");
  await expect(dialog).toContainText("starts fresh");
  await page.screenshot({
    path: test.info().outputPath("harness-switch-dialog.png"),
    fullPage: true,
  });
  await page.getByTestId("switch-confirm").click();

  // Same feed, one marker, and the earlier turn is still above it.
  const marker = pane.getByTestId("chat-switch");
  await expect(marker).toContainText("Switched from Claude Code to Codex", {
    timeout: 60_000,
  });
  await expect(pane.getByTestId("chat-scroll")).toContainText(
    "the parser is in src/parse.ts"
  );
  await expect(pane.getByTestId("harness-model-chip-label")).toContainText(
    "Codex",
    { timeout: 30_000 }
  );

  // The handoff is readable, and carries what was said before the switch.
  await marker.getByTestId("chat-switch-view-handoff").click();
  const briefing = page.getByTestId("chat-switch-briefing");
  await expect(briefing).toContainText("trust the files");
  await expect(briefing).toContainText("the parser is in src/parse.ts");
  await page.screenshot({
    path: test.info().outputPath("harness-switch-handoff.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");

  // The next turn runs, on the new provider, in the same feed.
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill("say:carrying on");
  await input.press("Enter");
  await expect(pane.getByTestId("chat-scroll")).toContainText("carrying on", {
    timeout: 30_000,
  });
  const after = await request.get(`/api/v1/agents/${agent.id}`);
  expect((await after.json()).agent.model).toBe("codex/default");
});
```

If `createAgentViaAPI` does not accept `model`, or the agent route's response is not `{ agent }`, match the helpers' real shapes (`e2e/helpers.ts`).

- [ ] **Step 2: Run it live**

Run: `E2E_AGENT_RUNTIME=tmux bash scripts/e2e-isolated.sh --no-deps e2e/harness-agent.spec.ts -g "switches provider"`
Expected: 1 passed. Share both screenshots with `dispatch_share_file`.

- [ ] **Step 3: Expose the setting**

In `apps/server/src/routes/system.ts`, after the `harness-limit-card` pair from plan 1, add the matching `GET` and `POST /api/v1/app/settings/harness-engine-switch` pair over `isHarnessEngineSwitchEnabled` and `setHarnessEngineSwitchEnabled`, identical in shape to its neighbors, with a sibling test asserting the same three things: default `true`, a `POST` of `false` reads back `false`, a non-boolean body is `400`.

- [ ] **Step 4: One real switch, by hand**

No automated test says whether the briefing is good. On a host with both Claude Code and Codex signed in:

1. Start a Claude agent on a real repo and give it a multi-step task. Let it make real edits.
2. Stop it mid-task. Switch to Codex with "Continue the interrupted task" ticked.
3. Open "View handoff". Read it as if you were Codex. Is anything you would need missing? Is anything in it wrong?
4. Watch what Codex does first. It should read the files it was told were changing. It should not redo a step the handoff says finished, and it should not treat a step marked "did not finish" as done.
5. Switch back to Claude. The marker should say it resumed, and the handoff should be the short catch-up, not the full briefing.

Record what you saw in the PR description under Verification, including anything the briefing got wrong. Fix what it got wrong in `handoff.ts` with a test that pins the fix.

- [ ] **Step 5: Document it**

In `docs/10-operations-runbook.md`, after the provider-limit paragraphs from plan 1:

```markdown
A Dispatch agent can be moved to another provider mid-session from the model
picker: the other providers are listed under "Switch provider", and `/switch`
opens the same picker. The agent keeps its id, feed, worktree, pins, reviews,
child agents and queue. Only the engine process is replaced.

The new provider starts with no memory of the session. Dispatch sends it a
briefing built from its own record of the turns, plus the branch, a summary of
uncommitted changes, the task list and the pins, read at the moment of the
switch. Diffs and command output are left out: they are large, they are already
on disk, and a secret that scrolled past in a terminal must not be re-sent to a
second provider. The exact text is kept in `agent_engine_handoffs` and shown by
"View handoff" on the marker in the feed.

One session per engine is remembered in `agent_engine_sessions`. The first
switch to a provider starts it cold. A return resumes its own session and sends
only what happened since it left.

A switch that cannot complete leaves the agent where it was. An engine that is
not installed or not signed in is refused before anything stops. An engine that
will not start is recorded as a failed switch in the feed, and the previous
engine is restarted from its saved session. `agents.model` is written last, so a
server restart mid-switch finds the old engine or the new one.

Dispatch-managed background processes survive a switch. A process a provider
started through its own shell tool does not: it dies with that engine.

`harness_engine_switch_enabled` (default on) turns the feature off.
```

In `release-notes/current.md`, after the "Provider limits" bullet:

```markdown
- **Switch provider mid-session**: move a Dispatch agent from one provider to another from the model picker, or with `/switch`, and keep going in the same session. The new provider is briefed from Dispatch's own record of the session; "View handoff" on the marker in the feed shows the exact text it was given. Returning to a provider resumes its earlier session. The limit card's "Switch provider" opens the same picker. Turn it off with `harness_engine_switch_enabled`.
```

- [ ] **Step 6: Run everything**

```bash
pnpm run check
pnpm --filter @dispatch/server test
cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run && cd ../..
pnpm run finalize:web
```

Expected: all pass, apart from the four pre-existing `harness-usage-engine-*` e2e assertions on a host with a real subscription login.

- [ ] **Step 7: Commit**

```bash
git add e2e/harness-agent.spec.ts apps/server/src/routes/system.ts \
  docs/10-operations-runbook.md release-notes/current.md
git add -u apps/server/test
git commit -m "test(e2e): cover a provider switch and its handoff"
```
