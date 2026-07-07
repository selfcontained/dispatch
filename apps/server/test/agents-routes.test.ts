import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string,
  payload?: unknown
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  const headers: Record<string, string> = { cookie };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
  }
  return ctx.app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createAgent(
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await authedInject("POST", "/api/v1/agents", {
    cwd: "/tmp",
    useWorktree: false,
    ...overrides,
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent;
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM templates");
  await ctx.pool.query(
    "DELETE FROM settings WHERE key = 'enabled_agent_types'"
  );
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents (list)", () => {
  it("returns empty list when no agents exist", async () => {
    const res = await authedInject("GET", "/api/v1/agents");
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toEqual([]);
  });

  it("returns created agents", async () => {
    await createAgent({ name: "alpha" });
    await createAgent({ name: "bravo" });
    const res = await authedInject("GET", "/api/v1/agents");
    expect(res.statusCode).toBe(200);
    const { agents } = res.json();
    expect(agents).toHaveLength(2);
    const names = agents.map((a: { name: string }) => a.name);
    expect(names).toContain("alpha");
    expect(names).toContain("bravo");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id (get)", () => {
  it("returns an agent by id", async () => {
    const agent = await createAgent({ name: "lookup-test" });
    const res = await authedInject("GET", `/api/v1/agents/${agent.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.name).toBe("lookup-test");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await authedInject("GET", "/api/v1/agents/agt_nonexistent");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents (create)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents (create)", () => {
  it("creates an agent with minimal fields", async () => {
    const agent = await createAgent();
    expect(agent.id).toBeTruthy();
    expect(agent.cwd).toBe("/tmp");
    expect(agent.type).toBe("codex");
  });

  it("creates an agent with a name and type", async () => {
    const agent = await createAgent({ name: "my-agent", type: "claude" });
    expect(agent.name).toBe("my-agent");
    expect(agent.type).toBe("claude");
  });

  it("rejects missing cwd", async () => {
    const res = await authedInject("POST", "/api/v1/agents", {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("cwd");
  });

  it("rejects invalid agent type", async () => {
    const res = await authedInject("POST", "/api/v1/agents", {
      cwd: "/tmp",
      type: "nonexistent",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("type must be");
  });

  it("rejects initial prompt exceeding max length", async () => {
    const res = await authedInject("POST", "/api/v1/agents", {
      cwd: "/tmp",
      initialPrompt: "x".repeat(16_001),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("initialPrompt");
  });

  it("rejects non-string initialPrompt", async () => {
    const res = await authedInject("POST", "/api/v1/agents", {
      cwd: "/tmp",
      initialPrompt: 42,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("initialPrompt");
  });

  it("rejects non-string worktreeBranch", async () => {
    const res = await authedInject("POST", "/api/v1/agents", {
      cwd: "/tmp",
      worktreeBranch: 123,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("worktreeBranch");
  });

  it("rejects non-string baseBranch", async () => {
    const res = await authedInject("POST", "/api/v1/agents", {
      cwd: "/tmp",
      baseBranch: false,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("baseBranch");
  });

  it("creates a terminal agent", async () => {
    const agent = await createAgent({ type: "terminal" });
    expect(agent.type).toBe("terminal");
  });

  it("applies fullAccess arg for claude type", async () => {
    const agent = await createAgent({
      type: "claude",
      fullAccess: true,
    });
    expect(agent.fullAccess).toBe(true);
  });

  it("rejects disabled agent type", async () => {
    await ctx.pool.query(
      `INSERT INTO settings (key, value) VALUES ('enabled_agent_types', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(["claude"])]
    );
    const res = await authedInject("POST", "/api/v1/agents", {
      cwd: "/tmp",
      type: "codex",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("disabled");
  });

  it("does not apply fullAccess for terminal agents", async () => {
    const agent = await createAgent({
      type: "terminal",
      fullAccess: true,
    });
    expect(agent.type).toBe("terminal");
    expect(agent.fullAccess).toBe(false);
  });

  it("defaults type to codex when omitted", async () => {
    const agent = await createAgent({});
    expect(agent.type).toBe("codex");
  });

  it("applies fullAccess arg for codex type", async () => {
    const agent = await createAgent({
      type: "codex",
      fullAccess: true,
    });
    expect(agent.fullAccess).toBe(true);
  });

  it("trims whitespace-only initialPrompt to undefined", async () => {
    const agent = await createAgent({
      initialPrompt: "   ",
    });
    expect(agent.initialPrompt).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/repo-icon
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/repo-icon", () => {
  it("returns 404 for non-existent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/repo-icon"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Agent not found");
  });

  it("returns 404 when agent has no repo icon", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agent.id}/repo-icon`
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("No repo icon");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/latest-event
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/latest-event", () => {
  it("sets a working event on an agent", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "Compiling" }
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.latestEvent.type).toBe("working");
    expect(body.agent.latestEvent.message).toBe("Compiling");
  });

  it("accepts all valid event types", async () => {
    const agent = await createAgent();
    for (const type of ["working", "blocked", "waiting_user", "done", "idle"]) {
      const res = await authedInject(
        "POST",
        `/api/v1/agents/${agent.id}/latest-event`,
        { type, message: `Status: ${type}` }
      );
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects invalid event type", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "exploding", message: "boom" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("type must be");
  });

  it("rejects empty message", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "   " }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("message");
  });

  it("rejects non-object metadata", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "hi", metadata: "bad" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("metadata");
  });

  it("accepts valid metadata object", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "done", message: "finished", metadata: { tool: "vitest" } }
    );
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/focus
// ---------------------------------------------------------------------------
describe("POST /api/v1/focus", () => {
  it("sets focus to an agent", async () => {
    const agent = await createAgent();
    const res = await authedInject("POST", "/api/v1/focus", {
      agentId: agent.id,
    });
    expect(res.statusCode).toBe(204);
  });

  it("clears focus with null agentId", async () => {
    const res = await authedInject("POST", "/api/v1/focus", {
      agentId: null,
    });
    expect(res.statusCode).toBe(204);
  });

  it("rejects empty string agentId", async () => {
    const res = await authedInject("POST", "/api/v1/focus", {
      agentId: "   ",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("agentId");
  });

  it("rejects non-string agentId", async () => {
    const res = await authedInject("POST", "/api/v1/focus", {
      agentId: 123,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/notifications/ack
// ---------------------------------------------------------------------------
describe("POST /api/v1/notifications/ack", () => {
  it("acks a notification", async () => {
    const res = await authedInject("POST", "/api/v1/notifications/ack", {
      notificationId: "notif-123",
    });
    expect(res.statusCode).toBe(204);
  });

  it("rejects missing notificationId", async () => {
    const res = await authedInject("POST", "/api/v1/notifications/ack", {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("notificationId");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/setup/error
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/setup/error", () => {
  it("marks agent setup as failed", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/error`,
      { message: "npm install failed" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const getRes = await authedInject("GET", `/api/v1/agents/${agent.id}`);
    expect(getRes.json().agent.status).toBe("stopped");
  });

  it("uses default message when none provided", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/error`,
      {}
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns error for non-existent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/setup/error",
      { message: "fail" }
    );
    // markSetupFailed does not guard against missing agents before updating
    expect(res.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/setup/phase
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/setup/phase", () => {
  it("updates setup phase to a valid phase", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/phase`,
      { phase: "deps" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("rejects invalid phase", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/phase`,
      { phase: "magic" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("phase");
  });

  it("rejects missing phase", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/phase`,
      {}
    );
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/setup/complete
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/setup/complete", () => {
  it("completes setup for an agent in creating state", async () => {
    const agent = await createAgent();
    // Inert runtime puts agents in running; reset to creating for this test
    await ctx.pool.query(
      `UPDATE agents SET status = 'creating', setup_phase = 'session' WHERE id = $1`,
      [agent.id]
    );
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/complete`,
      { effectiveCwd: "/tmp/worktree" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("rejects when agent is already running", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/complete`,
      { effectiveCwd: "/tmp/worktree" }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("creating");
  });

  it("rejects missing effectiveCwd", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/complete`,
      {}
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("effectiveCwd");
  });

  it("returns error for non-existent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/setup/complete",
      { effectiveCwd: "/tmp" }
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/agents/:id/review-agent-type
// ---------------------------------------------------------------------------
describe("PATCH /api/v1/agents/:id/review-agent-type", () => {
  it("sets review agent type", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: "claude" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.reviewAgentType).toBe("claude");
  });

  it("clears review agent type with null", async () => {
    const agent = await createAgent();
    await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: "claude" }
    );
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: null }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.reviewAgentType).toBeNull();
  });

  it("rejects invalid review agent type", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: "gpt4" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("reviewAgentType");
  });

  it("rejects terminal as review agent type", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: "terminal" }
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects disabled agent type for review", async () => {
    await ctx.pool.query(
      `INSERT INTO settings (key, value) VALUES ('enabled_agent_types', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(["claude"])]
    );
    const agent = await createAgent({ type: "claude" });
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: "codex" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("disabled");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await authedInject(
      "PATCH",
      "/api/v1/agents/agt_nonexistent/review-agent-type",
      { reviewAgentType: "claude" }
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/stop
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/stop", () => {
  it("rejects non-boolean force field", async () => {
    const agent = await createAgent();
    const res = await authedInject("POST", `/api/v1/agents/${agent.id}/stop`, {
      force: "yes",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("force");
  });

  it("returns error for non-existent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/stop",
      {}
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/stream (validation)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/stream", () => {
  it("rejects invalid stream type", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/stream`,
      { type: "rtmp" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("type must be");
  });

  it("rejects playwright stream without port", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/stream`,
      { type: "playwright" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("port");
  });

  it("rejects playwright stream with invalid port", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/stream`,
      { type: "playwright", port: -1 }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("port");
  });

  it("returns 404 for non-existent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/stream",
      { type: "stop" }
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/stream (viewer)
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/stream", () => {
  it("returns 404 for non-existent agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/agt_nonexistent/stream"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when no active stream", async () => {
    const agent = await createAgent();
    const res = await authedInject("GET", `/api/v1/agents/${agent.id}/stream`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("No active stream");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/agents/:id
// ---------------------------------------------------------------------------
describe("DELETE /api/v1/agents/:id", () => {
  it("begins archiving an agent", async () => {
    const agent = await createAgent();
    const res = await authedInject("DELETE", `/api/v1/agents/${agent.id}`);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("archiving");
  });

  it("accepts cleanupWorktree query parameter", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "DELETE",
      `/api/v1/agents/${agent.id}?cleanupWorktree=keep`
    );
    expect(res.statusCode).toBe(202);
  });

  it("returns error for non-existent agent", async () => {
    const res = await authedInject("DELETE", "/api/v1/agents/agt_nonexistent");
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/git-context
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/git-context", () => {
  it("returns contexts for all agents when no ids given", async () => {
    await createAgent({ name: "ctx-a" });
    await createAgent({ name: "ctx-b" });
    const res = await authedInject("GET", "/api/v1/agents/git-context");
    expect(res.statusCode).toBe(200);
    expect(res.json().contexts).toHaveLength(2);
  });

  it("filters by comma-separated ids", async () => {
    const a = await createAgent({ name: "ctx-filter" });
    await createAgent({ name: "ctx-other" });
    const res = await authedInject(
      "GET",
      `/api/v1/agents/git-context?ids=${a.id}`
    );
    expect(res.statusCode).toBe(200);
    const { contexts } = res.json();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].id).toBe(a.id);
  });

  it("returns empty contexts when no agents match ids", async () => {
    await createAgent();
    const res = await authedInject(
      "GET",
      "/api/v1/agents/git-context?ids=agt_nonexistent"
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().contexts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/prompt-rename
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/prompt-rename", () => {
  it("returns 404 for non-existent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/prompt-rename",
      {}
    );
    expect(res.statusCode).toBe(404);
  });

  it("rejects rename for agent not running", async () => {
    const agent = await createAgent();
    // Inert runtime sets agents to running; stop it for this test
    await ctx.pool.query(`UPDATE agents SET status = 'stopped' WHERE id = $1`, [
      agent.id,
    ]);
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/prompt-rename`,
      {}
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("running");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/terminal/token (inert mode)
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/terminal/token", () => {
  it("returns inert mode for agents in inert runtime", async () => {
    const agent = await createAgent();
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/terminal/token`,
      {}
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("inert");
  });

  it("returns error for non-existent agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/agt_nonexistent/terminal/token",
      {}
    );
    expect(res.statusCode).toBe(404);
  });
});
