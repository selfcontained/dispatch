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
  await ctx.pool.query("DELETE FROM agents");
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/diff-stats
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/diff-stats", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/nonexistent/diff-stats"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns diffStats for a valid agent", async () => {
    const agent = await createAgent({ name: "diff-stats-test" });
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agent.id}/diff-stats`
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("diffStats");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/diff
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/diff", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject("GET", "/api/v1/agents/nonexistent/diff");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns empty files when agent has no git-backed worktree", async () => {
    const agent = await createAgent({ name: "no-worktree" });
    const res = await authedInject("GET", `/api/v1/agents/${agent.id}/diff`);
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/diff/file
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/diff/file", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/nonexistent/diff/file?path=foo.ts"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 400 when path query param is missing", async () => {
    const agent = await createAgent({ name: "missing-path" });
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agent.id}/diff/file`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/path query parameter required/i);
  });

  it("rejects path traversal with 400", async () => {
    const agent = await createAgent({ name: "traversal-test" });
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agent.id}/diff/file?path=../../etc/passwd`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid file path/i);
  });

  it("returns 404 when file not found in diff", async () => {
    const agent = await createAgent({ name: "no-wt-file" });
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agent.id}/diff/file?path=src/foo.ts`
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/file not found in diff/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/diff/comment
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/diff/comment", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/nonexistent/diff/comment",
      { filePath: "foo.ts", startLine: 1, endLine: 5, comment: "looks good" }
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 400 when body is empty", async () => {
    const agent = await createAgent({ name: "empty-body" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      {}
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/filePath.*startLine.*endLine.*comment/i);
  });

  it("returns 400 when filePath is missing", async () => {
    const agent = await createAgent({ name: "no-filepath" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { startLine: 1, endLine: 5, comment: "hello" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/filePath.*startLine.*endLine.*comment/i);
  });

  it("returns 400 when startLine is not a number", async () => {
    const agent = await createAgent({ name: "bad-start" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: "abc", endLine: 5, comment: "hello" }
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when comment is empty/whitespace", async () => {
    const agent = await createAgent({ name: "empty-comment" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: 1, endLine: 5, comment: "   " }
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects path traversal in filePath", async () => {
    const agent = await createAgent({ name: "traversal-comment" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      {
        filePath: "../../etc/passwd",
        startLine: 1,
        endLine: 1,
        comment: "bad",
      }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid file path/i);
  });

  it("rejects startLine < 1", async () => {
    const agent = await createAgent({ name: "bad-start-line" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: 0, endLine: 5, comment: "hello" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid line range/i);
  });

  it("rejects endLine < startLine", async () => {
    const agent = await createAgent({ name: "reversed-range" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: 10, endLine: 5, comment: "hello" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid line range/i);
  });

  it("rejects non-integer line numbers", async () => {
    const agent = await createAgent({ name: "float-lines" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: 1.5, endLine: 5, comment: "hello" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid line range/i);
  });

  it("rejects line range > 500", async () => {
    const agent = await createAgent({ name: "huge-range" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: 1, endLine: 502, comment: "hello" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/line range too large/i);
  });

  it("rejects comment > 10000 chars", async () => {
    const agent = await createAgent({ name: "long-comment" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      {
        filePath: "foo.ts",
        startLine: 1,
        endLine: 1,
        comment: "x".repeat(10_001),
      }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/comment too long/i);
  });

  it("returns 404 when diff unavailable for agent", async () => {
    const agent = await createAgent({ name: "no-wt-comment" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/diff/comment`,
      { filePath: "foo.ts", startLine: 1, endLine: 1, comment: "hello" }
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/file not found in diff/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/agents/:id/name
// ---------------------------------------------------------------------------
describe("PATCH /api/v1/agents/:id/name", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject("PATCH", "/api/v1/agents/nonexistent/name", {
      name: "new-name",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when name is missing", async () => {
    const agent = await createAgent({ name: "rename-test" });
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/name`,
      {}
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name must be a non-empty string/i);
  });

  it("returns 400 when name is whitespace-only", async () => {
    const agent = await createAgent({ name: "rename-test" });
    const res = await authedInject("PATCH", `/api/v1/agents/${agent.id}/name`, {
      name: "   ",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name must be a non-empty string/i);
  });

  it("returns 400 when name exceeds 120 characters", async () => {
    const agent = await createAgent({ name: "rename-test" });
    const res = await authedInject("PATCH", `/api/v1/agents/${agent.id}/name`, {
      name: "a".repeat(121),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/120 characters or fewer/i);
  });

  it("renames the agent and returns updated record", async () => {
    const agent = await createAgent({ name: "old-name" });
    const res = await authedInject("PATCH", `/api/v1/agents/${agent.id}/name`, {
      name: "shiny-new-name",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.name).toBe("shiny-new-name");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/prompt-rename
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/prompt-rename", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/nonexistent/prompt-rename"
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it("returns 409 when agent already has a custom name", async () => {
    const agent = await createAgent({ name: "my-custom-name" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/prompt-rename`
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has a custom session name/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/agents/:id/review-agent-type
// ---------------------------------------------------------------------------
describe("PATCH /api/v1/agents/:id/review-agent-type", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "PATCH",
      "/api/v1/agents/nonexistent/review-agent-type",
      { reviewAgentType: "claude" }
    );
    expect(res.statusCode).toBe(404);
  });

  it("clears review agent type with null", async () => {
    const agent = await createAgent({ name: "clear-rat" });
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: null }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("agent");
  });

  it("rejects invalid review agent type", async () => {
    const agent = await createAgent({ name: "bad-rat" });
    const res = await authedInject(
      "PATCH",
      `/api/v1/agents/${agent.id}/review-agent-type`,
      { reviewAgentType: "invalid-runtime" }
    );
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/setup/phase
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/setup/phase", () => {
  it("returns 400 for invalid phase", async () => {
    const agent = await createAgent({ name: "bad-phase" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/phase`,
      { phase: "invalid" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/phase must be one of/i);
  });

  it("returns 400 when phase is missing", async () => {
    const agent = await createAgent({ name: "no-phase" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/phase`,
      {}
    );
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid phase values", async () => {
    const agent = await createAgent({ name: "valid-phase" });
    for (const phase of ["worktree", "env", "deps", "session"]) {
      const res = await authedInject(
        "POST",
        `/api/v1/agents/${agent.id}/setup/phase`,
        { phase }
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/setup/complete
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/setup/complete", () => {
  it("returns 400 when effectiveCwd is missing", async () => {
    const agent = await createAgent({ name: "no-cwd" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/complete`,
      {}
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/effectiveCwd/i);
  });

  it("returns 409 when agent is not in creating state", async () => {
    const agent = await createAgent({ name: "setup-not-creating" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/complete`,
      { effectiveCwd: "/tmp/test" }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not in creating state/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/latest-event
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/latest-event", () => {
  it("returns 400 for invalid event type", async () => {
    const agent = await createAgent({ name: "bad-event-type" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "invalid", message: "hello" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/type must be one of/);
  });

  it("returns 400 when message is missing", async () => {
    const agent = await createAgent({ name: "no-msg" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/message must be a non-empty string/);
  });

  it("returns 400 when message is whitespace-only", async () => {
    const agent = await createAgent({ name: "ws-msg" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "   " }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/message must be a non-empty string/);
  });

  it("returns 400 when metadata is not an object", async () => {
    const agent = await createAgent({ name: "bad-meta" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "hello", metadata: "not-an-object" }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/metadata must be an object/);
  });

  it("returns 400 when metadata is an array", async () => {
    const agent = await createAgent({ name: "arr-meta" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "hello", metadata: ["not", "valid"] }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/metadata must be an object/);
  });

  it("returns 400 when metadata is null", async () => {
    const agent = await createAgent({ name: "null-meta" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "hello", metadata: null }
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/metadata must be an object/);
  });

  it("accepts valid event with all fields", async () => {
    const agent = await createAgent({ name: "valid-event" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "working", message: "doing stuff", metadata: { phase: "build" } }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeDefined();
  });

  it("accepts valid event without metadata", async () => {
    const agent = await createAgent({ name: "no-meta-ok" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "done", message: "finished" }
    );
    expect(res.statusCode).toBe(200);
  });

  it("trims message whitespace", async () => {
    const agent = await createAgent({ name: "trim-msg" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/latest-event`,
      { type: "idle", message: "  padded message  " }
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent.latestEvent.message).toBe("padded message");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/setup/error
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/setup/error", () => {
  it("marks agent setup as failed and returns ok", async () => {
    const agent = await createAgent({ name: "err-report" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/error`,
      { message: "git worktree add failed" }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("defaults message when not provided", async () => {
    const agent = await createAgent({ name: "err-default" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/setup/error`,
      {}
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/start
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/start", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "POST",
      "/api/v1/agents/nonexistent/start",
      {}
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/agents/:id/worktree-status
// ---------------------------------------------------------------------------
describe("GET /api/v1/agents/:id/worktree-status", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/agents/nonexistent/worktree-status"
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns worktree status for a valid agent", async () => {
    const agent = await createAgent({ name: "wt-status" });
    const res = await authedInject(
      "GET",
      `/api/v1/agents/${agent.id}/worktree-status`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("hasWorktree");
    expect(body).toHaveProperty("hasUnmergedCommits");
    expect(body).toHaveProperty("worktreePath");
    expect(body).toHaveProperty("branchName");
    expect(body).toHaveProperty("changedFiles");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agents/:id/stop
// ---------------------------------------------------------------------------
describe("POST /api/v1/agents/:id/stop", () => {
  it("returns 400 when force is not a boolean", async () => {
    const agent = await createAgent({ name: "bad-force" });
    const res = await authedInject("POST", `/api/v1/agents/${agent.id}/stop`, {
      force: "yes",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/force must be a boolean/i);
  });

  it("returns 404 for unknown agent", async () => {
    const res = await authedInject("POST", "/api/v1/agents/nonexistent/stop", {
      force: false,
    });
    expect(res.statusCode).toBe(404);
  });

  it("accepts stop with force=true", async () => {
    const agent = await createAgent({ name: "force-stop" });
    const res = await authedInject("POST", `/api/v1/agents/${agent.id}/stop`, {
      force: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeDefined();
  });

  it("accepts stop without force field", async () => {
    const agent = await createAgent({ name: "no-force" });
    const res = await authedInject(
      "POST",
      `/api/v1/agents/${agent.id}/stop`,
      {}
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toBeDefined();
  });
});
