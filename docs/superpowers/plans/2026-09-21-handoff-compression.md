# Handoff Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session is too long to replay in full, have the incoming provider summarize the older turns once, so a provider switch keeps the early decisions instead of dropping them.

**Architecture:** `buildHandoff` already keeps the newest turns that fit a token budget and reports how many older ones it left out. This plan compresses exactly those: a throwaway one-shot session on the incoming engine, with no tools and an empty working directory, turns them into a brief. The brief is saved against the last turn it covers, so a later switch extends it rather than paying to summarize the same history twice. Any failure falls back to the truncated replay plan 2 already ships.

**Tech Stack:** TypeScript, Bun, PostgreSQL, Vitest, the Agent Client Protocol driver in `apps/server/src/agents/harness/driver.ts`.

**Spec:** `docs/superpowers/specs/2026-09-21-provider-switch-and-limit-card-design.md`, section 4, "Compression runs as a separate, throwaway one-shot call". This is build step 3 of 3 and requires plan 2 (`2026-09-21-provider-switch.md`) to have landed.

## Global Constraints

- Setting `harness_handoff_compression_enabled`, default on. Off means replay only, exactly as plan 2 behaves.
- **If the summarizer fails, the switch still happens.** Timeout, a refusal, an empty reply, a provider limit: each falls back to the truncated replay, and the briefing says earlier turns were omitted. A missing summary is never the reason someone is stuck on a provider with no tokens.
- The summarizer runs in its **own** session, never inside the agent's. The agent's session receives the finished brief, not the raw history.
- The summarizer gets **no Dispatch MCP tools**. With them it could post to the user's chat, or pin, as the agent.
- The summarizer runs in an empty temporary directory, removed afterwards. It has nothing to read and nothing to edit.
- A session that fits the budget calls no model. Compression only ever runs when `buildHandoff` reports `omittedTurns > 0`.
- A returning engine (a resume with a catch-up) is never compressed for: its own session already holds the history.
- One summarizing call per switch at most, bounded to 90 seconds.
- The brief is stored and shown. "View handoff" displays it as part of the exact text sent.
- No em-dashes in prose, comments, or commit messages. American spelling. Conventional commits.
- Run server tests with `pnpm --filter @dispatch/server test -- <file>`.

## File Structure

| File                                                                 | Responsibility                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/server/src/db/migrations/0061_agent-engine-handoff-briefs.sql` | Two columns on `agent_engine_handoffs`                                                 |
| `apps/server/src/agents/harness/engine-sessions.ts`                  | Save and read the newest brief                                                         |
| `apps/server/src/agents/harness/driver.ts`                           | `DriverLaunch.mcp` becomes optional                                                    |
| `apps/server/src/agents/harness/one-shot.ts`                         | Run one prompt on an engine in a private, tool-less session and return its text        |
| `apps/server/src/agents/harness/handoff.ts`                          | Accept an older brief; report which turns were left out; build the summarizer's prompt |
| `apps/server/src/harness-switch-settings.ts`                         | The compression setting                                                                |
| `apps/server/src/agents/harness/supervisor.ts`                       | Compress when turns were left out, reuse a saved brief, fall back on failure           |

---

### Task 1: Save a brief with the handoff it belongs to

**Files:**

- Create: `apps/server/src/db/migrations/0061_agent-engine-handoff-briefs.sql`
- Modify: `apps/server/src/agents/harness/engine-sessions.ts`
- Test: `apps/server/test/harness-engine-sessions.test.ts`

**Interfaces:**

- Produces: `HandoffRow` gains `briefUptoSeq: number | null` and `olderBrief: string | null`. `recordHandoff` accepts both, optional. `latestBrief(agentId): Promise<{ uptoSeq: number; text: string } | null>`.

- [ ] **Step 1: Write the migration**

Create `apps/server/src/db/migrations/0061_agent-engine-handoff-briefs.sql`:

```sql
-- A compression of a session's older turns, written by the incoming provider
-- at switch time. Saved with the seq of the last turn it covers, so a later
-- switch summarizes only what came after and extends this, instead of paying
-- to summarize the same history again.
ALTER TABLE agent_engine_handoffs
  ADD COLUMN IF NOT EXISTS brief_upto_seq integer,
  ADD COLUMN IF NOT EXISTS older_brief text;
