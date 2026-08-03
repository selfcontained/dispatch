import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();
let authToken: string;

beforeEach(async () => {
  if (!authToken) {
    const result = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    authToken = result.rows[0]!.value;
  }
  await ctx.pool.query(
    "DELETE FROM settings WHERE key = 'active_personality_id'"
  );
  await ctx.pool.query("DELETE FROM personalities");
  await ctx.pool.query("DELETE FROM agents");
});

async function mcpToolsList(agentId: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/mcp/${agentId}`,
    headers: {
      authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, agentId)}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
}

async function mcpToolCall(
  agentId: string,
  name: string,
  args: Record<string, unknown>
) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/mcp/${agentId}`,
    headers: {
      authorization: `Bearer ${ctx.auth.createAgentMcpToken(authToken, agentId)}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

function parseToolResult(body: string): Record<string, unknown> {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const json = JSON.parse(line.slice(6));
    if (json.result?.structuredContent) return json.result.structuredContent;
  }
  throw new Error("No MCP structured result found.");
}

describe("MCP personality tools", () => {
  const agentId = "agt_personality_tools";
  const toolNames = [
    "list_personalities",
    "create_personality",
    "update_personality",
    "delete_personality",
    "set_active_personality",
    "clear_active_personality",
  ];

  beforeEach(async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, full_access)
       VALUES ($1, 'personality-tools', 'claude', 'running', '/tmp', false)`,
      [agentId]
    );
  });

  it("exposes personality tools to standard agents, not review agents", async () => {
    const standardResponse = await mcpToolsList(agentId);
    expect(standardResponse.statusCode).toBe(200);
    for (const name of toolNames) expect(standardResponse.body).toContain(name);

    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, role, status, cwd, persona, parent_agent_id, full_access)
       VALUES ('agt_personality_review', 'reviewer', 'claude', 'review', 'running', '/tmp', 'security-review', $1, false)`,
      [agentId]
    );
    const reviewResponse = await mcpToolsList("agt_personality_review");
    expect(reviewResponse.statusCode).toBe(200);
    for (const name of toolNames) {
      expect(reviewResponse.body).not.toContain(`\"${name}\"`);
    }

    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd, full_access)
       VALUES ('agt_personality_job', 'job', 'claude', 'running', '/tmp', false)`
    );
    await ctx.pool.query(
      `INSERT INTO jobs (id, directory, name, enabled, agent_type, use_worktree, full_access, schedule, timeout_ms, needs_input_timeout_ms, auto_archive)
       VALUES ('job_personality_tools', '/tmp', 'Personality Job', false, 'claude', false, false, null, 1800000, 1800000, true)`
    );
    await ctx.pool.query(
      `INSERT INTO job_runs (id, job_id, status, started_at, status_updated_at, agent_id)
       VALUES ('run_personality_tools', 'job_personality_tools', 'running', NOW(), NOW(), 'agt_personality_job')`
    );
    const jobResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/mcp/jobs/run_personality_tools/agt_personality_job",
      headers: {
        authorization: `Bearer ${ctx.auth.createJobMcpToken(authToken, "run_personality_tools", "agt_personality_job")}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(jobResponse.statusCode).toBe(200);
    for (const name of toolNames) {
      expect(jobResponse.body).not.toContain(`\"${name}\"`);
    }
  });

  it("creates, updates, activates, clears, and deletes a personality", async () => {
    const created = parseToolResult(
      (
        await mcpToolCall(agentId, "create_personality", {
          name: "Focused engineer",
          prompt: "Be concise and verify every implementation detail.",
        })
      ).body
    ).personality as { id: string; name: string; prompt: string };
    expect(created).toMatchObject({ name: "Focused engineer" });

    const updated = parseToolResult(
      (
        await mcpToolCall(agentId, "update_personality", {
          id: created.id,
          name: "Focused builder",
          prompt: "Be concise, practical, and verify details.",
        })
      ).body
    ).personality as { name: string; prompt: string };
    expect(updated).toMatchObject({
      name: "Focused builder",
      prompt: "Be concise, practical, and verify details.",
    });

    expect(
      parseToolResult(
        (
          await mcpToolCall(agentId, "set_active_personality", {
            id: created.id,
          })
        ).body
      )
    ).toEqual({ activeId: created.id });

    const listed = parseToolResult(
      (await mcpToolCall(agentId, "list_personalities", {})).body
    ) as { activeId: string | null; personalities: Array<{ id: string }> };
    expect(listed.activeId).toBe(created.id);
    expect(listed.personalities).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })])
    );

    expect(
      parseToolResult(
        (await mcpToolCall(agentId, "clear_active_personality", {})).body
      )
    ).toEqual({ activeId: null });

    expect(
      parseToolResult(
        (await mcpToolCall(agentId, "delete_personality", { id: created.id }))
          .body
      )
    ).toEqual({ id: created.id, deleted: true });
  });

  it("returns a stable duplicate-name error", async () => {
    await mcpToolCall(agentId, "create_personality", {
      name: "Duplicate",
      prompt: "First prompt",
    });
    const duplicate = await mcpToolCall(agentId, "create_personality", {
      name: "Duplicate",
      prompt: "Second prompt",
    });
    expect(duplicate.body).toContain(
      "A personality with that name already exists."
    );
    expect(duplicate.body).not.toContain("personalities_name_key");
  });
});
