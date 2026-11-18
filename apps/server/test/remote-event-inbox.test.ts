import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { RemoteEventInbox } from "../src/agents/remote/event-inbox.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const agentId = "agt_remote_receipt";
const journalId = "first journal";
const event = {
  type: "turn",
  agentId,
  state: "settled",
  stopReason: "end_turn",
} as const;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    "INSERT INTO agents (id, name, cwd, status, host_journal_id) VALUES ($1, 'Receipt', 'runner://a/proof', 'running', $2)",
    [agentId, journalId]
  );
});
afterAll(teardownTestDb);

it("recovers the last contiguous committed payload across service restart", async () => {
  const first = new RemoteEventInbox(pool);
  const input = { journalId, seq: 1, event };
  await expect(first.receive(agentId, { ...input, seq: 2 })).rejects.toThrow();
  await expect(
    first.receive(agentId, { ...input, journalId: "replaced" })
  ).rejects.toThrow();
  await first.receive(agentId, input);
  // Lost SQL reply after commit. Same receipt is idempotent, a newer event
  // cannot overwrite the pending payload.
  await first.receive(agentId, input);
  await expect(first.receive(agentId, { ...input, seq: 2 })).rejects.toThrow();
  const restarted = new RemoteEventInbox(pool);
  const project = vi.fn(async () => {});
  await restarted.recover(agentId, project);
  await restarted.recover(agentId, project);
  expect(project).toHaveBeenCalledExactlyOnceWith(event);
  await restarted.receive(agentId, { ...input, seq: 2 });
  expect(
    (await pool.query("SELECT host_seq FROM agents WHERE id=$1", [agentId]))
      .rows[0].host_seq
  ).toBe(2);
});
