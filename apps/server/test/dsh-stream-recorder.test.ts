import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { DriverEvent } from "../src/agents/dsh/driver.js";
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
    await rec.handle({ type: "turn", agentId: A, state: "started" });
    await rec.handle(chunk("Hel"));
    await rec.handle(chunk("lo"));
    const open = await store.list(A, 10);
    expect(open[0].payload).toEqual({ text: "Hello", streaming: true });
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
    const rows = (await store.list(A, 10)).reverse();
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
    });
    await rec.handle({
      type: "exit",
      agentId: A,
      code: 0,
      signal: null,
      stderrTail: "",
    });
    const rows = (await store.list(A, 10)).reverse();
    expect(rows.map((r) => r.payload.message)).toEqual([
      "no API key",
      "dsh exited with code 1: boom",
    ]);
  });
});
