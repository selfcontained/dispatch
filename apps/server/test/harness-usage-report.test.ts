import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  loadAgentUsage,
  loadUsageReport,
  monthStartUtc,
} from "../src/agents/harness/usage.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const NOW = new Date(Date.UTC(2026, 8, 7, 12, 0, 0));

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_stream_events");
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM agents");
});

async function agent(id: string, name: string, model: string | null) {
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, type, model) VALUES ($1, $2, '/tmp', 'running', 'dispatch', $3)`,
    [id, name, model]
  );
}

async function tokens(
  agentId: string,
  session: string,
  input: number,
  output: number,
  at: Date
) {
  await pool.query(
    `INSERT INTO agent_token_usage (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, message_count, session_start, session_end)
     VALUES ($1, $2, 'm', $3, 0, 0, $4, 1, $5, $5)`,
    [agentId, session, input, output, at]
  );
}

async function turn(agentId: string, seq: number, usage: unknown, at: Date) {
  await pool.query(
    `INSERT INTO agent_stream_events (agent_id, seq, kind, payload, created_at, updated_at)
     VALUES ($1, $2, 'turn', $3::jsonb, $4, $4)`,
    [
      agentId,
      seq,
      JSON.stringify({
        state: "settled",
        prompt: { source: "system", text: "x" },
        usage,
      }),
      at,
    ]
  );
}

describe("monthStartUtc", () => {
  it("is midnight UTC on the first", () => {
    expect(monthStartUtc(NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("loadUsageReport", () => {
  it("groups agents by engine with tokens from agent_token_usage and the newest cost from turn rows", async () => {
    await agent("agt_a", "A", "claude/default");
    await agent("agt_b", "B", "codex/gpt-5.6-sol");
    await agent("agt_c", "C", "gemini/default");
    await tokens("agt_a", "s1", 1000, 200, NOW);
    await tokens("agt_a", "s0", 1000, 200, new Date(Date.UTC(2026, 7, 30))); // last month, ignored
    await tokens("agt_b", "s2", 50, 5, NOW);
    await turn(
      "agt_a",
      1,
      { used: 100, size: 1000, cost: { amount: 0.1, currency: "USD" } },
      NOW
    );
    await turn(
      "agt_a",
      2,
      { used: 200, size: 1000, cost: { amount: 0.35, currency: "USD" } },
      NOW
    );
    await turn("agt_b", 1, { used: 200, size: 1000 }, NOW);
    const report = await loadUsageReport(pool, { claude: 20 }, NOW);
    expect(report.monthStart).toBe("2026-09-01T00:00:00.000Z");
    const by = Object.fromEntries(report.engines.map((e) => [e.id, e]));
    expect(by.claude).toMatchObject({
      tokens: 1200,
      costUsd: 0.35,
      budgetUsd: 20,
      agents: [{ agentId: "agt_a", name: "A", tokens: 1200, costUsd: 0.35 }],
    });
    expect(by.codex).toMatchObject({
      tokens: 55,
      costUsd: null,
      budgetUsd: null,
      agents: [{ agentId: "agt_b", name: "B", tokens: 55, costUsd: null }],
    });
    expect(by.gemini).toMatchObject({
      tokens: 0,
      costUsd: null,
      agents: [{ agentId: "agt_c", tokens: 0, costUsd: null }],
    });
    expect(by.opencode).toMatchObject({ tokens: 0, costUsd: null, agents: [] });
  });

  it("counts an agent with no model stored under the default engine", async () => {
    // The default create path stores the default harness model now, but rows
    // written before that still carry no model, and the child runs the
    // default engine either way.
    await agent("agt_d", "D", null);
    await tokens("agt_d", "s1", 40, 2, NOW);
    const report = await loadUsageReport(pool, {}, NOW);
    const by = Object.fromEntries(report.engines.map((e) => [e.id, e]));
    expect(by.claude).toMatchObject({
      tokens: 42,
      agents: [{ agentId: "agt_d", name: "D", tokens: 42 }],
    });
  });

  it("reports no cost for a cost the engine gave in another currency", async () => {
    await agent("agt_e", "E", "opencode/default");
    await turn(
      "agt_e",
      1,
      { used: 1, size: 2, cost: { amount: 4.5, currency: "EUR" } },
      NOW
    );
    const report = await loadUsageReport(pool, { opencode: 10 }, NOW);
    const opencode = report.engines.find((e) => e.id === "opencode");
    expect(opencode?.costUsd).toBeNull();
    expect(opencode?.agents).toEqual([
      { agentId: "agt_e", name: "E", tokens: 0, costUsd: null },
    ]);
    expect(await loadAgentUsage(pool, "agt_e", NOW)).toMatchObject({
      costUsd: null,
    });
  });

  it("ignores non-harness agents and agents with an unknown engine", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, type, model) VALUES ('agt_t', 'T', '/tmp', 'running', 'claude', 'opus')`
    );
    await agent("agt_u", "U", "unknown/x");
    const report = await loadUsageReport(pool, {}, NOW);
    expect(report.engines.flatMap((e) => e.agents)).toEqual([]);
  });
});

describe("loadAgentUsage", () => {
  it("returns one agent's month, or null for an unknown agent", async () => {
    await agent("agt_a", "A", "opencode/default");
    await tokens("agt_a", "s1", 10, 1, NOW);
    await turn(
      "agt_a",
      1,
      { used: 1, size: 2, cost: { amount: 1.25, currency: "USD" } },
      NOW
    );
    expect(await loadAgentUsage(pool, "agt_a", NOW)).toEqual({
      agentId: "agt_a",
      name: "A",
      tokens: 11,
      costUsd: 1.25,
    });
    expect(await loadAgentUsage(pool, "agt_nope", NOW)).toBeNull();
  });
});
