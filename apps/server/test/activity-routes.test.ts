import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string,
  opts?: { payload?: unknown }
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  const headers: Record<string, string> = { cookie };
  if (opts?.payload !== undefined) {
    headers["content-type"] = "application/json";
  }
  return ctx.app.inject({
    method: method as "GET" | "POST",
    url,
    headers,
    ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

async function createAgent(
  overrides: {
    name?: string;
    cwd?: string;
    deletedAt?: string | null;
    parentAgentId?: string | null;
    gitContext?: Record<string, unknown> | null;
  } = {}
): Promise<string> {
  const res = await authedInject("POST", "/api/v1/agents", {
    payload: {
      cwd: "/tmp",
      useWorktree: false,
      name: overrides.name ?? "test-agent",
    },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().agent.id;

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (overrides.cwd) {
    params.push(overrides.cwd);
    updates.push(`cwd = $${paramIdx++}`);
  }
  if (overrides.deletedAt !== undefined) {
    params.push(overrides.deletedAt);
    updates.push(`deleted_at = $${paramIdx++}`);
  }
  if (overrides.parentAgentId !== undefined) {
    params.push(overrides.parentAgentId);
    updates.push(`parent_agent_id = $${paramIdx++}`);
  }
  if (overrides.gitContext !== undefined) {
    params.push(JSON.stringify(overrides.gitContext));
    updates.push(`git_context = $${paramIdx++}::jsonb`);
  }
  if (updates.length > 0) {
    params.push(id);
    await ctx.pool.query(
      `UPDATE agents SET ${updates.join(", ")} WHERE id = $${paramIdx}`,
      params
    );
  }
  return id;
}

async function seedEvent(
  agentId: string,
  eventType: string,
  createdAt: string,
  message = "test"
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO agent_events (agent_id, event_type, message, created_at)
     VALUES ($1, $2, $3, $4)`,
    [agentId, eventType, message, createdAt]
  );
}

async function waitForAgentEvent(
  agentId: string,
  eventType: string,
  message: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await ctx.pool.query<{ day: string }>(
      `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date::text AS day
       FROM agent_events
       WHERE agent_id = $1 AND event_type = $2 AND message = $3
       LIMIT 1`,
      [agentId, eventType, message]
    );
    if (result.rows[0]) return result.rows[0].day;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${eventType} event "${message}" for ${agentId}`
  );
}

async function seedTokenUsage(
  agentId: string,
  opts: {
    sessionId?: string;
    model?: string;
    inputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    messageCount?: number;
    sessionStart?: string;
  } = {}
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO agent_token_usage
       (agent_id, session_id, model, input_tokens, cache_creation_tokens,
        cache_read_tokens, output_tokens, message_count, session_start)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      agentId,
      opts.sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`,
      opts.model ?? "claude-sonnet-4-20250514",
      opts.inputTokens ?? 100,
      opts.cacheCreationTokens ?? 10,
      opts.cacheReadTokens ?? 5,
      opts.outputTokens ?? 50,
      opts.messageCount ?? 3,
      opts.sessionStart ?? new Date().toISOString(),
    ]
  );
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_feedback");
  await ctx.pool.query("DELETE FROM media");
  await ctx.pool.query("DELETE FROM agent_token_usage");
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/heatmap
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/heatmap", () => {
  it("returns empty days array with no events", async () => {
    const res = await authedInject("GET", "/api/v1/activity/heatmap");
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toEqual([]);
  });

  it("returns day counts for seeded events", async () => {
    const agentId = await createAgent();
    const eventDay = await waitForAgentEvent(
      agentId,
      "idle",
      "Session started."
    );
    await seedEvent(agentId, "working", `${eventDay}T10:00:00Z`);
    await seedEvent(agentId, "working", `${eventDay}T11:00:00Z`);

    const res = await authedInject("GET", "/api/v1/activity/heatmap?tz=UTC");
    expect(res.statusCode).toBe(200);
    const { days } = res.json();
    expect(days.length).toBeGreaterThanOrEqual(1);
    const todayEntry = days.find((d: { day: string }) =>
      d.day.startsWith(eventDay)
    );
    expect(todayEntry).toBeTruthy();
    // 2 seeded + 1 "Session started" idle event from createAgent
    expect(todayEntry.count).toBe(3);
  });

  it("respects days query parameter", async () => {
    const agentId = await createAgent();
    await seedEvent(agentId, "working", new Date().toISOString());

    const res = await authedInject("GET", "/api/v1/activity/heatmap?days=1");
    expect(res.statusCode).toBe(200);
    expect(res.json().days.length).toBe(1);
  });

  it("clamps days to maximum of 730", async () => {
    const res = await authedInject("GET", "/api/v1/activity/heatmap?days=9999");
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/stats
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/stats", () => {
  it("returns zero stats with no events", async () => {
    const res = await authedInject("GET", "/api/v1/activity/stats");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWorkingMs).toBe(0);
    expect(body.busiestDay).toBeNull();
    expect(body.busiestDayCount).toBe(0);
  });

  it("returns computed stats for seeded events", async () => {
    const agentId = await createAgent();
    const eventDay = await waitForAgentEvent(
      agentId,
      "idle",
      "Session started."
    );
    await seedEvent(agentId, "working", `${eventDay}T10:00:00Z`);
    await seedEvent(agentId, "done", `${eventDay}T10:30:00Z`);

    const res = await authedInject("GET", "/api/v1/activity/stats?tz=UTC");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalWorkingMs).toBeGreaterThan(0);
    expect(body.busiestDay).toBeTruthy();
    // 2 seeded + 1 "Session started" idle event from createAgent
    expect(body.busiestDayCount).toBe(3);
    expect(body.stateDurations).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/daily-status
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/daily-status", () => {
  it("returns days array and granularity", async () => {
    const res = await authedInject("GET", "/api/v1/activity/daily-status");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toEqual([]);
    expect(body.granularity).toBe("day");
  });

  it("returns daily status for seeded events", async () => {
    const agentId = await createAgent();
    const today = new Date().toISOString().slice(0, 10);
    await seedEvent(agentId, "working", `${today}T08:00:00Z`);
    await seedEvent(agentId, "done", `${today}T09:00:00Z`);

    const res = await authedInject(
      "GET",
      "/api/v1/activity/daily-status?tz=UTC"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().days.length).toBeGreaterThanOrEqual(1);
  });

  it("respects granularity query parameter", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/activity/daily-status?granularity=week"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().granularity).toBe("week");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/active-hours
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/active-hours", () => {
  it("returns empty events with no data", async () => {
    const res = await authedInject("GET", "/api/v1/activity/active-hours");
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });

  it("returns active-state events only", async () => {
    const agentId = await createAgent();
    const today = new Date().toISOString().slice(0, 10);
    await seedEvent(agentId, "working", `${today}T10:00:00Z`);
    await seedEvent(agentId, "blocked", `${today}T10:05:00Z`);
    await seedEvent(agentId, "done", `${today}T10:10:00Z`);
    await seedEvent(agentId, "idle", `${today}T10:15:00Z`);

    const res = await authedInject(
      "GET",
      "/api/v1/activity/active-hours?tz=UTC"
    );
    expect(res.statusCode).toBe(200);
    const { events } = res.json();
    expect(events.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/agents-created
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/agents-created", () => {
  it("returns empty days with no agents", async () => {
    const res = await authedInject("GET", "/api/v1/activity/agents-created");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("counts agents by their first event date", async () => {
    const agentId = await createAgent();
    const today = new Date().toISOString().slice(0, 10);
    await seedEvent(agentId, "working", `${today}T10:00:00Z`);

    const res = await authedInject(
      "GET",
      "/api/v1/activity/agents-created?tz=UTC"
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.days.length).toBe(1);
    expect(body.granularity).toBe("day");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/working-time-by-project
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/working-time-by-project", () => {
  it("returns empty projects with no events", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/activity/working-time-by-project"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([]);
  });

  it("computes working time grouped by project", async () => {
    const agentId = await createAgent({ cwd: "/home/user/project-a" });
    const today = new Date().toISOString().slice(0, 10);
    await seedEvent(agentId, "working", `${today}T10:00:00Z`);
    await seedEvent(agentId, "done", `${today}T10:30:00Z`);

    const res = await authedInject(
      "GET",
      "/api/v1/activity/working-time-by-project?tz=UTC"
    );
    expect(res.statusCode).toBe(200);
    const { projects } = res.json();
    expect(projects.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/token-stats
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/token-stats", () => {
  it("returns zero totals with no token data", async () => {
    const res = await authedInject("GET", "/api/v1/activity/token-stats");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Number(body.total_input)).toBe(0);
    expect(Number(body.total_output)).toBe(0);
    expect(Number(body.total_messages)).toBe(0);
  });

  it("aggregates token usage", async () => {
    const agentId = await createAgent();
    await seedTokenUsage(agentId, {
      inputTokens: 500,
      outputTokens: 200,
      messageCount: 10,
    });

    const res = await authedInject("GET", "/api/v1/activity/token-stats");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Number(body.total_input)).toBe(500);
    expect(Number(body.total_output)).toBe(200);
    expect(Number(body.total_messages)).toBe(10);
    expect(Number(body.total_sessions)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/token-daily
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/token-daily", () => {
  it("returns empty days with no token data", async () => {
    const res = await authedInject("GET", "/api/v1/activity/token-daily");
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toEqual([]);
  });

  it("returns daily token breakdown", async () => {
    const agentId = await createAgent();
    await seedTokenUsage(agentId, {
      inputTokens: 300,
      outputTokens: 100,
      sessionStart: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/activity/token-daily");
    expect(res.statusCode).toBe(200);
    const { days, granularity } = res.json();
    expect(days.length).toBeGreaterThanOrEqual(1);
    expect(granularity).toBe("day");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/token-by-project
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/token-by-project", () => {
  it("returns empty projects with no data", async () => {
    const res = await authedInject("GET", "/api/v1/activity/token-by-project");
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([]);
  });

  it("groups tokens by project directory", async () => {
    const agentId = await createAgent({ cwd: "/home/user/proj" });
    await seedTokenUsage(agentId, { inputTokens: 200, outputTokens: 80 });

    const res = await authedInject("GET", "/api/v1/activity/token-by-project");
    expect(res.statusCode).toBe(200);
    const { projects } = res.json();
    expect(projects.length).toBe(1);
    expect(Number(projects[0].total_input)).toBe(215);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/activity/token-by-model
// ---------------------------------------------------------------------------
describe("GET /api/v1/activity/token-by-model", () => {
  it("returns empty models with no data", async () => {
    const res = await authedInject("GET", "/api/v1/activity/token-by-model");
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([]);
  });

  it("groups tokens by model", async () => {
    const agentId = await createAgent();
    await seedTokenUsage(agentId, {
      model: "claude-opus-4-20250514",
      inputTokens: 1000,
    });
    await seedTokenUsage(agentId, {
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
    });

    const res = await authedInject("GET", "/api/v1/activity/token-by-model");
    expect(res.statusCode).toBe(200);
    const { models } = res.json();
    expect(models.length).toBe(2);
    expect(models[0].model).toBe("claude-opus-4-20250514");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/harvest-tokens
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/harvest-tokens", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/harvest-tokens"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns ok for a valid agent", async () => {
    const agentId = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agentId}/harvest-tokens`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/history/projects
// ---------------------------------------------------------------------------
describe("GET /api/v1/history/projects", () => {
  it("returns empty projects with no agents", async () => {
    const res = await authedInject("GET", "/api/v1/history/projects");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projects).toEqual([]);
    expect(body.projectOptions).toEqual([]);
  });

  it("returns projects grouped by cwd", async () => {
    await createAgent({ cwd: "/home/user/proj-a" });
    await createAgent({ cwd: "/home/user/proj-a" });
    await createAgent({ cwd: "/home/user/proj-b" });

    const res = await authedInject("GET", "/api/v1/history/projects");
    expect(res.statusCode).toBe(200);
    const { projects, projectOptions } = res.json();
    expect(projects.length).toBe(2);
    const projA = projectOptions.find(
      (p: { path: string }) => p.path === "/home/user/proj-a"
    );
    expect(projA).toBeTruthy();
    expect(projA.usageCount).toBe(2);
  });

  it("filters by search query", async () => {
    await createAgent({ cwd: "/home/user/alpha" });
    await createAgent({ cwd: "/home/user/beta" });

    const res = await authedInject(
      "GET",
      "/api/v1/history/projects?search=alpha"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual(["/home/user/alpha"]);
  });

  it("respects limit parameter", async () => {
    await createAgent({ cwd: "/home/user/a" });
    await createAgent({ cwd: "/home/user/b" });

    const res = await authedInject("GET", "/api/v1/history/projects?limit=1");
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.length).toBe(1);
  });

  it("excludes child agents", async () => {
    const parentId = await createAgent({ cwd: "/home/user/parent" });
    await createAgent({
      cwd: "/home/user/parent",
      parentAgentId: parentId,
    });

    const res = await authedInject("GET", "/api/v1/history/projects");
    expect(res.statusCode).toBe(200);
    const projOption = res
      .json()
      .projectOptions.find(
        (p: { path: string }) => p.path === "/home/user/parent"
      );
    expect(projOption.usageCount).toBe(1);
  });

  it("handles search with LIKE special characters", async () => {
    await createAgent({ cwd: "/home/user/100%-proj" });
    await createAgent({ cwd: "/home/user/other" });

    const res = await authedInject(
      "GET",
      "/api/v1/history/projects?search=100%25"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.length).toBe(1);
    expect(res.json().projects[0]).toBe("/home/user/100%-proj");
  });

  it("clamps limit to maximum of 50", async () => {
    await createAgent({ cwd: "/home/user/proj" });

    const res = await authedInject("GET", "/api/v1/history/projects?limit=999");
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.length).toBeLessThanOrEqual(50);
  });

  it("uses gitContext.repoRoot for project grouping", async () => {
    await createAgent({
      cwd: "/home/user/worktree1",
      gitContext: { repoRoot: "/home/user/repo" },
    });
    await createAgent({
      cwd: "/home/user/worktree2",
      gitContext: { repoRoot: "/home/user/repo" },
    });

    const res = await authedInject("GET", "/api/v1/history/projects");
    expect(res.statusCode).toBe(200);
    const proj = res
      .json()
      .projectOptions.find(
        (p: { path: string }) => p.path === "/home/user/repo"
      );
    expect(proj).toBeTruthy();
    expect(proj.usageCount).toBe(2);
  });

  it("returns iconUrl when gitContext has repoIconPath", async () => {
    const agentId = await createAgent({
      cwd: "/home/user/icon-proj",
      gitContext: {
        repoRoot: "/home/user/icon-proj",
        repoIconPath: "/icon.png",
      },
    });

    const res = await authedInject("GET", "/api/v1/history/projects");
    expect(res.statusCode).toBe(200);
    const proj = res
      .json()
      .projectOptions.find(
        (p: { path: string }) => p.path === "/home/user/icon-proj"
      );
    expect(proj.iconUrl).toContain(agentId);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/history/agents
// ---------------------------------------------------------------------------
describe("GET /api/v1/history/agents", () => {
  it("returns empty list with no archived agents", async () => {
    const res = await authedInject("GET", "/api/v1/history/agents");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns only archived (deleted_at set) agents", async () => {
    await createAgent({ name: "live-agent" });
    await createAgent({
      name: "archived-agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.agents[0].name).toBe("archived-agent");
  });

  it("excludes child agents", async () => {
    const parentId = await createAgent({
      name: "parent",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      name: "child",
      parentAgentId: parentId,
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents");
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
  });

  it("filters by search", async () => {
    await createAgent({
      name: "alpha-agent",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      name: "beta-agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?search=alpha"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().agents[0].name).toBe("alpha-agent");
  });

  it("filters by project", async () => {
    await createAgent({
      cwd: "/home/user/proj-x",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      cwd: "/home/user/proj-y",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?project=/home/user/proj-x"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 3; i++) {
      await createAgent({
        name: `agent-${i}`,
        deletedAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?limit=2&offset=1"
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.agents.length).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  it("sorts by name", async () => {
    await createAgent({
      name: "charlie",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      name: "alice",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?sort=name&order=asc"
    );
    expect(res.statusCode).toBe(200);
    const names = res.json().agents.map((a: { name: string }) => a.name);
    expect(names[0]).toBe("alice");
    expect(names[1]).toBe("charlie");
  });

  it("filters by type", async () => {
    await createAgent({
      name: "codex-agent",
      deletedAt: new Date().toISOString(),
    });
    const terminalId = await createAgent({
      name: "terminal-agent",
      deletedAt: new Date().toISOString(),
    });
    await ctx.pool.query(`UPDATE agents SET type = 'terminal' WHERE id = $1`, [
      terminalId,
    ]);

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?type=terminal"
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.agents[0].name).toBe("terminal-agent");
  });

  it("sorts by updated_at", async () => {
    const oldId = await createAgent({
      name: "old-update",
      deletedAt: new Date().toISOString(),
    });
    const newId = await createAgent({
      name: "new-update",
      deletedAt: new Date().toISOString(),
    });
    await ctx.pool.query(
      `UPDATE agents SET updated_at = NOW() - interval '1 hour' WHERE id = $1`,
      [oldId]
    );
    await ctx.pool.query(`UPDATE agents SET updated_at = NOW() WHERE id = $1`, [
      newId,
    ]);

    const resDesc = await authedInject(
      "GET",
      "/api/v1/history/agents?sort=updated_at&order=desc"
    );
    expect(resDesc.statusCode).toBe(200);
    expect(resDesc.json().agents[0].name).toBe("new-update");

    const resAsc = await authedInject(
      "GET",
      "/api/v1/history/agents?sort=updated_at&order=asc"
    );
    expect(resAsc.statusCode).toBe(200);
    expect(resAsc.json().agents[0].name).toBe("old-update");
  });

  it("ignores invalid sort values and defaults to created_at", async () => {
    await createAgent({
      name: "agent-a",
      deletedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await createAgent({
      name: "agent-b",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?sort=; DROP TABLE agents--"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0].name).toBe("agent-b");
  });

  it("defaults order to DESC for non-asc values", async () => {
    await createAgent({
      name: "first",
      deletedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await createAgent({
      name: "second",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?order=invalid"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0].name).toBe("second");
  });

  it("handles search with LIKE special characters", async () => {
    await createAgent({
      name: "100% complete",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      name: "other-agent",
      deletedAt: new Date().toISOString(),
    });

    const resPct = await authedInject(
      "GET",
      "/api/v1/history/agents?search=100%25"
    );
    expect(resPct.statusCode).toBe(200);
    expect(resPct.json().total).toBe(1);
    expect(resPct.json().agents[0].name).toBe("100% complete");
  });

  it("handles search with underscore LIKE wildcard", async () => {
    await createAgent({
      name: "a_b_test",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      name: "axbxtest",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents?search=a_b");
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().agents[0].name).toBe("a_b_test");
  });

  it("clamps limit to maximum of 100", async () => {
    await createAgent({
      name: "agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents?limit=999");
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(100);
  });

  it("clamps negative limit to 1", async () => {
    await createAgent({
      name: "agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents?limit=-5");
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(1);
  });

  it("treats zero limit as default (50)", async () => {
    await createAgent({
      name: "agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents?limit=0");
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(50);
  });

  it("clamps negative offset to 0", async () => {
    await createAgent({
      name: "agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject("GET", "/api/v1/history/agents?offset=-5");
    expect(res.statusCode).toBe(200);
    expect(res.json().offset).toBe(0);
    expect(res.json().total).toBe(1);
  });

  it("filters by date range", async () => {
    const oldAgent = await createAgent({
      name: "old-agent",
      deletedAt: new Date().toISOString(),
    });
    await ctx.pool.query(
      `UPDATE agents SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
      [oldAgent]
    );
    await createAgent({
      name: "recent-agent",
      deletedAt: new Date().toISOString(),
    });

    const res = await authedInject(
      "GET",
      "/api/v1/history/agents?start=2026-07-01T00:00:00Z"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().agents[0].name).toBe("recent-agent");
  });

  it("uses gitContext.repoRoot for project filter", async () => {
    await createAgent({
      cwd: "/home/user/worktree",
      gitContext: { repoRoot: "/home/user/real-repo" },
      deletedAt: new Date().toISOString(),
    });

    const resByRepo = await authedInject(
      "GET",
      "/api/v1/history/agents?project=/home/user/real-repo"
    );
    expect(resByRepo.statusCode).toBe(200);
    expect(resByRepo.json().total).toBe(1);

    const resByCwd = await authedInject(
      "GET",
      "/api/v1/history/agents?project=/home/user/worktree"
    );
    expect(resByCwd.statusCode).toBe(200);
    expect(resByCwd.json().total).toBe(0);
  });

  it("includes children and groupTotalTokens", async () => {
    const parentId = await createAgent({
      name: "parent-with-child",
      deletedAt: new Date().toISOString(),
    });
    await createAgent({
      name: "child-review",
      parentAgentId: parentId,
    });
    await seedTokenUsage(parentId, { inputTokens: 1000, outputTokens: 200 });

    const res = await authedInject("GET", "/api/v1/history/agents");
    expect(res.statusCode).toBe(200);
    const agent = res.json().agents[0];
    expect(agent.children.length).toBe(1);
    expect(agent.children[0].name).toBe("child-review");
    expect(Number(agent.groupTotalTokens)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/history/agents/:id
// ---------------------------------------------------------------------------
describe("GET /api/v1/history/agents/:id", () => {
  it("returns 404 for nonexistent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/history/agents/agt_nonexistent"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns full agent detail with events, tokens, media, and feedback", async () => {
    const agentId = await createAgent({ name: "detail-agent" });
    const today = new Date().toISOString().slice(0, 10);
    await seedEvent(agentId, "working", `${today}T10:00:00Z`, "starting work");
    await seedEvent(agentId, "done", `${today}T10:30:00Z`, "finished");
    await seedTokenUsage(agentId, {
      inputTokens: 800,
      outputTokens: 300,
      model: "claude-sonnet-4-20250514",
    });

    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.id).toBe(agentId);
    expect(body.agent.name).toBe("detail-agent");
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(Number(body.tokenUsage.total_input)).toBe(800);
    expect(Number(body.tokenUsage.total_output)).toBe(300);
    expect(body.tokenUsage.by_model.length).toBe(1);
    expect(body.tokenUsage.by_model[0].model).toBe("claude-sonnet-4-20250514");
    expect(body.media).toEqual([]);
    expect(body.feedback).toEqual([]);
    expect(body.stateDurations).toBeDefined();
  });

  it("includes media records", async () => {
    const agentId = await createAgent();
    await ctx.pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, 'screenshot.png', 'screenshot', 2048)`,
      [agentId]
    );

    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().media.length).toBe(1);
    expect(res.json().media[0].file_name).toBe("screenshot.png");
  });

  it("includes feedback from child agents", async () => {
    const parentId = await createAgent({ name: "parent" });
    const childId = await createAgent({
      name: "reviewer",
      parentAgentId: parentId,
    });
    await ctx.pool.query(
      `UPDATE agents SET persona = 'security-review' WHERE id = $1`,
      [childId]
    );
    await ctx.pool.query(
      `INSERT INTO agent_feedback (agent_id, severity, description, status)
       VALUES ($1, 'warning', 'potential XSS', 'open')`,
      [childId]
    );

    const res = await authedInject("GET", `/api/v1/history/agents/${parentId}`);
    expect(res.statusCode).toBe(200);
    const { feedback } = res.json();
    expect(feedback.length).toBe(1);
    expect(feedback[0].severity).toBe("warning");
    expect(feedback[0].description).toBe("potential XSS");
    expect(feedback[0].persona).toBe("security-review");
  });

  it("includes agent messages in the history detail", async () => {
    const agentId = await createAgent({ name: "history-agent" });
    // Seed a message where the history agent is the sender.
    await ctx.pool.query(
      `INSERT INTO agent_messages
         (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name, content, delivered)
       VALUES ('11111111-1111-1111-1111-111111111111', $1, 'agt_other', 'Hist', 'Other', 'history msg', true)`,
      [agentId]
    );

    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toContain("history msg");

    await ctx.pool.query(
      "DELETE FROM agent_messages WHERE id = '11111111-1111-1111-1111-111111111111'"
    );
  });

  it("includes messages where agent is the recipient", async () => {
    const agentId = await createAgent({ name: "recipient-agent" });
    await ctx.pool.query(
      `INSERT INTO agent_messages
         (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name, content, delivered)
       VALUES ('22222222-2222-2222-2222-222222222222', 'agt_sender', $1, 'Sender', 'Recv', 'incoming msg', true)`,
      [agentId]
    );

    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toContain("incoming msg");

    await ctx.pool.query(
      "DELETE FROM agent_messages WHERE id = '22222222-2222-2222-2222-222222222222'"
    );
  });

  it("computes stateDurations from events", async () => {
    const agentId = await createAgent({ name: "duration-agent" });
    const today = new Date().toISOString().slice(0, 10);
    await seedEvent(agentId, "working", `${today}T10:00:00Z`);
    await seedEvent(agentId, "blocked", `${today}T10:15:00Z`);
    await seedEvent(agentId, "done", `${today}T10:20:00Z`);

    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    const { stateDurations } = res.json();
    expect(stateDurations).toBeDefined();
    expect(stateDurations.working).toBeGreaterThan(0);
    expect(stateDurations.blocked).toBeGreaterThan(0);
  });

  it("returns zero tokens when no usage exists", async () => {
    const agentId = await createAgent({ name: "no-tokens-agent" });
    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    const { tokenUsage } = res.json();
    expect(Number(tokenUsage.total_input)).toBe(0);
    expect(Number(tokenUsage.total_output)).toBe(0);
    expect(Number(tokenUsage.total_messages)).toBe(0);
    expect(tokenUsage.by_model).toEqual([]);
  });

  it("returns multiple models in token breakdown", async () => {
    const agentId = await createAgent({ name: "multi-model" });
    await seedTokenUsage(agentId, {
      model: "claude-opus-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
    });
    await seedTokenUsage(agentId, {
      model: "claude-sonnet-4-20250514",
      inputTokens: 200,
      outputTokens: 100,
    });

    const res = await authedInject("GET", `/api/v1/history/agents/${agentId}`);
    expect(res.statusCode).toBe(200);
    const { tokenUsage } = res.json();
    expect(tokenUsage.by_model.length).toBe(2);
    expect(tokenUsage.by_model[0].model).toBe("claude-opus-4-20250514");
  });
});
