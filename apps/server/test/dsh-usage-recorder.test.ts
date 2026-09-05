import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { DriverEvent } from "../src/agents/dsh/driver.js";
import { UsageRecorder } from "../src/agents/dsh/usage-recorder.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const A = "agt_usage_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'U', '/tmp', 'running')`,
    [A]
  );
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_token_usage WHERE agent_id = $1", [A]);
});

const settled = (input: number, output: number): DriverEvent => ({
  type: "turn",
  agentId: A,
  state: "settled",
  stopReason: "end_turn",
  usage: {
    totalTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    thoughtTokens: 0,
    cachedReadTokens: 5,
    cachedWriteTokens: 1,
  },
});

describe("UsageRecorder", () => {
  it("upserts cumulative totals per agent, session, and model", async () => {
    const rec = new UsageRecorder(pool);
    const ctx = { sessionId: "sess_1", model: "openai/gpt-5.2" };
    await rec.handle(settled(100, 10), ctx);
    await rec.handle(settled(250, 40), ctx);
    const rows = await pool.query(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, message_count
         FROM agent_token_usage
        WHERE agent_id = $1 AND session_id = $2 AND model = $3`,
      [A, "sess_1", "openai/gpt-5.2"]
    );
    expect(rows.rows).toEqual([
      {
        input_tokens: 250,
        output_tokens: 40,
        cache_read_tokens: 5,
        cache_creation_tokens: 1,
        message_count: 2,
      },
    ]);
  });

  it("ignores turns without usage and non-turn events", async () => {
    const rec = new UsageRecorder(pool);
    const ctx = { sessionId: "s", model: "m" };
    await rec.handle(
      { type: "turn", agentId: A, state: "started", text: "x" },
      ctx
    );
    await rec.handle(
      { type: "turn", agentId: A, state: "settled", stopReason: "end_turn" },
      ctx
    );
    await rec.handle(
      {
        type: "update",
        agentId: A,
        update: { sessionUpdate: "usage_update", used: 10, size: 100 },
      },
      ctx
    );
    const rows = await pool.query(
      `SELECT 1 FROM agent_token_usage WHERE agent_id = $1`,
      [A]
    );
    expect(rows.rowCount).toBe(0);
  });
});
