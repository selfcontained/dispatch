import { StreamStore } from "../src/agents/acp/stream-store.js";
import { loadTurnEntries, groupTurnRows } from "../src/chat/turns.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";
import {
  AttentionHistory,
  listAttentionHistory,
} from "../src/notifications/attention-history.js";
let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM agent_stream_events");
  for (const id of ["one", "two", "three", "four", "old"])
    await pool.query(
      "INSERT INTO agents(id,name,cwd,status) VALUES($1,$1,'/tmp','running') ON CONFLICT DO NOTHING",
      [id]
    );
});
const logger = { warn: vi.fn() };
async function block(
  kind: string,
  agent: string,
  age: number,
  state: unknown = null,
  to: string | null = null
) {
  await pool.query(
    "INSERT INTO agents(id,name,cwd,status) VALUES($1,$1,'/tmp','running') ON CONFLICT DO NOTHING",
    [agent]
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blocks(id,stream_id,author_kind,author_agent_id,to_agent_id,kind,text,state,created_at)
 VALUES($1,$2,'agent',$2,$3,$4,'Choose a direction',$5,now()-$6*interval '1 day')`,
    [id, agent, to, kind, state, age]
  );
  return id;
}
it("includes all four kinds across agents, marks answers/settlements and excludes old or agent-directed inputs", async () => {
  const history = new AttentionHistory(pool, logger);
  await block("question", "one", 1, { answer: { value: "yes" } });
  await block("form", "two", 2, { submission: {} });
  await block("question", "one", 8);
  await block("question", "one", 0, null, "another-agent");
  history.permissions("three", [{ id: "p1", title: "Write file" }]);
  history.permissions("three", []);
  history.blocked("four", "Build failed");
  await history.idle();
  const items = await listAttentionHistory(pool);
  expect(items.map((i) => i.kind)).toEqual([
    "blocked",
    "approval",
    "question",
    "form",
  ]);
  expect(items.map((i) => i.settled)).toEqual([false, true, true, true]);
  expect(items[2].target?.streamId).toBe("one");
  history.settleBlocked("four");
  await history.idle();
  expect((await listAttentionHistory(pool))[0].settled).toBe(true);
});
it("deduplicates snapshots even across recorder instances and settles cleared requests in order", async () => {
  const history = new AttentionHistory(pool, logger);
  history.permissions("one", [{ id: "p", title: "Run command" }]);
  history.permissions("one", [{ id: "p", title: "Run command" }]);
  history.permissions("one", []);
  await history.idle();
  const restarted = new AttentionHistory(pool, logger);
  restarted.permissions("one", []);
  await restarted.idle();
  expect(await listAttentionHistory(pool)).toHaveLength(1);
  expect((await listAttentionHistory(pool))[0].settled).toBe(true);
});
it("enforces the seven-day window for events and the combined fifty-item cap", async () => {
  const history = new AttentionHistory(pool, logger);
  history.blocked("old", "Expired");
  await history.idle();
  await pool.query(
    "UPDATE agent_stream_events SET created_at=now()-interval '8 days'"
  );
  for (let i = 0; i < 55; i++) await block("question", `agent-${i}`, i / 100);
  const items = await listAttentionHistory(pool);
  expect(items).toHaveLength(50);
  expect(items[0].agentId).toBe("agent-0");
  expect(items[49].agentId).toBe("agent-49");
});
it("returns immediately and logs write failures without preventing later snapshots", async () => {
  const query = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ rows: [] });
  const warn = vi.fn();
  const history = new AttentionHistory({ query } as unknown as Pool, { warn });
  expect(history.permissions("one", [])).toBeUndefined();
  await history.idle();
  expect(warn).toHaveBeenCalledOnce();
  history.permissions("one", []);
  await history.idle();
  expect(query).toHaveBeenCalledTimes(2);
});

it("keeps source attention out of engine turn ranges and live feed assembly", async () => {
  const history = new AttentionHistory(pool, logger);
  const store = new StreamStore(pool);
  history.permissions("one", [{ id: "before", title: "Before turn" }]);
  await history.idle();
  const turn = await store.append("one", "turn", {
    state: "started",
    prompt: { source: "system", text: "Work" },
  });
  expect(turn.seq).toBe(1);
  await store.append("one", "assistant", {
    text: "Visible output",
    streaming: false,
  });
  const before = await loadTurnEntries(pool, "one", [turn.id]);
  history.blocked("one", "Hidden source record");
  await history.idle();
  expect(await loadTurnEntries(pool, "one", [turn.id])).toEqual(before);
  const attention = (await store.list("one", 20)).filter(
    (r) => r.kind === "attention"
  );
  expect(attention.every((r) => r.seq < 0)).toBe(true);
  expect(groupTurnRows(attention)).toEqual([]);
});

it("uses the toast fallback for blank form and question text", async () => {
  const question = await block("question", "one", 0);
  const form = await block("form", "two", 0);
  await pool.query("UPDATE blocks SET text='',data=$2 WHERE id=$1", [
    question,
    JSON.stringify({ options: [{ label: "First" }, { label: "Second" }] }),
  ]);
  await pool.query("UPDATE blocks SET text='',data=$2 WHERE id=$1", [
    form,
    JSON.stringify({ title: "Release settings" }),
  ]);
  expect((await listAttentionHistory(pool)).map((i) => i.message)).toEqual([
    "Release settings",
    "First / Second",
  ]);
});

it("hides all archived agent kinds without deleting history", async () => {
  const history = new AttentionHistory(pool, logger);
  for (const agent of ["one", "two"]) {
    await block("question", agent, 0);
    await block("form", agent, 0);
    history.permissions(agent, [{ id: "approval", title: "Run command" }]);
    history.blocked(agent, "Needs help");
  }
  await history.idle();
  await pool.query("UPDATE agents SET deleted_at=now() WHERE id='two'");
  try {
    const items = await listAttentionHistory(pool);
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.agentId === "one")).toBe(true);
    expect(items.map((item) => item.kind).sort()).toEqual(
      ["question", "form", "approval", "blocked"].sort()
    );
    await pool.query("UPDATE agents SET deleted_at=NULL WHERE id='two'");
    expect(await listAttentionHistory(pool)).toHaveLength(8);
  } finally {
    await pool.query("UPDATE agents SET deleted_at=NULL WHERE id='two'");
  }
});
