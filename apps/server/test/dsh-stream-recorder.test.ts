import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { DriverEvent } from "../src/agents/dsh/driver.js";
import {
  boundOutput,
  inferToolKind,
  StreamRecorder,
  TEXT_MAX_BYTES,
} from "../src/agents/dsh/stream-recorder.js";
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

const chunk = (text: string): DriverEvent => ({
  type: "update",
  agentId: A,
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  },
});

const thought = (text: string): DriverEvent => ({
  type: "update",
  agentId: A,
  update: {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  },
});

describe("StreamRecorder", () => {
  it("accumulates chunks into one assistant row and settles it at turn end", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
    await rec.handle(chunk("Hel"));
    await rec.handle(chunk("lo"));
    await rec.flush(A);
    const open = await store.list(A, 10);
    expect(open[0].payload).toEqual({ text: "Hello", streaming: true });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      stopReason: "end_turn",
    });
    const rows = (await store.list(A, 10)).filter((r) => r.kind !== "turn");
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
    await rec.flush(A);
    // Updates with no prompted turn open a turn of their own (a goal round);
    // this test is about the text rows, so it looks past that one.
    const rows = (await store.list(A, 10))
      .reverse()
      .filter((r) => r.kind !== "turn");
    expect(rows.map((r) => r.kind)).toEqual([
      "assistant",
      "tool_call",
      "assistant",
    ]);
    expect(rows[0].payload).toEqual({ text: "one", streaming: false });
    expect(rows[1].key).toBe("c1");
    expect(rows[1].payload).toEqual({
      toolKind: "read",
      title: "Read x",
      status: "completed",
      locations: [{ path: "/w/x" }],
      diff: { path: "/w/x", oldText: "a", newText: "b" },
      terminalOutput: null,
    });
    expect(rows[2].payload).toEqual({ text: "two", streaming: true });
  });

  it("keeps thoughts in their own rows, separate from assistant text", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle(thought("plan"));
    await rec.handle(thought("ning"));
    await rec.handle(chunk("Done."));
    const rows = (await store.list(A, 10))
      .reverse()
      .filter((r) => r.kind !== "turn");
    expect(rows.map((r) => [r.kind, r.payload.text])).toEqual([
      ["thought", "planning"],
      ["assistant", "Done."],
    ]);
  });

  it("captures terminal output from content blocks on a tool call update", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "sh1",
        title: "pnpm test",
        kind: "execute",
        status: "in_progress",
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "sh1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "12 passed\n" } },
        ],
      },
    });
    const rows = await store.list(A, 10);
    expect(rows[0].payload).toMatchObject({
      toolKind: "execute",
      status: "completed",
      terminalOutput: "12 passed\n",
    });
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
      expected: false,
    });
    await rec.handle({
      type: "exit",
      agentId: A,
      code: 0,
      signal: null,
      stderrTail: "",
      expected: false,
    });
    // A stop Dispatch asked for is not a crash, whatever signal it took.
    await rec.handle({
      type: "exit",
      agentId: A,
      code: null,
      signal: "SIGTERM",
      stderrTail: "",
      expected: true,
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows.map((r) => r.payload.message)).toEqual([
      "no API key",
      "dsh exited with code 1: boom",
    ]);
  });

  it("renders tool locations relative to the agent's cwd", async () => {
    const rec = new StreamRecorder(store);
    rec.setCwd(A, "/w/repo");
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "r1",
        title: "Read",
        kind: "read",
        status: "completed",
        locations: [
          { path: "/w/repo/src/index.ts", line: 3 },
          { path: "/etc/hosts" },
        ],
      },
    });
    const rows = await store.list(A, 1);
    expect(rows[0].payload.locations).toEqual([
      { path: "src/index.ts", line: 3 },
      { path: "/etc/hosts" },
    ]);
  });

  it("bounds an assistant message and marks it truncated", async () => {
    const rec = new StreamRecorder(store);
    const big = "x".repeat(TEXT_MAX_BYTES + 10);
    await rec.handle(chunk("start"));
    await rec.handle(chunk(big));
    await rec.handle(chunk("ignored after the cap"));
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      stopReason: "end_turn",
    });
    const rows = await store.list(A, 1);
    const payload = rows[0].payload as {
      text: string;
      truncated?: boolean;
      streaming: boolean;
    };
    expect(payload.truncated).toBe(true);
    expect(payload.streaming).toBe(false);
    expect(Buffer.byteLength(payload.text, "utf8")).toBeLessThanOrEqual(
      TEXT_MAX_BYTES + 32
    );
    expect(payload.text).toContain("[truncated]");
  });

  it("bounds terminal output head and tail", () => {
    const out = boundOutput("a".repeat(100) + "b".repeat(100), 50);
    expect(out.truncated).toBe(true);
    expect(out.text.startsWith("a".repeat(25))).toBe(true);
    expect(out.text.endsWith("b".repeat(25))).toBe(true);
    expect(boundOutput("short", 50)).toEqual({
      text: "short",
      truncated: false,
    });
  });

  it("infers a tool kind from the tool name when dsh sends none", () => {
    expect(inferToolKind(undefined, "bash")).toBe("execute");
    expect(inferToolKind(undefined, "read")).toBe("read");
    expect(inferToolKind(undefined, "str_replace_editor")).toBe("edit");
    expect(inferToolKind(undefined, "grep")).toBe("search");
    expect(inferToolKind(undefined, "web_fetch")).toBe("fetch");
    expect(inferToolKind(undefined, "mcp__dispatch__dispatch_event")).toBe(
      "other"
    );
    expect(inferToolKind("delete", "bash")).toBe("delete");
    expect(inferToolKind("other", "bash")).toBe("execute");
  });

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
    expect(rows[1].kind).toBe("status");
  });
});

