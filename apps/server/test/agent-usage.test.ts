import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { syncTurnUsage } from "../src/agents/usage-recorder.js";
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

let seq = 0;
/** A settled turn row as the recorder leaves it. */
async function turn(opts: {
  sessionId: string;
  model?: string;
  tokens?: { input: number; output: number; cacheRead?: number };
  usage?: Record<string, unknown>;
  at?: string;
}): Promise<void> {
  seq += 1;
  const payload = {
    state: "settled",
    prompt: { source: "system" },
    sessionId: opts.sessionId,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.tokens
      ? {
          tokens: {
            input: opts.tokens.input,
            output: opts.tokens.output,
            cacheRead: opts.tokens.cacheRead ?? 0,
            cacheWrite: 0,
          },
        }
      : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
  };
  await pool.query(
    `INSERT INTO agent_stream_events (agent_id, seq, kind, payload, created_at)
     VALUES ($1, $2, 'turn', $3, COALESCE($4::timestamptz, NOW()))`,
    [A, seq, JSON.stringify(payload), opts.at ?? null]
  );
}

const usageRows = async () =>
  (
    await pool.query(
      `SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens, message_count
         FROM agent_token_usage WHERE agent_id = $1 ORDER BY session_id, model`,
      [A]
    )
  ).rows;

describe("syncTurnUsage", () => {
  it("sums the newest turn's session and model from its turn rows", async () => {
    await turn({
      sessionId: "sess_1",
      model: "m1",
      tokens: { input: 100, output: 10, cacheRead: 50 },
    });
    await syncTurnUsage(pool, A);
    await turn({
      sessionId: "sess_1",
      model: "m1",
      tokens: { input: 200, output: 20 },
    });
    await syncTurnUsage(pool, A);
    expect(await usageRows()).toEqual([
      {
        session_id: "sess_1",
        model: "m1",
        input_tokens: 300,
        output_tokens: 30,
        cache_read_tokens: 50,
        message_count: 2,
      },
    ]);
  });

  it("counts a turn once however often its settle is replayed", async () => {
    await turn({
      sessionId: "sess_1",
      model: "m1",
      tokens: { input: 100, output: 10 },
    });
    await syncTurnUsage(pool, A);
    await syncTurnUsage(pool, A);
    await syncTurnUsage(pool, A);
    expect((await usageRows())[0]).toMatchObject({
      input_tokens: 100,
      message_count: 1,
    });
  });

  it("keeps a turn under the model it started on after a switch", async () => {
    // The turn started on m1; the agent was switched to m2 before it settled.
    await pool.query("UPDATE agents SET model = 'm2' WHERE id = $1", [A]);
    await turn({
      sessionId: "sess_1",
      model: "m1",
      tokens: { input: 100, output: 10 },
    });
    await syncTurnUsage(pool, A);
    await turn({
      sessionId: "sess_1",
      model: "m2",
      tokens: { input: 40, output: 4 },
    });
    await syncTurnUsage(pool, A);
    expect((await usageRows()).map((r) => [r.model, r.input_tokens])).toEqual([
      ["m1", 100],
      ["m2", 40],
    ]);
  });

  it("does nothing before any turn has reported tokens", async () => {
    await turn({ sessionId: "sess_1", model: "m1" });
    await syncTurnUsage(pool, A);
    expect(await usageRows()).toEqual([]);
  });
});

describe("loadAgentUsage", () => {
  const now = new Date("2026-09-24T12:00:00Z");

  it("reports the session's newest context and cost, and session and month tokens", async () => {
    // Late August, same session: counts for the session, not for September.
    await turn({
      sessionId: "sess_1",
      model: "m1",
      tokens: { input: 1000, output: 0 },
      at: "2026-08-31T23:00:00Z",
    });
    await syncTurnUsage(pool, A);
    await turn({
      sessionId: "sess_1",
      model: "m1",
      tokens: { input: 100, output: 10 },
      usage: { used: 1000, size: 200000 },
    });
    await syncTurnUsage(pool, A);
    await turn({
      sessionId: "sess_1",
      model: "m2",
      tokens: { input: 300, output: 30 },
      usage: {
        used: 5000,
        size: 200000,
        cost: { amount: 0.42, currency: "USD" },
      },
    });
    await syncTurnUsage(pool, A);

    const report = await loadAgentUsage(
      pool,
      { id: A, cliSessionId: "sess_1" },
      now
    );
    expect(report.context).toEqual({ used: 5000, size: 200000 });
    expect(report.sessionCost).toEqual({ amount: 0.42, currency: "USD" });
    expect(report.session.total).toBe(1440);
    expect(report.month).toEqual({
      input: 400,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      total: 440,
    });
    expect(report.byModel.map((m) => m.model)).toEqual(["m1", "m2"]);
  });

  it("does not carry an earlier session's context or cost into a new one", async () => {
    await turn({
      sessionId: "sess_old",
      model: "m1",
      tokens: { input: 5, output: 5 },
      usage: { used: 9000, size: 200000, cost: { amount: 1, currency: "USD" } },
    });
    await syncTurnUsage(pool, A);
    const report = await loadAgentUsage(
      pool,
      { id: A, cliSessionId: "sess_new" },
      now
    );
    expect(report.context).toBeNull();
    expect(report.sessionCost).toBeNull();
    expect(report.session.total).toBe(0);
    expect(report.month.total).toBe(10);
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
