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
