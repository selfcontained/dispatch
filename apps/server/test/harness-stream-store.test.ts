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
  it("finds a message's turn whether it is open or already settled", async () => {
    // Between the cancel and the read, the turn has usually settled. A
    // lookup that only knew "the newest open turn" found nothing then.
    const settled = await store.append(A, "turn", {
      state: "settled",
      stopReason: "cancelled",
      prompt: { source: "chat", chatMessageId: "m-cut" },
    });
    await expect(store.turnAnchorForMessage(A, "m-cut")).resolves.toEqual({
      seq: settled.seq,
      nextSeq: null,
    });
  });

  it("bounds the turn at the one after it", async () => {
    // A queued prompt can open the next turn before the recall reads.
    const cut = await store.append(A, "turn", {
      state: "settled",
      prompt: { source: "chat", chatMessageId: "m-cut" },
    });
    await store.append(A, "assistant", { text: "partial", streaming: false });
    const next = await store.append(A, "turn", {
      state: "started",
      prompt: { source: "chat", chatMessageId: "m-next" },
    });
    await expect(store.turnAnchorForMessage(A, "m-cut")).resolves.toEqual({
      seq: cut.seq,
      nextSeq: next.seq,
    });
  });

  it("has no anchor for a message that never started a turn", async () => {
    await store.append(A, "turn", { state: "started", autonomous: true });
    await expect(store.turnAnchorForMessage(A, "nope")).resolves.toBeNull();
  });

  it("deletes only the turn's own rows", async () => {
    const keep = await store.append(A, "assistant", { text: "earlier" });
    const cut = await store.append(A, "turn", { state: "settled" });
    await store.append(A, "tool_call", { status: "failed" }, "call_1");
    await store.append(A, "assistant", { text: "partial", streaming: false });
    const next = await store.append(A, "turn", { state: "started" });
    const nextRow = await store.append(A, "assistant", { text: "new work" });

    await expect(store.deleteRange(A, cut.seq, next.seq)).resolves.toBe(3);
    const rows = await store.list(A, 20);
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([
      keep.seq,
      next.seq,
      nextRow.seq,
    ]);
  });

  it("deletes to the end when the turn is the newest", async () => {
    const keep = await store.append(A, "assistant", { text: "earlier" });
    const cut = await store.append(A, "turn", { state: "settled" });
    await store.append(A, "assistant", { text: "partial" });
    await expect(store.deleteRange(A, cut.seq, null)).resolves.toBe(2);
    expect((await store.list(A, 20)).map((r) => r.seq)).toEqual([keep.seq]);
  });
});

describe("tasks left active", () => {
  const plan = (statuses: string[]) => ({
    entries: statuses.map((status, i) => ({
      content: `task ${i}`,
      status,
      priority: "medium",
    })),
  });
  const statusesOf = async (key: string) =>
    (
      (await store.getByKey(A, "plan", key))?.payload as {
        entries: { content: string; status: string }[];
      }
    ).entries.map((e) => e.status);

  it("puts an active task back to pending when its turn ends, in order", async () => {
    const turn = await store.append(A, "turn", { state: "settled" });
    await store.upsertByKey(
      A,
      "plan",
      "plan:1",
      plan(["completed", "in_progress", "pending"])
    );
    await store.settleTurnLeftovers(A, turn.seq, "stopped before it finished");
    expect(await statusesOf("plan:1")).toEqual([
      "completed",
      "pending",
      "pending",
    ]);
    const entries = (
      (await store.getByKey(A, "plan", "plan:1"))?.payload as {
        entries: { content: string; priority: string }[];
      }
    ).entries;
    expect(entries.map((e) => e.content)).toEqual([
      "task 0",
      "task 1",
      "task 2",
    ]);
    expect(entries[1].priority).toBe("medium");
  });

  it("leaves an earlier turn's list alone", async () => {
    await store.upsertByKey(A, "plan", "plan:old", plan(["in_progress"]));
    const turn = await store.append(A, "turn", { state: "settled" });
    await store.settleTurnLeftovers(A, turn.seq, "stopped before it finished");
    expect(await statusesOf("plan:old")).toEqual(["in_progress"]);
  });

  it("puts every active task back to pending after a restart", async () => {
    await store.append(A, "turn", { state: "started" });
    await store.upsertByKey(
      A,
      "plan",
      "plan:1",
      plan(["in_progress", "pending"])
    );
    await store.settleInterrupted(A, "interrupted by restart");
    expect(await statusesOf("plan:1")).toEqual(["pending", "pending"]);
  });
});
