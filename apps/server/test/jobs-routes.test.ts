import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedInject(
  method: string,
  url: string,
  payload?: unknown
): Promise<ReturnType<typeof ctx.app.inject>> {
  const cookie = await ctx.sessionCookie();
  return ctx.app.inject({
    method: method as "GET" | "POST" | "PATCH" | "DELETE",
    url,
    headers: { cookie, "content-type": "application/json" },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function createJob(
  name: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await authedInject("POST", "/api/v1/jobs", {
    name,
    directory: "/tmp",
    prompt: "test prompt",
    ...overrides,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM templates");
});

describe("POST /api/v1/jobs (create)", () => {
  it("creates a job with required fields", async () => {
    const body = await createJob("create-basic");
    expect(body.name).toBe("create-basic");
    expect(body.directory).toBe("/tmp");
    expect(body.id).toBeTruthy();
    expect(body.agentType).toBe("claude");
    expect(body.singleton).toBe(true);
    expect(body.autoArchive).toBe(true);
    expect(body.enabled).toBe(false);
  });

  it("creates a job with optional fields", async () => {
    const body = await createJob("create-full", {
      schedule: "0 */6 * * *",
      agentType: "codex",
      useWorktree: true,
      baseBranch: "develop",
      fullAccess: true,
      autoArchive: false,
      singleton: false,
    });
    expect(body.schedule).toBe("0 */6 * * *");
    expect(body.agentType).toBe("codex");
    expect(body.useWorktree).toBe(true);
    expect(body.baseBranch).toBe("develop");
    expect(body.fullAccess).toBe(true);
    expect(body.autoArchive).toBe(false);
    expect(body.singleton).toBe(false);
  });

  it("rejects missing name", async () => {
    const res = await authedInject("POST", "/api/v1/jobs", {
      directory: "/tmp",
      prompt: "test",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing directory", async () => {
    const res = await authedInject("POST", "/api/v1/jobs", {
      name: "no-dir",
      prompt: "test",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects enabled without schedule", async () => {
    const res = await authedInject("POST", "/api/v1/jobs", {
      name: "no-sched",
      directory: "/tmp",
      prompt: "test",
      enabled: true,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("schedule");
  });

  it("rejects invalid cron expression", async () => {
    const res = await authedInject("POST", "/api/v1/jobs", {
      name: "bad-cron",
      directory: "/tmp",
      prompt: "test",
      schedule: "not-a-cron",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("invalid cron");
  });
});

describe("GET /api/v1/jobs (list)", () => {
  it("returns empty array when no jobs exist", async () => {
    const res = await authedInject("GET", "/api/v1/jobs");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns created jobs with nextRun field", async () => {
    await createJob("list-a");
    await createJob("list-b");
    const res = await authedInject("GET", "/api/v1/jobs");
    expect(res.statusCode).toBe(200);
    const jobs = res.json();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].nextRun).toBeNull();
  });
});

describe("PATCH /api/v1/jobs (update)", () => {
  it("updates job configuration", async () => {
    await createJob("patch-me");
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      name: "patch-me",
      directory: "/tmp",
      prompt: "updated prompt",
      singleton: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prompt).toBe("updated prompt");
    expect(body.singleton).toBe(false);
  });

  it("renames a job via displayName", async () => {
    await createJob("rename-src");
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      name: "rename-src",
      directory: "/tmp",
      displayName: "rename-dst",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("rename-dst");
  });

  it("rejects rename to existing name", async () => {
    await createJob("existing-name");
    await createJob("other-job");
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      name: "other-job",
      directory: "/tmp",
      displayName: "existing-name",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("already exists");
  });

  it("returns 500 for non-existent job", async () => {
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      name: "ghost",
      directory: "/tmp",
      prompt: "nope",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("not found");
  });
});

describe("DELETE /api/v1/jobs", () => {
  it("deletes an existing job", async () => {
    await createJob("delete-me");
    const res = await authedInject("DELETE", "/api/v1/jobs", {
      name: "delete-me",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("delete-me");

    const listRes = await authedInject("GET", "/api/v1/jobs");
    expect(listRes.json()).toHaveLength(0);
  });

  it("returns 500 for non-existent job", async () => {
    const res = await authedInject("DELETE", "/api/v1/jobs", {
      name: "ghost",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("not found");
  });
});

describe("POST /api/v1/jobs/enable", () => {
  it("enables a job with a schedule", async () => {
    await createJob("enable-me", { schedule: "0 */6 * * *" });
    const res = await authedInject("POST", "/api/v1/jobs/enable", {
      name: "enable-me",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it("rejects enabling a job without a schedule", async () => {
    await createJob("no-sched");
    const res = await authedInject("POST", "/api/v1/jobs/enable", {
      name: "no-sched",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("no schedule");
  });
});

describe("POST /api/v1/jobs/disable", () => {
  it("disables an enabled job", async () => {
    await createJob("disable-me", { schedule: "0 */6 * * *" });
    const enableRes = await authedInject("POST", "/api/v1/jobs/enable", {
      name: "disable-me",
      directory: "/tmp",
    });
    expect(enableRes.statusCode).toBe(200);
    const res = await authedInject("POST", "/api/v1/jobs/disable", {
      name: "disable-me",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });
});

describe("GET /api/v1/jobs/stats", () => {
  it("returns stats structure with no runs", async () => {
    const res = await authedInject("GET", "/api/v1/jobs/stats");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toBeDefined();
    expect(body.stats.totalRuns).toBe(0);
    expect(body.stats.successCount).toBe(0);
    expect(body.stats.failureCount).toBe(0);
    expect(body.stats.daily).toBeInstanceOf(Array);
    expect(body.recentRuns).toBeInstanceOf(Array);
    expect(body.recentRuns).toHaveLength(0);
  });
});

describe("GET /api/v1/jobs/history", () => {
  it("returns history for an existing job", async () => {
    await createJob("hist-job");
    const res = await authedInject(
      "GET",
      "/api/v1/jobs/history?name=hist-job&directory=/tmp"
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job.name).toBe("hist-job");
    expect(body.runs).toBeInstanceOf(Array);
    expect(body.runs).toHaveLength(0);
  });

  it("returns 404 for non-existent job", async () => {
    const res = await authedInject(
      "GET",
      "/api/v1/jobs/history?name=ghost&directory=/tmp"
    );
    expect(res.statusCode).toBe(404);
  });

  it("rejects missing query params", async () => {
    const res = await authedInject("GET", "/api/v1/jobs/history");
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/jobs/run", () => {
  it("runs a job and returns result", async () => {
    const job = await createJob("run-me");
    const res = await authedInject("POST", "/api/v1/jobs/run", {
      name: "run-me",
      directory: "/tmp",
      wait: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobId).toBe(job.id);
    expect(body.runId).toBeTruthy();
    expect(body.agentId).toBeTruthy();
    // Mark the run as completed and wait for the 2s monitor poll to see it,
    // preventing "Cannot use pool after end" errors during teardown.
    await ctx.pool.query(
      `UPDATE job_runs SET status = 'completed' WHERE id = $1`,
      [body.runId]
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });

  it("records the job prompt as the agent's launch post", async () => {
    await createJob("run-launch-post", { prompt: "Sweep the stale branches" });
    const res = await authedInject("POST", "/api/v1/jobs/run", {
      name: "run-launch-post",
      directory: "/tmp",
      wait: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const posts = await ctx.pool.query(
      `SELECT author_kind, kind, text, delivered, origin, attachments
         FROM agent_chat_messages WHERE agent_id = $1`,
      [body.agentId]
    );
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0]).toMatchObject({
      author_kind: "user",
      kind: "reply",
      delivered: true,
      origin: "launch",
      attachments: [],
    });
    // Chat shows only the user-authored prompt, not generated job lifecycle
    // scaffolding (which still reaches the CLI through agentArgs).
    expect(posts.rows[0].text).toBe("Sweep the stale branches");
    await ctx.pool.query(
      `UPDATE job_runs SET status = 'completed' WHERE id = $1`,
      [body.runId]
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });

  it("returns 500 for non-existent job", async () => {
    const res = await authedInject("POST", "/api/v1/jobs/run", {
      name: "ghost",
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("not found");
  });

  it("returns 500 for job without a prompt", async () => {
    const cookie = await ctx.sessionCookie();
    // Create a job directly via DB to have no prompt
    const templateRes = await ctx.pool.query(
      `INSERT INTO templates (id, name, directory, prompt, agent_type, use_worktree, full_access, callable, allow_media)
       VALUES ('tpl_no_prompt', 'no-prompt', '/tmp', NULL, 'claude', false, false, false, false)
       RETURNING id`
    );
    await ctx.pool.query(
      `INSERT INTO jobs (id, name, directory, prompt, schedule, timeout_ms, needs_input_timeout_ms, agent_type,
         use_worktree, full_access, auto_archive, callable, singleton, enabled, template_id, default_args)
       VALUES ('job_no_prompt', 'no-prompt', '/tmp', NULL, NULL, 1800000, 86400000, 'claude',
         false, false, true, false, true, false, 'tpl_no_prompt', '{}')`
    );
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/jobs/run",
      headers: { cookie, "content-type": "application/json" },
      payload: { name: "no-prompt", directory: "/tmp", wait: false },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("no prompt");
  });

  it("rejects a second run when singleton is true", async () => {
    await createJob("singleton-job", { singleton: true });
    const first = await authedInject("POST", "/api/v1/jobs/run", {
      name: "singleton-job",
      directory: "/tmp",
      wait: false,
    });
    expect(first.statusCode).toBe(200);

    const second = await authedInject("POST", "/api/v1/jobs/run", {
      name: "singleton-job",
      directory: "/tmp",
      wait: false,
    });
    expect(second.statusCode).toBe(500);
    expect(second.json().error).toContain("already has active run");

    // Mark the first run as completed and wait for the 2s monitor poll to see it.
    await ctx.pool.query(
      `UPDATE job_runs SET status = 'completed' WHERE id = $1`,
      [first.json().runId]
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });

  it("rejects missing name", async () => {
    const res = await authedInject("POST", "/api/v1/jobs/run", {
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(400);
  });
});
