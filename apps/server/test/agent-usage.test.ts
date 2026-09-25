import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { recordTurnUsage } from "../src/agents/usage-recorder.js";
import {
  loadAgentUsage,
  toAgentConfigOptions,
} from "../src/agents/usage-report.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const A = "agt_usage_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, cli_session_id) VALUES ($1, 'Usage A', '/tmp', 'running', 'sess_1')`,
    [A]
  );
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM agent_stream_events");
});

const usage = (input: number, output: number, cacheRead = 0) => ({
  totalTokens: input + output + cacheRead,
  inputTokens: input,
  outputTokens: output,
  cachedReadTokens: cacheRead,
  cachedWriteTokens: 0,
});

describe("recordTurnUsage", () => {
  it("adds each turn to the session's row for its model", async () => {
    const base = { agentId: A, sessionId: "sess_1", model: "m1" };
    await recordTurnUsage(pool, { ...base, usage: usage(100, 10, 50) });
    await recordTurnUsage(pool, { ...base, usage: usage(200, 20) });
    const { rows } = await pool.query(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens, message_count
         FROM agent_token_usage WHERE agent_id = $1`,
      [A]
    );
    expect(rows).toEqual([
      {
        model: "m1",
        input_tokens: 300,
        output_tokens: 30,
        cache_read_tokens: 50,
        message_count: 2,
      },
    ]);
  });

  it("gives a model switched to mid-session a row of its own", async () => {
    const base = { agentId: A, sessionId: "sess_1" };
    await recordTurnUsage(pool, {
      ...base,
      model: "m1",
      usage: usage(100, 10),
    });
    await recordTurnUsage(pool, { ...base, model: "m2", usage: usage(40, 4) });
    const { rows } = await pool.query(
      `SELECT model, input_tokens FROM agent_token_usage WHERE agent_id = $1 ORDER BY model`,
      [A]
    );
    expect(rows).toEqual([
      { model: "m1", input_tokens: 100 },
      { model: "m2", input_tokens: 40 },
    ]);
  });

  it("writes nothing for a turn that used nothing", async () => {
    await recordTurnUsage(pool, {
      agentId: A,
      sessionId: "sess_1",
      model: "m1",
      usage: usage(0, 0),
    });
    const { rowCount } = await pool.query("SELECT 1 FROM agent_token_usage");
    expect(rowCount).toBe(0);
  });
});

describe("loadAgentUsage", () => {
  it("reports the newest context and cost, and session and month tokens", async () => {
    const base = { agentId: A, sessionId: "sess_1" };
    await recordTurnUsage(pool, {
      ...base,
      model: "m1",
      usage: usage(100, 10),
    });
    await recordTurnUsage(pool, {
      ...base,
      model: "m2",
      usage: usage(300, 30),
    });
    // An earlier session this month counts for the month, not the session.
    await recordTurnUsage(pool, {
      agentId: A,
      sessionId: "sess_0",
      model: "m1",
      usage: usage(5, 5),
    });
    await pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload) VALUES
         ($1, 1, 'turn', '{"usage":{"used":1000,"size":200000}}'),
         ($1, 2, 'turn', '{"usage":{"used":5000,"size":200000,"cost":{"amount":0.42,"currency":"USD"}}}'),
         ($1, 3, 'turn', '{"state":"started"}')`,
      [A]
    );

    const report = await loadAgentUsage(pool, {
      id: A,
      cliSessionId: "sess_1",
    });
    expect(report.context).toEqual({ used: 5000, size: 200000 });
    expect(report.sessionCost).toEqual({ amount: 0.42, currency: "USD" });
    expect(report.session).toEqual({
      input: 400,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      total: 440,
    });
    expect(report.month.total).toBe(450);
    expect(report.byModel.map((m) => m.model)).toEqual(["m2", "m1"]);
  });

  it("is empty for an agent that has reported nothing", async () => {
    const report = await loadAgentUsage(pool, { id: A, cliSessionId: null });
    expect(report.context).toBeNull();
    expect(report.sessionCost).toBeNull();
    expect(report.session.total).toBe(0);
    expect(report.byModel).toEqual([]);
  });
});

describe("toAgentConfigOptions", () => {
  it("flattens grouped choices and keeps only selects", () => {
    const options = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-6-sol",
        options: [
          {
            group: "gpt",
            name: "GPT",
            options: [{ value: "gpt-6-sol", name: "6 Sol" }],
          },
          { value: "other", name: "Other", description: "Another one" },
        ],
      },
      {
        id: "fast",
        name: "Fast",
        type: "boolean",
        currentValue: false,
      },
    ] as unknown as SessionConfigOption[];
    expect(toAgentConfigOptions(options)).toEqual([
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-6-sol",
        choices: [
          { value: "gpt-6-sol", name: "6 Sol", group: "GPT" },
          { value: "other", name: "Other", description: "Another one" },
        ],
      },
    ]);
  });
});
