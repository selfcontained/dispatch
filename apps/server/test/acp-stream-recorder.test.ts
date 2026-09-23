import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";

import type { DriverEvent } from "../src/agents/acp/driver.js";
import {
  boundOutput,
  inferToolKind,
  StreamRecorder,
  TEXT_MAX_BYTES,
} from "../src/agents/acp/stream-recorder.js";
import { StreamStore } from "../src/agents/acp/stream-store.js";
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
      "the agent exited with code 1: boom",
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

  it("bounds both halves of a diff and marks the row truncated", async () => {
    // Gemini CLI's write_file and OpenCode's write tool send the whole
    // previous file as oldText, so an edit to a large file would otherwise
    // put that file into the row, and every chat feed page and turns read
    // pulls it back out again.
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "big",
        title: "Write x",
        kind: "edit",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/w/x",
            oldText: "o".repeat(TEXT_MAX_BYTES + 10),
            newText: "n",
          },
        ],
      },
    });
    const row = (await store.list(A, 10)).find((r) => r.key === "big");
    const payload = row?.payload as {
      diff: { oldText: string; newText: string };
      truncated?: boolean;
    };
    expect(payload.truncated).toBe(true);
    expect(payload.diff.oldText).toContain("[truncated]");
    expect(Buffer.byteLength(payload.diff.oldText, "utf8")).toBeLessThanOrEqual(
      TEXT_MAX_BYTES + 32
    );
    expect(payload.diff.newText).toBe("n");
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

  it("infers a tool kind from the tool name when the engine sends none", () => {
    expect(inferToolKind(undefined, "bash")).toBe("execute");
    expect(inferToolKind(undefined, "read")).toBe("read");
    expect(inferToolKind(undefined, "str_replace_editor")).toBe("edit");
    expect(inferToolKind(undefined, "grep")).toBe("search");
    expect(inferToolKind(undefined, "web_fetch")).toBe("fetch");
    expect(inferToolKind(undefined, "mcp__dispatch__notify")).toBe("other");
    expect(inferToolKind("delete", "bash")).toBe("delete");
    expect(inferToolKind("other", "bash")).toBe("execute");
  });

  it("records a turn row at start and settles it in place", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "--- DISPATCH POST (id: 11111111-2222-4333-8444-555555555555, from: user) ---\nhi\n--- END DISPATCH POST ---",
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
        source: "system",
        text: "--- DISPATCH POST (id: 11111111-2222-4333-8444-555555555555, from: user) ---\nhi\n--- END DISPATCH POST ---",
      },
    });
    expect(typeof rows[0].payload.endedAt).toBe("string");
  });

  it("takes the prompt's source from the sender, not from its text", async () => {
    const rec = new StreamRecorder(store);
    // Dispatch knows which block it is delivering, so it says so. The text
    // carries no envelope here: reading the id back out of the wire would
    // find nothing, and the turn would lose the message that opened it.
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "hi",
      source: {
        source: "chat",
        chatMessageId: "11111111-2222-4333-8444-555555555555",
      },
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      stopReason: "end_turn",
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows[0].payload).toMatchObject({
      prompt: {
        source: "chat",
        chatMessageId: "11111111-2222-4333-8444-555555555555",
      },
    });
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

  it("offers a retry on a turn that failed on a passing error, and not on one that needs something changed", async () => {
    const rec = new StreamRecorder(store);
    const fail = async (errorKind: string) => {
      await rec.handle({
        type: "turn",
        agentId: A,
        state: "started",
        text: "x",
      });
      await rec.handle({
        type: "turn",
        agentId: A,
        state: "settled",
        error: "API Error",
        errorKind,
      });
      const [turn] = (await store.list(A, 10)).filter((r) => r.kind === "turn");
      return turn!.payload;
    };
    expect(await fail("server_error")).toMatchObject({
      errorKind: "server_error",
      retry: "open",
    });
    await pool.query("DELETE FROM agent_stream_events");
    const auth = await fail("authentication_failed");
    expect(auth).toMatchObject({ errorKind: "authentication_failed" });
    expect(auth.retry).toBeUndefined();
  });

  it("a new turn closes the retry an earlier failed turn offered, and republishes it", async () => {
    const rec = new StreamRecorder(store);
    const settled = vi.fn(async () => undefined);
    rec.setTurnBlocks({ started: async () => null, settled });
    await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: "API Error",
      errorKind: "overloaded",
    });
    settled.mockClear();
    await rec.handle({ type: "turn", agentId: A, state: "started", text: "y" });
    const turns = (await store.list(A, 10))
      .filter((r) => r.kind === "turn")
      .reverse();
    expect(turns[0]!.payload.retry).toBe("closed");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0]).toMatchObject({
      turnRow: { id: turns[0]!.id },
    });
  });

  it("writes a plan row for the live turn and replaces it on the next plan", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "read", status: "completed", priority: "high" },
          { content: "edit", status: "in_progress", priority: "medium" },
        ],
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "p1",
          entries: [
            { content: "read", status: "completed", priority: "high" },
            { content: "edit", status: "completed", priority: "medium" },
          ],
        },
      },
    });
    const plans = (await store.list(A, 10)).filter((r) => r.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].payload).toEqual({
      entries: [
        { content: "read", status: "completed", priority: "high" },
        { content: "edit", status: "completed", priority: "medium" },
      ],
    });
  });

  it("ignores a plan_update that is a file or markdown plan", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "p2", content: "# steps" } as never,
      },
    });
    expect((await store.list(A, 10)).filter((r) => r.kind === "plan")).toEqual(
      []
    );
  });

  it("stores usage on the live turn row", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "usage_update",
        used: 12_000,
        size: 200_000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });
    const turn = (await store.list(A, 10)).find((r) => r.kind === "turn");
    expect(turn?.payload).toMatchObject({
      usage: {
        used: 12_000,
        size: 200_000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: { sessionUpdate: "usage_update", used: 13_000, size: 200_000 },
    });
    const again = (await store.list(A, 10)).find((r) => r.kind === "turn");
    expect(again?.payload).toMatchObject({
      usage: { used: 13_000, size: 200_000 },
    });
    expect(
      (again?.payload as { usage: Record<string, unknown> }).usage
    ).not.toHaveProperty("cost");
  });

  it("keeps the parent tool call id a nested call carries", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "task_1",
        title: "Task",
        kind: "other",
        status: "in_progress",
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "child_1",
        title: "Read",
        kind: "read",
        status: "pending",
        _meta: { claudeCode: { toolName: "Read", parentToolUseId: "task_1" } },
      },
    });
    await rec.handle({
      type: "update",
      agentId: A,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "child_1",
        status: "completed",
      },
    });
    const child = await store.getByKey(A, "tool_call", "child_1");
    expect(child?.payload).toMatchObject({
      parentToolCallId: "task_1",
      status: "completed",
    });
    const parent = await store.getByKey(A, "tool_call", "task_1");
    expect(parent?.payload).not.toHaveProperty("parentToolCallId");
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
      error: "the agent exited before the turn settled",
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

