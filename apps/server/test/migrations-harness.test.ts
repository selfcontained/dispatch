import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("harness migrations", () => {
  it("re-run their SQL against an existing schema without error (every statement is guarded)", async () => {
    // node-pg-migrate skips names already in pgmigrations, so a plain second
    // run executes nothing. Forgetting the two rows makes it execute both
    // files again on a database that already has their objects: the case an
    // install upgraded from the earlier harness migrations is in.
    await pool.query(
      `DELETE FROM pgmigrations WHERE name IN ('0051_agent-stream-events', '0052_agent-chat-messages-delivery-text')`
    );
    await expect(runTestMigrations()).resolves.not.toThrow();
    const rows = await pool.query<{ name: string }>(
      `SELECT name FROM pgmigrations WHERE name IN ('0051_agent-stream-events', '0052_agent-chat-messages-delivery-text') ORDER BY name`
    );
    expect(rows.rows.map((r) => r.name)).toEqual([
      "0051_agent-stream-events",
      "0052_agent-chat-messages-delivery-text",
    ]);
  });

  it("accept a plan row and a delivery_text column", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_mig', 'M', '/tmp', 'running')`
    );
    await expect(
      pool.query(
        `INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload)
         VALUES ('agt_mig', 1, 'plan', 'plan:1', '{"entries":[]}'::jsonb)`
      )
    ).resolves.toBeDefined();
    const column = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_chat_messages' AND column_name = 'delivery_text'`
    );
    expect(column.rowCount).toBe(1);
    const index = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'agent_stream_events_agent_created'`
    );
    expect(index.rowCount).toBe(1);
  });

  it("carries no migration named after the old dsh files", async () => {
    const rows = await pool.query<{ name: string }>(
      `SELECT name FROM pgmigrations WHERE name IN
        ('0052_agent-stream-events-turn', '0053_agent-chat-messages-delivery-text', '0054_agent-type-dispatch')`
    );
    expect(rows.rows).toEqual([]);
  });
});
