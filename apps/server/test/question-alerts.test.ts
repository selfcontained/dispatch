import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { setupTestDb, runTestMigrations, teardownTestDb } from "./db/setup.js";
import { QuestionAlerts } from "../src/notifications/question-alerts.js";
let pool: Pool;
beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(teardownTestDb);
beforeEach(async () => {
  await pool.query("DELETE FROM question_notifications");
  await pool.query("DELETE FROM blocks");
});
async function question(
  age: number,
  state: unknown = null,
  recipient: string | null = null
) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO blocks(id,stream_id,author_kind,author_agent_id,to_agent_id,kind,text,state,created_at)
    VALUES($1,'agt_stopped','agent','agt_stopped',$2,'question','Which option?',$3,now()-($4*interval '1 minute'))`,
    [id, recipient, state ? JSON.stringify(state) : null, age]
  );
  return id;
}
it("waits five minutes, ignores passive read state, and survives scanner restart without duplicate delivery", async () => {
  const id = await question(4);
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).not.toHaveBeenCalled();
  await pool.query(
    "UPDATE blocks SET created_at=now()-interval '6 minutes',read_at=now() WHERE id=$1",
    [id]
  );
  await pool.query(
    "UPDATE question_notifications SET next_attempt_at=now(),due_at=now() WHERE block_id=$1",
    [id]
  );
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({
    agent_id: "agt_stopped",
    block_id: id,
  });
});
it("cancels answered questions and does not alert agent-directed inputs", async () => {
  await question(6, { answer: { value: "done" } });
  await question(6, null, "agt_parent");
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).not.toHaveBeenCalled();
});
it("retries a failed delivery after persisted backoff and recovers expired leases", async () => {
  const id = await question(6);
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(1);
  await pool.query(
    "UPDATE question_notifications SET next_attempt_at=now(),lease_until=now()-interval '1 second' WHERE block_id=$1",
    [id]
  );
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    (
      await pool.query(
        "SELECT sent_at FROM question_notifications WHERE block_id=$1",
        [id]
      )
    ).rows[0].sent_at
  ).toBeTruthy();
});
it("concurrent scanners claim an input once", async () => {
  await question(6);
  const send = vi.fn(async () => true);
  await Promise.all([
    new QuestionAlerts(pool, send, async () => ({
      generation: "test",
      enabledAt: "2000-01-01T00:00:00Z",
    })).tick(),
    new QuestionAlerts(pool, send, async () => ({
      generation: "test",
      enabledAt: "2000-01-01T00:00:00Z",
    })).tick(),
  ]);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not enroll old questions or accumulate attempts while disabled", async () => {
  await question(6);
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => null).tick();
  expect(
    (await pool.query("SELECT * FROM question_notifications")).rowCount
  ).toBe(0);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "new",
    enabledAt: new Date().toISOString(),
  })).tick();
  expect(send).not.toHaveBeenCalled();
  expect(
    (await pool.query("SELECT * FROM question_notifications")).rowCount
  ).toBe(0);
});

it("alerts failed-parent questions that surfaced to the human", async () => {
  const id = await question(6, null, "agt_parent");
  await pool.query(
    "UPDATE blocks SET data='{\"parentHandled\":true}',delivered=false WHERE id=$1",
    [id]
  );
  const send = vi.fn(async () => true);
  await new QuestionAlerts(pool, send, async () => ({
    generation: "test",
    enabledAt: "2000-01-01T00:00:00Z",
  })).tick();
  expect(send).toHaveBeenCalledTimes(1);
});