```

- [ ] **Step 2: Write the failing test**

Add to `apps/server/test/harness-engine-sessions.test.ts`:

```ts
it("returns the newest saved brief, and none when no switch wrote one", async () => {
  expect(await store.latestBrief(A)).toBeNull();
  await store.recordHandoff({
    agentId: A,
    fromEngine: "claude",
    toEngine: "codex",
    outcome: "switched",
    failure: null,
    briefing: "b1",
    briefUptoSeq: 40,
    olderBrief: "first brief",
  });
  // A later switch that needed no compression must not hide the brief.
  await store.recordHandoff({
    agentId: A,
    fromEngine: "codex",
    toEngine: "claude",
    outcome: "switched",
    failure: null,
    briefing: "b2",
  });
  expect(await store.latestBrief(A)).toEqual({
    uptoSeq: 40,
    text: "first brief",
  });
  await store.recordHandoff({
    agentId: A,
    fromEngine: "claude",
    toEngine: "codex",
    outcome: "switched",
    failure: null,
    briefing: "b3",
    briefUptoSeq: 90,
    olderBrief: "extended brief",
  });
  expect(await store.latestBrief(A)).toEqual({
    uptoSeq: 90,
    text: "extended brief",
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @dispatch/server test -- test/harness-engine-sessions.test.ts`
Expected: FAIL, `latestBrief` is not a function.

- [ ] **Step 4: Extend the store**

In `apps/server/src/agents/harness/engine-sessions.ts`:

Add to `HandoffRow`:

```ts
/** The last turn seq `olderBrief` covers; null when this switch compressed nothing. */
briefUptoSeq: number | null;
/** The incoming provider's summary of the turns up to `briefUptoSeq`. */
olderBrief: string | null;
```

Add `brief_upto_seq: number | null;` and `older_brief: string | null;` to `HandoffDbRow`, and to `toHandoff`:

```ts
  briefUptoSeq: r.brief_upto_seq,
  olderBrief: r.older_brief,
```

Change `recordHandoff` so the two fields are optional on input:

```ts
  async recordHandoff(
    input: Omit<HandoffRow, "id" | "createdAt" | "briefUptoSeq" | "olderBrief"> & {
      briefUptoSeq?: number | null;
      olderBrief?: string | null;
    }
  ): Promise<HandoffRow> {
    const result = await this.db.query<HandoffDbRow>(
      `INSERT INTO agent_engine_handoffs
         (agent_id, from_engine, to_engine, outcome, failure, briefing,
          brief_upto_seq, older_brief)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.agentId,
        input.fromEngine,
        input.toEngine,
        input.outcome,
        input.failure,
        input.briefing,
        input.briefUptoSeq ?? null,
        input.olderBrief ?? null,
      ]
    );
    return toHandoff(result.rows[0]);
  }
```

Add:

```ts
  /**
   * The newest compression saved for the agent, whichever switch wrote it.
   * Not "the newest handoff's brief": a switch that needed no compression
   * writes a row with none, and must not hide an earlier one.
   */
  async latestBrief(
    agentId: string
  ): Promise<{ uptoSeq: number; text: string } | null> {
    const result = await this.db.query<{
      brief_upto_seq: number;
      older_brief: string;
    }>(
      `SELECT brief_upto_seq, older_brief FROM agent_engine_handoffs
        WHERE agent_id = $1 AND older_brief IS NOT NULL
          AND brief_upto_seq IS NOT NULL
        ORDER BY brief_upto_seq DESC, id DESC
        LIMIT 1`,
      [agentId]
    );
    const row = result.rows[0];
    return row ? { uptoSeq: row.brief_upto_seq, text: row.older_brief } : null;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-engine-sessions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrations/0061_agent-engine-handoff-briefs.sql \
  apps/server/src/agents/harness/engine-sessions.ts \
  apps/server/test/harness-engine-sessions.test.ts
git commit -m "feat(harness): save a handoff's compression so a later switch can extend it"
```

---

### Task 2: A one-shot session with no tools

**Files:**

- Modify: `apps/server/src/agents/harness/driver.ts` (`DriverLaunch`, the `mcpServers` array in `start`)
- Create: `apps/server/src/agents/harness/one-shot.ts`
- Test: `apps/server/test/harness-one-shot.test.ts`

**Interfaces:**

- Consumes: `HarnessDriver`, `EngineSpec`.
- Produces: `runOneShot(input: { engine: EngineSpec; env: NodeJS.ProcessEnv; prompt: string; timeoutMs?: number; driver?: HarnessDriver; logger: DriverLogger }): Promise<string>`.

The supervisor's driver cannot host this. Every event it emits is recorded into `agent_stream_events` under the agent's id, and a second live session under the same id is refused outright (`the agent is already running for ...`). A one-shot therefore owns a private `HarnessDriver` whose events go nowhere but its own collector.

- [ ] **Step 1: Make the Dispatch MCP server optional**

In `apps/server/src/agents/harness/driver.ts`, in the `DriverLaunch` type, change:

```ts
mcp: {
  url: string;
  token: string;
}
```

to:

```ts
  /**
   * The Dispatch MCP server to attach. Absent for a session that must have no
   * Dispatch tools: a throwaway summarizer holding them could post to the
   * user's chat, or pin, as the agent it is summarizing.
   */
  mcp?: { url: string; token: string };
```

and in `start`, replace the `mcpServers` declaration with:

```ts
const mcpServers: acp.McpServer[] = launch.mcp
  ? [
      {
        type: "http",
        name: "dispatch",
        url: launch.mcp.url,
        headers: [
          { name: "Authorization", value: `Bearer ${launch.mcp.token}` },
        ],
      },
    ]
  : [];
```

Run `pnpm --filter @dispatch/server check`. The supervisor still passes `mcp`, so nothing else changes.

- [ ] **Step 2: Write the failing tests**

Create `apps/server/test/harness-one-shot.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { HarnessDriver } from "../src/agents/harness/driver.js";
import { runOneShot } from "../src/agents/harness/one-shot.js";
import { createFakeAcpAgent, type FakeTurn } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const ENGINE = {
  id: "codex" as const,
  bin: "/bin/codex-acp",
  args: [],
  env: {},
  personaDelivery: "first_prompt" as const,
  fullAccess: { kind: "env" as const },
  subagentTranscripts: false,
  modelFixedAtLaunch: false,
};

function driverOver(turn: FakeTurn) {
  const fake = createFakeAcpAgent({ turn });
  const driver = new HarnessDriver({
    spawn: () => fake.child,
    resolveBinary: async (bin: string) => bin,
    logger,
  });
  return { driver, fake };
}

const say =
  (text: string): FakeTurn =>
  async (_prompt, emit) => {
    await emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
    return "end_turn";
  };

describe("runOneShot", () => {
  it("returns the engine's reply as text and leaves nothing running", async () => {
    const { driver, fake } = driverOver(
      say("Earlier, the user chose Postgres.")
    );
    const text = await runOneShot({
      engine: ENGINE,
      env: {},
      prompt: "Summarize.",
      driver,
      logger,
    });
    expect(text).toBe("Earlier, the user chose Postgres.");
    expect(fake.seen.prompts).toEqual(["Summarize."]);
    expect(driver.liveAgentIds()).toEqual([]);
  });

  it("joins a reply that arrives in chunks", async () => {
    const { driver } = driverOver(async (_p, emit) => {
      for (const part of ["Earlier, ", "the user ", "chose Postgres."]) {
        await emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: part },
        });
      }
      return "end_turn";
    });
    expect(
      await runOneShot({ engine: ENGINE, env: {}, prompt: "x", driver, logger })
    ).toBe("Earlier, the user chose Postgres.");
  });

  it("attaches no MCP server", async () => {
    const { driver, fake } = driverOver(say("ok"));
    await runOneShot({ engine: ENGINE, env: {}, prompt: "x", driver, logger });
    // The fake records each session/new request whole.
    expect(fake.seen.newSession).toHaveLength(1);
    expect(fake.seen.newSession[0].mcpServers).toEqual([]);
  });

  it("throws on an empty reply, a timeout, and a failed turn, and stops the child each time", async () => {
    const empty = driverOver(async () => "end_turn");
    await expect(
      runOneShot({
        engine: ENGINE,
        env: {},
        prompt: "x",
        driver: empty.driver,
        logger,
      })
    ).rejects.toThrow("empty");
    expect(empty.driver.liveAgentIds()).toEqual([]);

    const slow = driverOver(
      async () =>
        new Promise((resolve) => setTimeout(() => resolve("end_turn"), 500))
    );
    await expect(
      runOneShot({
        engine: ENGINE,
        env: {},
        prompt: "x",
        driver: slow.driver,
        logger,
        timeoutMs: 40,
      })
    ).rejects.toThrow("did not answer in time");
    expect(slow.driver.liveAgentIds()).toEqual([]);

    const broken = driverOver(async () => {
      throw new Error("You've hit your usage limit.");
    });
    await expect(
      runOneShot({
        engine: ENGINE,
        env: {},
        prompt: "x",
        driver: broken.driver,
        logger,
      })
    ).rejects.toThrow("usage limit");
    expect(broken.driver.liveAgentIds()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-one-shot.test.ts`
Expected: FAIL, cannot resolve `one-shot.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/server/src/agents/harness/one-shot.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EngineSpec } from "./agent-spec.js";
import { HarnessDriver, type DriverLogger } from "./driver.js";

/** One summarizing call gets this long. A switch is waiting on it. */
const ONE_SHOT_TIMEOUT_MS = 90_000;

/**
 * Run one prompt on an engine and return what it said.
 *
 * In a session of its own, on a driver of its own. The supervisor's driver
 * records every event into the agent's feed and refuses a second session
 * under the same id, so it cannot host a call that must be invisible and run
 * beside the real one.
 *
 * The session is sealed on purpose. No Dispatch MCP server: with one, a
 * summarizer could post to the user's chat as the agent. An empty temporary
 * directory as its cwd: it has nothing to read and nothing to edit, so an
 * engine that decides to "check the files" finds none.
 *
 * Throws on a failed turn, an empty reply, or a timeout. The caller decides
 * what a failure means; the child is stopped and the directory removed on
 * every path.
 */
export async function runOneShot(input: {
  engine: EngineSpec;
  env: NodeJS.ProcessEnv;
  prompt: string;
  timeoutMs?: number;
  /** Injectable for tests that spawn a fake engine. */
  driver?: HarnessDriver;
  logger: DriverLogger;
}): Promise<string> {
  const driver = input.driver ?? new HarnessDriver({ logger: input.logger });
  const id = `oneshot_${randomUUID()}`;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dispatch-oneshot-"));
  let text = "";
  const unsubscribe = driver.onEvent((event) => {
    if (event.type !== "update" || event.agentId !== id) return;
    const update = event.update;
    if (update.sessionUpdate !== "agent_message_chunk") return;
    const content = update.content as { type?: string; text?: string };
    if (content.type === "text" && typeof content.text === "string") {
      text += content.text;
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await driver.start({
      agentId: id,
      cwd,
      engine: input.engine,
      systemPromptAppend: null,
      sessionId: null,
      env: input.env,
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("the summarizer did not answer in time")),
        input.timeoutMs ?? ONE_SHOT_TIMEOUT_MS
      );
      timer.unref?.();
    });
    await Promise.race([driver.prompt(id, input.prompt), timedOut]);
    const reply = text.trim();
    if (!reply) throw new Error("the summarizer returned an empty reply");
    return reply;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    await driver.stop(id).catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-one-shot.test.ts test/harness-supervisor.test.ts`
Expected: PASS. The supervisor suite runs too, because `DriverLaunch` changed under it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agents/harness/driver.ts \
  apps/server/src/agents/harness/one-shot.ts \
  apps/server/test/harness-one-shot.test.ts
git commit -m "feat(harness): run one prompt on an engine in a sealed, tool-less session"
```

---

### Task 3: Let the briefing carry a brief, and say what it left out

**Files:**

- Modify: `apps/server/src/agents/harness/handoff.ts`
- Test: `apps/server/test/harness-handoff.test.ts`

**Interfaces:**

- Produces: `buildHandoff` accepts `olderBrief?: { text: string; uptoSeq: number } | null` and returns two more fields, `omittedUptoSeq: number | null` and `omitted: AssembledTurn[]`. New `buildSummarizerPrompt(input: { omitted: AssembledTurn[]; previousBrief: string | null; maxInputTokens?: number }): { prompt: string; droppedOldest: number }`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/harness-handoff.test.ts`, reusing its `turn`, `FACTS` and `build`:

```ts
import { buildSummarizerPrompt } from "../src/agents/harness/handoff.js";

describe("buildHandoff with a brief", () => {
  const long = "x".repeat(4_000);
  const many = () =>
    Array.from({ length: 30 }, (_, i) => turn(i + 1, `prompt ${i + 1}`, long));

  it("reports which turns it left out, and the seq the omission reaches", () => {
    const turns = many();
    const out = build(turns, { budgetTokens: 5_000 });
    expect(out.omitted).toHaveLength(out.omittedTurns);
    expect(out.omitted[0].prompt.text).toBe("prompt 1");
    // turnSeqs in `build` are (index + 1) * 10.
    expect(out.omittedUptoSeq).toBe(out.omittedTurns * 10);
  });

  it("reports nothing left out when the session fits", () => {
    const out = build([turn(1, "p", "a")]);
    expect(out.omitted).toEqual([]);
    expect(out.omittedUptoSeq).toBeNull();
  });

  it("puts a brief where the omitted turns were, and stops saying they were dropped", () => {
    const turns = many();
    const bare = build(turns, { budgetTokens: 5_000 });
    const out = build(turns, {
      budgetTokens: 5_000,
      olderBrief: {
        text: "The user chose Postgres over SQLite in turn 2.",
        uptoSeq: bare.omittedUptoSeq,
      },
    });
    expect(out.text).toContain("Summary of the earlier turns");
    expect(out.text).toContain(
      "The user chose Postgres over SQLite in turn 2."
    );
    expect(out.text).not.toContain("earlier turns were omitted");
    // The brief sits above the replayed turns, which follow it in time.
    expect(out.text.indexOf("Summary of the earlier turns")).toBeLessThan(
      out.text.indexOf("prompt 30")
    );
  });

  it("still says turns were omitted when the brief does not reach them all", () => {
    const turns = many();
    const out = build(turns, {
      budgetTokens: 5_000,
      olderBrief: { text: "Covers only the first ten turns.", uptoSeq: 100 },
    });
    expect(out.text).toContain("Covers only the first ten turns.");
    expect(out.text).toContain("not covered by the summary");
  });
});

describe("buildSummarizerPrompt", () => {
  it("asks for a brief of the omitted turns and forbids tools", () => {
    const { prompt, droppedOldest } = buildSummarizerPrompt({
      omitted: [turn(1, "use postgres", "Agreed, Postgres.")],
      previousBrief: null,
    });
    expect(droppedOldest).toBe(0);
    expect(prompt).toContain("Do not use any tools");
    expect(prompt).toContain("User: use postgres");
    expect(prompt).toContain("Agent: Agreed, Postgres.");
    expect(prompt).toContain("decisions");
  });

  it("extends an earlier brief instead of starting over", () => {
    const { prompt } = buildSummarizerPrompt({
      omitted: [turn(9, "add an index", "Added.")],
      previousBrief: "The user chose Postgres.",
    });
    expect(prompt).toContain(
      "An earlier summary covers the turns before these"
    );
    expect(prompt).toContain("The user chose Postgres.");
    expect(prompt).toContain("User: add an index");
  });

  it("bounds its own input, dropping the oldest and saying how many", () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      turn(i + 1, `p${i + 1}`, "y".repeat(8_000))
    );
    const { prompt, droppedOldest } = buildSummarizerPrompt({
      omitted: big,
      previousBrief: null,
      maxInputTokens: 20_000,
    });
    expect(droppedOldest).toBeGreaterThan(0);
    expect(prompt).toContain("User: p40");
    expect(prompt).not.toContain("User: p1\n");
    expect(prompt).toContain(`${droppedOldest} older turns are not shown`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-handoff.test.ts`
Expected: FAIL. `omitted` is undefined and `buildSummarizerPrompt` is not exported.

- [ ] **Step 3: Extend `buildHandoff`**

In `apps/server/src/agents/harness/handoff.ts`, add to the input type:

```ts
  /**
   * A saved compression of the session's older turns, covering every turn up
   * to `uptoSeq`. Stands where those turns would have been.
   */
  olderBrief?: { text: string; uptoSeq: number } | null;
```

and widen the return type to:

```ts
): {
  text: string;
  omittedTurns: number;
  estimatedTokens: number;
  /** The turns left out, oldest first: what a summarizer would be given. */
  omitted: AssembledTurn[];
  /** The anchor seq of the newest omitted turn; null when none were. */
  omittedUptoSeq: number | null;
} {
```

`candidates` loses track of each turn's seq once it is filtered, so carry the seq with the turn. Replace the `candidates` declaration and the loop with:

```ts
const candidates = input.turns
  .map((turn, i) => ({ turn, seq: input.turnSeqs[i] }))
  .filter(({ seq }) => input.sinceSeq === null || seq > input.sinceSeq);

const kept: string[] = [];
let used = 0;
for (let i = candidates.length - 1; i >= 0; i -= 1) {
  const rendered = renderTurn(candidates[i].turn);
  const cost = estimateTokens(rendered);
  if (kept.length > 0 && used + cost > budget) break;
  kept.unshift(rendered);
  used += cost;
}
const omittedTurns = candidates.length - kept.length;
const omitted = candidates.slice(0, omittedTurns);
const omittedUptoSeq =
  omittedTurns > 0 ? omitted[omitted.length - 1].seq : null;
const brief = input.olderBrief ?? null;
// Turns the brief does not reach: left out of the replay and summarized by
// nobody. Said plainly, so the newcomer knows there is a gap.
const uncovered = omitted.filter(
  ({ seq }) => brief === null || seq > brief.uptoSeq
).length;
```

Replace the `conversation` expression with:

```ts
const lead =
  omittedTurns === 0
    ? "The conversation so far, oldest first."
    : brief && uncovered === 0
      ? "The newest turns follow in full, oldest first."
      : brief
        ? `${uncovered} turns after the summary are not covered by the summary and were omitted to keep this short. The newest follow, oldest first.`
        : `${omittedTurns} earlier turns were omitted to keep this short. The newest follow, oldest first.`;
const conversation =
  kept.length === 0
    ? resuming
      ? "No turns ran while you were away."
      : "No turns have run in this session yet."
    : [
        ...(brief && omittedTurns > 0
          ? [
              "Summary of the earlier turns, written when this session changed provider:",
              brief.text.trim(),
              "",
            ]
          : []),
        lead,
        "",
        kept.join("\n\n"),
      ].join("\n");
```

and return the two new fields:

```ts
return {
  text,
  omittedTurns,
  estimatedTokens: estimateTokens(text),
  omitted: omitted.map(({ turn }) => turn),
  omittedUptoSeq,
};
```

- [ ] **Step 4: Add the summarizer's prompt**

In the same file:

```ts
/**
 * Room for the turns a summarizer reads. It is the incoming provider's
 * context too, and a very long session is exactly when this runs.
 */
const SUMMARIZER_INPUT_TOKENS = 60_000;

/**
 * What the incoming provider is asked, once, in a sealed session.
 *
 * It asks for what a successor needs and would not find on disk: decisions
 * and the reasons for them, constraints the user stated, what was tried and
 * abandoned, what is unfinished. Not a narration of commands: the files
 * already hold their results.
 */
export function buildSummarizerPrompt(input: {
  omitted: AssembledTurn[];
  previousBrief: string | null;
  maxInputTokens?: number;
}): { prompt: string; droppedOldest: number } {
  const budget = input.maxInputTokens ?? SUMMARIZER_INPUT_TOKENS;
  const kept: string[] = [];
  let used = 0;
  for (let i = input.omitted.length - 1; i >= 0; i -= 1) {
    const rendered = renderTurn(input.omitted[i]);
    const cost = estimateTokens(rendered);
    if (kept.length > 0 && used + cost > budget) break;
    kept.unshift(rendered);
    used += cost;
  }
  const droppedOldest = input.omitted.length - kept.length;
  const prompt = [
    "You are writing a handoff note for another coding agent that is about to take over a long session. It will read your note in place of the turns below, which are too long to give it in full.",
    "Do not use any tools. Do not read or write files. Answer with the note and nothing else.",
    "",
    "Write what a successor needs and cannot learn from the files on disk:",
    "- decisions that were made, and the reason for each",
    "- constraints and preferences the user stated",
    "- approaches that were tried and abandoned, and why",
    "- anything left unfinished or explicitly deferred",
    "Do not narrate commands or restate file contents. Be specific: name files, functions and values. Plain prose or short bullets, at most 600 words.",
    "",
    ...(input.previousBrief
      ? [
          "An earlier summary covers the turns before these. Fold it into your note: keep what still holds, and update what these turns changed.",
          "--- EARLIER SUMMARY ---",
          input.previousBrief.trim(),
          "--- END EARLIER SUMMARY ---",
          "",
        ]
      : []),
    ...(droppedOldest > 0
      ? [`${droppedOldest} older turns are not shown; they did not fit.`, ""]
      : []),
    "--- TURNS TO SUMMARIZE, OLDEST FIRST ---",
    kept.join("\n\n"),
    "--- END TURNS ---",
  ].join("\n");
  return { prompt, droppedOldest };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-handoff.test.ts`
Expected: PASS, the 10 tests from plan 2 and 7 new ones.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agents/harness/handoff.ts \
  apps/server/test/harness-handoff.test.ts
git commit -m "feat(harness): let a handoff carry a summary of the turns it left out"
```

---

### Task 4: Compress at switch time, and never block on it

**Files:**

- Modify: `apps/server/src/harness-switch-settings.ts`
- Modify: `apps/server/src/agents/harness/supervisor.ts` (`SupervisorDeps`, `handoffFor`, `switchEngine`, `previewSwitch`)
- Modify: `apps/server/src/server.ts`
- Modify: `packages/shared/src/harness-types.ts` (`HarnessSwitchPreview`)
- Modify: `apps/web/src/components/app/harness/switch-dialog.tsx`
- Test: `apps/server/test/harness-switch.test.ts`, `apps/web/src/components/app/harness/switch-dialog.test.tsx`

**Interfaces:**

- Consumes: `runOneShot` (Task 2), `buildSummarizerPrompt` and the widened `buildHandoff` (Task 3), `latestBrief` (Task 1).
- Produces: `SupervisorDeps.summarize?: (engine: HarnessEngineId, model: string, prompt: string) => Promise<string>` and `compressionEnabled?: () => Promise<boolean>`. `SwitchPreview.compresses: boolean`.

- [ ] **Step 1: Add the setting**

Append to `apps/server/src/harness-switch-settings.ts`:

```ts
/**
 * Whether a switch summarizes the turns that do not fit the briefing. On by
 * default. Off, a long session's oldest turns are left out and the briefing
 * says so, which is also what happens whenever the summarizer fails.
 */
const HARNESS_HANDOFF_COMPRESSION_KEY = "harness_handoff_compression_enabled";

export async function isHarnessHandoffCompressionEnabled(
  pool: Pool
): Promise<boolean> {
  return (await getSetting(pool, HARNESS_HANDOFF_COMPRESSION_KEY)) !== "false";
}

export async function setHarnessHandoffCompressionEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(
    pool,
    HARNESS_HANDOFF_COMPRESSION_KEY,
    enabled ? "true" : "false"
  );
}
```

- [ ] **Step 2: Write the failing tests**

In `apps/server/test/harness-switch.test.ts`, extend `build()`'s options with `turnsToLoad?: { turns: unknown[]; seqs: number[] }`, `summarize?: (engine: string, model: string, prompt: string) => Promise<string>`, and `savedBrief?: { uptoSeq: number; text: string }`. Wire them into `deps`:

```ts
    loadTurns: async () => opts.turnsToLoad ?? { turns: [], seqs: [] },
    ...(opts.summarize ? { summarize: opts.summarize } : {}),
```

and add `latestBrief: async () => opts.savedBrief ?? null,` to the `engineSessions` stub.

Add a long-session fixture and the tests:

```ts
const longSession = () => {
  const turns = Array.from({ length: 40 }, (_, i) => ({
    id: `turn:${i + 1}`,
    prompt: { source: "chat", text: `prompt ${i + 1}`, attachments: [] },
    trace: {
      startedAt: "2026-09-20T10:00:00.000Z",
      finalResult: "ok",
      steps: [],
    },
    result: { text: "z".repeat(4_000), streaming: false },
  }));
  return { turns, seqs: turns.map((_, i) => (i + 1) * 10) };
};

describe("switchEngine compression", () => {
  it("summarizes the turns that do not fit, once, on the incoming engine", async () => {
    const asked: { engine: string; prompt: string }[] = [];
    const { sup, spawns, handoffs } = await build({
      turn: async () => "end_turn",
      turnsToLoad: longSession(),
      summarize: async (engine, _model, prompt) => {
        asked.push({ engine, prompt });
        return "The user chose Postgres in turn 2.";
      },
    });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(asked).toHaveLength(1);
    expect(asked[0].engine).toBe("codex");
    expect(asked[0].prompt).toContain("User: prompt 1");
    await sup.enqueuePrompt("agt_1", "go on").settled;
    const sent = spawns[1].fake.seen.prompts[0] ?? "";
    expect(sent).toContain("The user chose Postgres in turn 2.");
    expect(sent).not.toContain("earlier turns were omitted");
    expect(handoffs[0]).toMatchObject({
      olderBrief: "The user chose Postgres in turn 2.",
    });
    expect(Number(handoffs[0].briefUptoSeq)).toBeGreaterThan(0);
    await sup.stop("agt_1");
  });

  it("switches anyway when the summarizer fails, and says turns were omitted", async () => {
    const { sup, spawns, handoffs, agent } = await build({
      turn: async () => "end_turn",
      turnsToLoad: longSession(),
      summarize: async () => {
        throw new Error("You've hit your usage limit.");
      },
    });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(agent.model).toBe("codex/default");
    await sup.enqueuePrompt("agt_1", "go on").settled;
    expect(spawns[1].fake.seen.prompts[0]).toContain(
      "earlier turns were omitted"
    );
    expect(handoffs[0]).toMatchObject({ outcome: "switched" });
    expect(handoffs[0].olderBrief ?? null).toBeNull();
    await sup.stop("agt_1");
  });

  it("calls no model when the session fits", async () => {
    const summarize = vi.fn(async () => "unused");
    const { sup } = await build({ turn: async () => "end_turn", summarize });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(summarize).not.toHaveBeenCalled();
    await sup.stop("agt_1");
  });

  it("calls no model for a returning engine, which already has the history", async () => {
    const summarize = vi.fn(async () => "unused");
    const { sup } = await build({
      turn: async () => "end_turn",
      turnsToLoad: longSession(),
      remembered: { codex: { sessionId: "codex-old", lastSeenSeq: 390 } },
      summarize,
    });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(summarize).not.toHaveBeenCalled();
    await sup.stop("agt_1");
  });

  it("extends a saved brief, summarizing only what came after it", async () => {
    const asked: string[] = [];
    const { sup } = await build({
      turn: async () => "end_turn",
      turnsToLoad: longSession(),
      savedBrief: { uptoSeq: 200, text: "Turns 1 to 20: chose Postgres." },
      summarize: async (_e, _m, prompt) => {
        asked.push(prompt);
        return "Chose Postgres; later added an index.";
      },
    });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(asked[0]).toContain("Turns 1 to 20: chose Postgres.");
    // Turn 20 has seq 200 and is covered; turn 21 is the first one re-read.
    expect(asked[0]).not.toContain("User: prompt 20\n");
    expect(asked[0]).toContain("User: prompt 21");
    await sup.stop("agt_1");
  });

  it("reuses a saved brief outright when it already covers everything left out", async () => {
    const summarize = vi.fn(async () => "unused");
    const { sup, spawns } = await build({
      turn: async () => "end_turn",
      turnsToLoad: longSession(),
      savedBrief: { uptoSeq: 400, text: "Everything so far: chose Postgres." },
      summarize,
    });
    await sup.start("agt_1");
    await sup.switchEngine("agt_1", "codex/default", { continueTask: false });
    expect(summarize).not.toHaveBeenCalled();
    await sup.enqueuePrompt("agt_1", "go on").settled;
    expect(spawns[1].fake.seen.prompts[0]).toContain(
      "Everything so far: chose Postgres."
    );
    await sup.stop("agt_1");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-switch.test.ts`
Expected: FAIL. `summarize` is never called and no brief reaches the prompt.

- [ ] **Step 4: Compress in the supervisor**

In `apps/server/src/agents/harness/supervisor.ts`, import `buildSummarizerPrompt` beside `buildHandoff`, and add to `SupervisorDeps`:

```ts
  /**
   * Run one summarizing prompt on an engine, in a sealed session (see
   * one-shot.ts). Absent, or throwing: the briefing falls back to a
   * truncated replay. Never the reason a switch fails.
   */
  summarize?: (
    engine: HarnessEngineId,
    model: string,
    prompt: string
  ) => Promise<string>;
  compressionEnabled?: () => Promise<boolean>;
```

Replace `handoffFor` with a version that knows the target and can compress. It returns the brief it used, so `switchEngine` can save it:

```ts
  private async handoffFor(
    agentId: string,
    fromEngine: HarnessEngineId,
    sinceSeq: number | null,
    /** Set for a real switch to a fresh session: allows one summarizing call. */
    compressOn?: { engine: HarnessEngineId; model: string }
  ): Promise<{
    text: string;
    estimatedTokens: number;
    lastSeq: number;
    wouldCompress: boolean;
    brief: { text: string; uptoSeq: number } | null;
  }> {
    const agent = await this.deps.getAgent(agentId);
    const { turns, seqs } = await this.deps.loadTurns(agentId);
    const newestPlan = [...turns].reverse().find((t) => t.plan)?.plan ?? [];
    const facts = await gatherHandoffFacts({
      cwd: agent?.cwd ?? process.cwd(),
      tasks: newestPlan.map((t) => ({ content: t.content, status: t.status })),
      pins: (agent?.pins ?? [])
        .filter((p) => p.type !== "shortcut")
        .map((p) => ({ label: p.label, value: p.value })),
    });
    const base = {
      turns,
      turnSeqs: seqs,
      sinceSeq,
      facts,
      fromEngineLabel: this.engineLabel(fromEngine),
    };
    const lastSeq = seqs.length > 0 ? seqs[seqs.length - 1] : 0;
    const bare = buildHandoff(base);
    // A returning engine has the history in its own session; and a session
    // that fits needs no summary. Either way, no model is called.
    const eligible =
      sinceSeq === null &&
      bare.omittedUptoSeq !== null &&
      Boolean(this.deps.summarize) &&
      (this.deps.compressionEnabled
        ? await this.deps.compressionEnabled()
        : true);
    if (!eligible || bare.omittedUptoSeq === null) {
      return { ...bare, lastSeq, wouldCompress: false, brief: null };
    }

    const saved = await this.deps.engineSessions.latestBrief(agentId);
    let brief = saved;
    // Only the turns the saved brief does not reach are read again.
    const seqOf = new Map(turns.map((turn, i) => [turn, seqs[i]]));
    const uncovered = bare.omitted.filter(
      (turn) => saved === null || (seqOf.get(turn) ?? 0) > saved.uptoSeq
    );
    if (uncovered.length > 0 && compressOn) {
      try {
        const { prompt } = buildSummarizerPrompt({
          omitted: uncovered,
          previousBrief: saved?.text ?? null,
        });
        const text = await this.deps.summarize!(
          compressOn.engine,
          compressOn.model,
          prompt
        );
        brief = { text, uptoSeq: bare.omittedUptoSeq };
      } catch (err) {
        // The switch goes ahead on a truncated replay. Whoever is switching
        // may be doing so because a provider ran dry; a summary must never
        // be what strands them.
        this.deps.logger.warn(
          { err, agentId, engine: compressOn.engine },
          "could not summarize earlier turns for a provider handoff; omitting them"
        );
      }
    }
    const built = brief ? buildHandoff({ ...base, olderBrief: brief }) : bare;
    return {
      ...built,
      lastSeq,
      wouldCompress: uncovered.length > 0,
      // Saved only when this call wrote or extended it.
      brief: brief !== saved ? brief : null,
    };
  }
```

In `switchEngine`, the handoff built after the stop is the real one, so it may compress. Replace that call:

```ts
const newModelName = splitModelId(newModel).model;
const handoff = await this.handoffFor(
  agentId,
  from.engine,
  remembered ? remembered.lastSeenSeq : null,
  { engine: target, model: newModelName }
);
```

The fallback for a remembered session that came back fresh passes the same fourth argument, since that session is cold too:

```ts
const fallback =
  remembered && !resumed
    ? await this.handoffFor(agentId, from.engine, null, {
        engine: target,
        model: newModelName,
      })
    : null;
const text = fallback?.text ?? handoff.text;
const brief = fallback?.brief ?? handoff.brief;
```

and both `recordHandoff` call sites for a successful switch carry the brief:

```ts
        ...(brief
          ? { olderBrief: brief.text, briefUptoSeq: brief.uptoSeq }
          : {}),
```

In `previewSwitch`, call `handoffFor` without the fourth argument, so a preview never spends a model call, and add to the returned object:

```ts
      compresses: preview.wouldCompress,
```

where `preview` is that call's result, and add `compresses: boolean;` to the `SwitchPreview` type.

- [ ] **Step 5: Wire the summarizer in `server.ts`**

In the supervisor's deps:

```ts
    summarize: async (engine, model, prompt) => {
      const env = buildChildEnv({
        agentId: "oneshot",
        mediaDir: os.tmpdir(),
        config,
        engine,
      });
      const spec = engineSpecFor(
        engine,
        model,
        await harnessSupervisor.binsForEngine(engine, env)
      );
      return runOneShot({ engine: spec, env, prompt, logger: app.log });
    },
    compressionEnabled: () => isHarnessHandoffCompressionEnabled(pool),
```

`binsFor` is private on the supervisor. Add a public pass-through beside it:

```ts
  /** The resolved binaries for an engine, for a caller that spawns one itself. */
  binsForEngine(
    engine: HarnessEngineId,
    env: NodeJS.ProcessEnv
  ): Promise<EngineBins> {
    return this.binsFor(engine, env);
  }
```

`harnessSupervisor` is referenced inside its own deps object. That is safe because `summarize` runs long after construction, but TypeScript will complain about use before assignment: declare `let harnessSupervisor: HarnessSupervisor;` first and assign it, as `limitResumeScheduler` is handled in plan 1. `buildChildEnv` and `engineSpecFor` are already exported from the harness modules; import `runOneShot` from `./agents/harness/one-shot.js` and `isHarnessHandoffCompressionEnabled` from `./harness-switch-settings.js`.

`buildChildEnv` strips provider API keys from the child's environment (`ENV_DENY_EXACT`). The summarizer inherits that, so it authenticates through the host CLI's subscription login, like every other engine session.

- [ ] **Step 6: Tell the user it will take a moment**

Add `compresses: boolean;` to `HarnessSwitchPreview` in `packages/shared/src/harness-types.ts`.

In `apps/web/src/components/app/harness/switch-dialog.tsx`, inside the block that renders the cost line, after it:

```tsx
{
  data?.compresses ? (
    <p
      className="text-[11px] text-muted-foreground"
      data-testid="switch-compresses"
    >
      This session is long. {target.engineLabel} will summarize the earlier
      turns first, which takes up to a minute and one extra request.
    </p>
  ) : null;
}
```

Add to `switch-dialog.test.tsx`:

```tsx
it("warns that a long session is summarized first", () => {
  S.preview = { ...S.preview, compresses: true };
  dialog();
  expect(screen.getByTestId("switch-compresses").textContent).toContain(
    "will summarize the earlier turns first"
  );
});

it("says nothing about summarizing a session that fits", () => {
  S.preview = { ...S.preview, compresses: false };
  dialog();
  expect(screen.queryByTestId("switch-compresses")).toBeNull();
});
```

- [ ] **Step 7: Run everything**

```bash
pnpm --filter @dispatch/server test -- test/harness-switch.test.ts test/harness-handoff.test.ts test/harness-one-shot.test.ts
pnpm run check
cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/switch-dialog.test.tsx && cd ../..
```

Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/harness-switch-settings.ts \
  apps/server/src/agents/harness/supervisor.ts apps/server/src/server.ts \
  packages/shared/src/harness-types.ts \
  apps/web/src/components/app/harness/switch-dialog.tsx \
  apps/web/src/components/app/harness/switch-dialog.test.tsx \
  apps/server/test/harness-switch.test.ts
git commit -m "feat(harness): summarize the turns a long session's handoff would drop"
```

---

### Task 5: The setting route, a real check, and docs

**Files:**

- Modify: `apps/server/src/routes/system.ts`
- Modify: `docs/10-operations-runbook.md`, `release-notes/current.md`

- [ ] **Step 1: Expose the setting**

In `apps/server/src/routes/system.ts`, after the `harness-engine-switch` pair, add the matching `GET` and `POST /api/v1/app/settings/harness-handoff-compression` pair over `isHarnessHandoffCompressionEnabled` and `setHarnessHandoffCompressionEnabled`, identical in shape to its neighbors, with a sibling test: default `true`, a `POST` of `false` reads back `false`, a non-boolean body is `400`.

- [ ] **Step 2: One real long-session switch, by hand**

Find or make a Dispatch agent with a session long enough to overflow the budget. `psql` finds one:

```sql
SELECT agent_id, count(*) AS turns
  FROM agent_stream_events WHERE kind = 'turn'
 GROUP BY agent_id ORDER BY turns DESC LIMIT 5;
```

1. Open the switch dialog on it. It should warn that the earlier turns will be summarized.
2. Switch. Time it. Note how long the summarizing call took.
3. Open "View handoff". Read the summary against what you remember of the session. Does it hold the decisions that mattered? Does it invent any? An invented decision is worse than a missing one: a successor acts on it.
4. Switch away and back to a third state so a second compression runs. Confirm in `agent_engine_handoffs` that `brief_upto_seq` advanced and that the second summarizer prompt (log it temporarily) contained the first brief and only the newer turns.
5. Turn `harness_handoff_compression_enabled` off, switch again, and confirm the briefing says earlier turns were omitted and no summarizing call ran.

Record the timing and what the summary got right and wrong in the PR description. If it invents, tighten the prompt in `buildSummarizerPrompt` and pin the change with a test on the prompt's wording.

- [ ] **Step 3: Document it**

In `docs/10-operations-runbook.md`, after the provider-switch paragraphs from plan 2:

```markdown
A briefing replays the newest turns that fit about 24,000 tokens. A session
longer than that would lose its earliest turns, and those tend to hold the
decisions. So when turns are left out, the incoming provider summarizes them
first: one request, in a session of its own with no Dispatch tools and an empty
working directory, bounded to 90 seconds. The main session receives the finished
summary, never the raw history. The summary is saved on the handoff row with the
seq of the last turn it covers, so the next switch reads only what came after
and extends it.

A session that fits calls no model. A provider being returned to is never
summarized for, since its own session holds the history. If the summarizing call
fails for any reason, including the incoming provider being out of allowance
itself, the switch goes ahead on the truncated replay and the briefing says
earlier turns were omitted. `harness_handoff_compression_enabled` (default on)
turns summarizing off.
```

In `release-notes/current.md`, extend the "Switch provider mid-session" bullet with:

```markdown
A session too long to replay is summarized first by the incoming provider, in a sealed session with no tools; a session that fits calls no model, and a summary that fails never blocks the switch. Turn summarizing off with `harness_handoff_compression_enabled`.
```

- [ ] **Step 4: Run everything and commit**

```bash
pnpm run check
pnpm --filter @dispatch/server test
cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run && cd ../..
pnpm run finalize:web
git add apps/server/src/routes/system.ts docs/10-operations-runbook.md \
  release-notes/current.md
git add -u apps/server/test
git commit -m "docs: handoff compression in the runbook and release notes"
```