describe("StreamRecorder deliberate stops", () => {
  it("records a turn the stop tore down as stopped, not as the teardown's error", async () => {
    const rec = new StreamRecorder(store);
    const settled = vi.fn(async () => undefined);
    rec.setTurnBlocks({ started: async () => "blk_s", settled });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    rec.beginStop(A);
    // Closing the session fails the prompt in flight; the engine says so.
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: "Session closed",
      errorKind: "unknown",
    });
    expect(await rec.settleStopped(A)).toBe(0);
    const rows = (await store.list(A, 10)).reverse();
    expect(rows).toHaveLength(1); // no status row for the teardown's error
    expect(rows[0]!.payload).toMatchObject({
      state: "settled",
      error: "stopped",
    });
    expect(rows[0]!.payload).not.toHaveProperty("retry");
    expect(rows[0]!.payload).not.toHaveProperty("errorKind");
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("settles what the stopped host left open as stopped, and its block with it", async () => {
    const rec = new StreamRecorder(store);
    const settled = vi.fn(async () => undefined);
    rec.setTurnBlocks({ started: async () => "blk_t", settled });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    rec.beginStop(A);
    expect(await rec.settleStopped(A)).toBe(1);
    // The host's own settle, arriving after, writes nothing more.
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: "the agent exited before the turn settled",
    });
    await rec.handle({
      type: "exit",
      agentId: A,
      code: null,
      signal: "SIGTERM",
      stderrTail: "",
      expected: false,
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      state: "settled",
      error: "stopped",
    });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("settles a turn the exit cut during a stop as stopped", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    rec.beginStop(A);
    await rec.handle({
      type: "exit",
      agentId: A,
      code: null,
      signal: "SIGKILL",
      stderrTail: "",
      expected: false,
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      state: "settled",
      error: "stopped",
    });
  });

  it("a stop does not outlive the next turn: a later failure is a failure", async () => {
    const rec = new StreamRecorder(store);
    rec.beginStop(A);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    expect(rec.isStopping(A)).toBe(false);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: "overloaded",
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows[0]!.payload).toMatchObject({ error: "overloaded" });
  });
});

describe("turn blocks", () => {
  it("opens a block when a turn starts, keeps its id on the turn row, and settles it with the turn", async () => {
    const rec = new StreamRecorder(store);
    const started = vi.fn(async () => "blk_1");
    const settled = vi.fn(async () => undefined);
    rec.setTurnBlocks({ started, settled });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0]![0]).toMatchObject({
      agentId: A,
      prompt: { source: "system", text: "go" },
      turnRow: { kind: "turn" },
    });
    let rows = (await store.list(A, 10)).reverse();
    expect(rows[0]!.payload).toMatchObject({
      state: "started",
      blockId: "blk_1",
    });
    await rec.handle(chunk("hi"));
    await rec.handle({ type: "turn", agentId: A, state: "settled" });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0]).toMatchObject({
      agentId: A,
      turnRow: { kind: "turn", payload: { blockId: "blk_1" } },
    });
    rows = (await store.list(A, 10)).reverse();
    expect(rows[0]!.payload).toMatchObject({
      state: "settled",
      blockId: "blk_1",
    });
  });

  it("settles the block of a turn a restart cut, from reconcile", async () => {
    const rec = new StreamRecorder(store);
    rec.setTurnBlocks({
      started: async () => "blk_2",
      settled: async () => undefined,
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    const fresh = new StreamRecorder(store);
    const settled = vi.fn(async () => undefined);
    fresh.setTurnBlocks({ started: async () => null, settled });
    expect(await fresh.reconcile(A)).toBe(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0]).toMatchObject({
      agentId: A,
      turnRow: { payload: { blockId: "blk_2", state: "settled" } },
    });
  });

  it("records a turn with no block when nothing is attached", async () => {
    const rec = new StreamRecorder(store);
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    const rows = (await store.list(A, 10)).reverse();
    expect("blockId" in rows[0]!.payload).toBe(false);
  });
});
