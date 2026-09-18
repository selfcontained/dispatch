import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { StreamStore } from "../src/agents/harness/stream-store.js";
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

  it("reads a keyed row without touching it", async () => {
    await store.upsertByKey(A, "tool_call", "call_2", { status: "pending" });
    const row = await store.getByKey(A, "tool_call", "call_2");
    expect(row?.payload).toEqual({ status: "pending" });
    expect(await store.getByKey(A, "tool_call", "missing")).toBeNull();
  });

  it("updates a payload in place", async () => {
    const row = await store.append(A, "assistant", { text: "a" });
    await store.updatePayload(row.id, { text: "ab" });
    const rows = await store.list(A, 1);
    expect(rows[0].id).toBe(row.id);
    expect(rows[0].payload).toEqual({ text: "ab" });
  });

  it("lists newest first, bounded by limit", async () => {
    for (let i = 0; i < 5; i++) await store.append(A, "status", { i });
    const rows = await store.list(A, 3);
    expect(rows.map((r) => r.payload.i)).toEqual([4, 3, 2]);
  });

  it("cascades with the agent", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_stream_gone', 'Gone', '/tmp', 'running')`
    );
    await store.append("agt_stream_gone", "status", { message: "bye" });
    await pool.query(`DELETE FROM agents WHERE id = 'agt_stream_gone'`);
    const rows = await store.list("agt_stream_gone", 10);
    expect(rows).toEqual([]);
  });
});

describe("settleInterrupted", () => {
  it("settles the open turn and stops streaming text", async () => {
    await store.append(A, "turn", { state: "started" });
    await store.append(A, "assistant", { text: "partial", streaming: true });
    const turns = await store.settleInterrupted(A, "interrupted by restart");
    expect(turns).toBe(1);
    const rows = await store.list(A, 10);
    const turn = rows.find((r) => r.kind === "turn")!;
    expect(turn.payload).toMatchObject({
      state: "settled",
      error: "interrupted by restart",
    });
    expect(rows.find((r) => r.kind === "assistant")!.payload).toMatchObject({
      streaming: false,
    });
  });

  it("settles tool calls the cut left open, so they stop spinning", async () => {
    // A restart kills the engine mid-call. Left alone these rows keep
    // `pending`/`in_progress`, which the feed projects as a step that runs
    // for ever — and the side effects may well have landed.
    await store.upsertByKey(A, "tool_call", "call_pending", {
      status: "pending",
      title: "cp a b",
    });
    await store.upsertByKey(A, "tool_call", "call_running", {
      status: "in_progress",
      title: "systemctl restart",
    });
    await store.upsertByKey(A, "tool_call", "call_done", {
      status: "completed",
      title: "read file",
    });

    await store.settleInterrupted(A, "interrupted by restart");

    const byTitle = new Map(
      (await store.list(A, 10))
        .filter((r) => r.kind === "tool_call")
        .map((r) => [
          (r.payload as { title?: string }).title,
          r.payload as { status?: string; error?: string },
        ])
    );
    expect(byTitle.get("cp a b")).toMatchObject({
      status: "failed",
      error: "interrupted by restart",
    });
    expect(byTitle.get("systemctl restart")).toMatchObject({
      status: "failed",
    });
    // A call that had already finished keeps its result.
    expect(byTitle.get("read file")).toMatchObject({ status: "completed" });
  });
});

describe("recall", () => {
  it("finds the open turn's anchor and its prompt message", async () => {
    await store.append(A, "turn", {
      state: "settled",
      prompt: { source: "chat", chatMessageId: "old" },
    });
    const open = await store.append(A, "turn", {
      state: "started",
      prompt: { source: "chat", chatMessageId: "m-live" },
    });
    await store.append(A, "assistant", { text: "working", streaming: true });

    await expect(store.openTurnAnchor(A)).resolves.toEqual({
      seq: open.seq,
      chatMessageId: "m-live",
    });
  });

  it("has no anchor once the newest turn has settled", async () => {
    await store.append(A, "turn", {
      state: "settled",
      prompt: { source: "chat", chatMessageId: "m" },
    });
    await expect(store.openTurnAnchor(A)).resolves.toBeNull();
  });

  it("reports a null prompt for a turn Dispatch did not prompt", async () => {
    await store.append(A, "turn", { state: "started", autonomous: true });
    const anchor = await store.openTurnAnchor(A);
    expect(anchor?.chatMessageId).toBeNull();
  });

  it("deletes the turn's rows and leaves everything before it", async () => {
    const keep = await store.append(A, "assistant", { text: "earlier" });
    const open = await store.append(A, "turn", { state: "started" });
    await store.append(A, "tool_call", { status: "pending" }, "call_1");
    await store.append(A, "assistant", { text: "partial", streaming: true });

    await expect(store.deleteFrom(A, open.seq)).resolves.toBe(3);
    const rows = await store.list(A, 20);
    expect(rows.map((r) => r.seq)).toEqual([keep.seq]);
  });
});