describe("StreamRecorder interrupted turns", () => {
  it("settles the open turn with an error when the child dies mid-turn", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle(chunk("partial"));
    await rec.handle({
      type: "exit",
      agentId: A,
      code: 1,
      signal: null,
      stderrTail: "boom",
      expected: false,
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows[0].kind).toBe("turn");
    expect(rows[0].payload).toMatchObject({
      state: "settled",
      error: "dsh exited before the turn settled",
    });
    expect(typeof rows[0].payload.endedAt).toBe("string");
    expect(rows[1].payload).toMatchObject({
      text: "partial",
      streaming: false,
    });
  });

  it("settles a turn cut off by Stop as cancelled", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle({
      type: "exit",
      agentId: A,
      code: 0,
      signal: null,
      stderrTail: "",
      expected: true,
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows[0].payload).toMatchObject({
      state: "settled",
      stopReason: "cancelled",
    });
    expect(rows).toHaveLength(1);
  });

  it("reconcile settles what a previous process left open", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle(chunk("half"));
    // A fresh recorder, as after a server restart: no in-memory turn.
    const fresh = new StreamRecorder(store);
    expect(await fresh.reconcile(A)).toBe(1);
    const rows = (await store.list(A, 10)).reverse();
    expect(rows[0].payload).toMatchObject({
      state: "settled",
      error: "interrupted by restart",
    });
    expect(rows[1].payload).toMatchObject({ streaming: false });
  });
});

describe("StreamRecorder command log", () => {
  it("logs a shell command once, when it settles", async () => {
    const entries: unknown[] = [];
    const rec = new StreamRecorder(store, {
      commandLog: async (_id, entry) => {
        entries.push(entry);
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "bash",
        kind: "other",
        status: "in_progress",
        rawInput: { command: "ls apps" },
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "web\n" } },
        ],
      },
    });
    // A second update after settling does not log again.
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: "ls apps",
      output: "web\n",
      status: "completed",
    });
  });
});

describe("StreamRecorder autonomous turns", () => {
  const call = (id: string): DriverEvent => ({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: "get_goal",
      kind: "other",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "{}" } }],
    },
  });
  const turnRows = async () =>
    (
      await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn' ORDER BY seq`,
        [A]
      )
    ).rows.map((r) => r.payload);

  it("opens a goal-round turn when dsh acts without a prompt and settles it once quiet", async () => {
    const settled: string[] = [];
    const rec = new StreamRecorder(store, {
      autonomousIdleMs: 40,
      onAutonomousSettled: (id) => settled.push(id),
    });
    await rec.handle(call("c1"));
    let turns = await turnRows();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ state: "started", autonomous: true });
    expect(String((turns[0].prompt as { text: string }).text)).toContain(
      "GOAL ROUND"
    );
    // Activity keeps it open; quiet ends it.
    await new Promise((r) => setTimeout(r, 25));
    await rec.handle(call("c2"));
    await new Promise((r) => setTimeout(r, 25));
    expect((await turnRows())[0].state).toBe("started");
    await new Promise((r) => setTimeout(r, 60));
    turns = await turnRows();
    expect(turns[0]).toMatchObject({
      state: "settled",
      stopReason: "end_turn",
    });
    expect(settled).toEqual([A]);
  });

  it("settles an open goal-round turn before a prompted turn starts", async () => {
    const rec = new StreamRecorder(store, { autonomousIdleMs: 10_000 });
    await rec.handle(call("c1"));
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    const turns = await turnRows();
    expect(turns.map((t) => [t.state, t.autonomous ?? false])).toEqual([
      ["settled", true],
      ["started", false],
    ]);
    await rec.reconcile(A);
  });

  it("does not open a turn for a config change alone", async () => {
    const rec = new StreamRecorder(store, { autonomousIdleMs: 10_000 });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [],
      } as never,
    });
    expect(await turnRows()).toHaveLength(0);
  });
});
