import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

async function jobId(name: string): Promise<string> {
  const result = await ctx.pool.query(
    "SELECT id FROM jobs WHERE directory = '/tmp' AND name = $1",
    [name]
  );
  return result.rows[0]?.id ?? "missing-job";
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
      jobId: await jobId("patch-me"),
      prompt: "updated prompt",
      singleton: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prompt).toBe("updated prompt");
    expect(body.singleton).toBe(false);
  });

  it("renames a job via name", async () => {
    await createJob("rename-src");
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: await jobId("rename-src"),
      name: "rename-dst",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("rename-dst");
  });

  it("rejects rename to existing name", async () => {
    await createJob("existing-name");
    await createJob("other-job");
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: await jobId("other-job"),
      name: "existing-name",
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("already exists");
  });

  it("returns 500 for non-existent job", async () => {
    const res = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: await jobId("ghost"),
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
      jobId: await jobId("delete-me"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("delete-me");

    const listRes = await authedInject("GET", "/api/v1/jobs");
    expect(listRes.json()).toHaveLength(0);
  });

  it("returns 500 for non-existent job", async () => {
    const res = await authedInject("DELETE", "/api/v1/jobs", {
      jobId: await jobId("ghost"),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("not found");
  });
});

describe("POST /api/v1/jobs/enable", () => {
  it("enables a job with a schedule", async () => {
    await createJob("enable-me", { schedule: "0 */6 * * *" });
    const res = await authedInject("POST", "/api/v1/jobs/enable", {
      jobId: await jobId("enable-me"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(true);
  });

  it("rejects enabling a job without a schedule", async () => {
    await createJob("no-sched");
    const res = await authedInject("POST", "/api/v1/jobs/enable", {
      jobId: await jobId("no-sched"),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("no schedule");
  });
});

describe("POST /api/v1/jobs/disable", () => {
  it("disables an enabled job", async () => {
    await createJob("disable-me", { schedule: "0 */6 * * *" });
    const enableRes = await authedInject("POST", "/api/v1/jobs/enable", {
      jobId: await jobId("disable-me"),
    });
    expect(enableRes.statusCode).toBe(200);
    const res = await authedInject("POST", "/api/v1/jobs/disable", {
      jobId: await jobId("disable-me"),
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
      `/api/v1/jobs/history?jobId=${await jobId("hist-job")}`
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
      `/api/v1/jobs/history?jobId=${await jobId("ghost")}`
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
      jobId: await jobId("run-me"),
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
      jobId: await jobId("run-launch-post"),
      wait: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const posts = await ctx.pool.query(
      `SELECT author_kind, kind, text, delivered, origin, attachments
         FROM blocks WHERE stream_id = $1`,
      [body.agentId]
    );
    // One launch card: the briefing, its startup and its instructions all
    // land on it rather than on rows of their own.
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0]).toMatchObject({
      author_kind: "user",
      kind: "launch",
      delivered: true,
      origin: null,
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
      jobId: await jobId("ghost"),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("not found");
  });

  it("returns 500 for job without a prompt", async () => {
    const cookie = await ctx.sessionCookie();
    // Create a job directly via DB to have no prompt
    const templateRes = await ctx.pool.query(
      `INSERT INTO templates (id, name, directory, prompt, agent_type, use_worktree, full_access, callable, allow_files)
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
      payload: { jobId: "job_no_prompt", wait: false },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("no prompt");
  });

  it("rejects a second run when singleton is true", async () => {
    await createJob("singleton-job", { singleton: true });
    const first = await authedInject("POST", "/api/v1/jobs/run", {
      jobId: await jobId("singleton-job"),
      wait: false,
    });
    expect(first.statusCode).toBe(200);

    const second = await authedInject("POST", "/api/v1/jobs/run", {
      jobId: await jobId("singleton-job"),
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

  it("rejects missing jobId", async () => {
    const res = await authedInject("POST", "/api/v1/jobs/run", {
      directory: "/tmp",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("stable job identity", () => {
  it("keeps running agents in their launched directory and uses edits for later starts", async () => {
    const source = await mkdtemp(
      path.join(os.tmpdir(), "dispatch-job-source-")
    );
    const destination = await mkdtemp(
      path.join(os.tmpdir(), "dispatch-job-destination-")
    );
    try {
      const job = await createJob("running-relocation", {
        singleton: false,
        directory: source,
      });
      const first = await authedInject("POST", "/api/v1/jobs/run", {
        jobId: job.id,
        wait: false,
      });
      expect(first.statusCode).toBe(200);
      const moved = await authedInject("PATCH", "/api/v1/jobs", {
        jobId: job.id,
        directory: destination,
        name: "running-relocated",
      });
      expect(moved.statusCode).toBe(200);
      const second = await authedInject("POST", "/api/v1/jobs/run", {
        jobId: job.id,
        wait: false,
      });
      expect(second.statusCode).toBe(200);
      const agents = await ctx.pool.query(
        "SELECT id, cwd FROM agents WHERE id = ANY($1::text[])",
        [[first.json().agentId, second.json().agentId]]
      );
      expect(
        agents.rows.find((agent) => agent.id === first.json().agentId).cwd
      ).toBe(source);
      expect(
        agents.rows.find((agent) => agent.id === second.json().agentId).cwd
      ).toBe(destination);
      const history = await authedInject(
        "GET",
        `/api/v1/jobs/history?jobId=${job.id}`
      );
      expect(history.json().runs).toHaveLength(2);
      await ctx.pool.query(
        "UPDATE job_runs SET status = 'completed' WHERE job_id = $1",
        [job.id]
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  it("preserves history, webhook and template identity through directory and name edits", async () => {
    const job = await createJob("before-move", {
      webhookEnabled: true,
      schedule: "0 */6 * * *",
    });
    const run = await ctx.pool.query(
      `INSERT INTO job_runs (id, job_id, status, config) VALUES ('relocation-run', $1, 'completed', $2::jsonb) RETURNING id`,
      [job.id, JSON.stringify({ directory: "/tmp", name: "before-move" })]
    );
    const updated = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: job.id,
      name: "after-move",
      directory: " /tmp/new-location/../moved/ ",
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: job.id,
      name: "after-move",
      directory: "/tmp/moved",
      templateId: job.templateId,
      webhookSecret: job.webhookSecret,
      schedule: job.schedule,
    });
    const template = await ctx.pool.query(
      "SELECT name, directory FROM templates WHERE id = $1",
      [job.templateId]
    );
    expect(template.rows[0]).toEqual({
      name: "after-move",
      directory: "/tmp/moved",
    });
    const history = await authedInject(
      "GET",
      `/api/v1/jobs/history?jobId=${job.id}`
    );
    expect(history.json().runs[0]).toMatchObject({
      id: run.rows[0].id,
      jobId: job.id,
      config: { directory: "/tmp", name: "before-move" },
    });
    expect(
      (
        await authedInject("PATCH", "/api/v1/jobs", {
          jobId: job.id,
          prompt: "edited again",
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await authedInject("POST", "/api/v1/jobs/enable", { jobId: job.id })
      ).json().enabled
    ).toBe(true);
    expect(
      (
        await authedInject("POST", "/api/v1/jobs/disable", { jobId: job.id })
      ).json().enabled
    ).toBe(false);
    expect(
      (await authedInject("DELETE", "/api/v1/jobs", { jobId: job.id }))
        .statusCode
    ).toBe(200);
  });

  it("rejects blank directories and old mutation identity", async () => {
    const job = await createJob("blank-directory");
    expect(
      (
        await authedInject("PATCH", "/api/v1/jobs", {
          jobId: job.id,
          directory: "   ",
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await authedInject("PATCH", "/api/v1/jobs", {
          name: job.name,
          directory: job.directory,
          prompt: "wrong identity",
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await authedInject("DELETE", "/api/v1/jobs", {
          name: job.name,
          directory: job.directory,
        })
      ).statusCode
    ).toBe(400);
  });

  it("rejects destination job conflicts and rolls back backing template conflicts", async () => {
    const job = await createJob("source");
    await createJob("destination", { directory: "/tmp/destination" });
    const conflict = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: job.id,
      name: "destination",
      directory: "/tmp/destination",
    });
    expect(conflict.statusCode).toBe(500);
    expect(conflict.json().error).toContain("already exists");
    await authedInject("POST", "/api/v1/templates", {
      name: "template-conflict",
      directory: "/tmp/destination",
      prompt: "template",
    });
    const templateConflict = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: job.id,
      name: "template-conflict",
      directory: "/tmp/destination",
      prompt: "must roll back",
    });
    expect(templateConflict.statusCode).toBe(500);
    const saved = await authedInject(
      "GET",
      `/api/v1/jobs/history?jobId=${job.id}`
    );
    expect(saved.json().job).toMatchObject({
      name: "source",
      directory: "/tmp",
      prompt: "test prompt",
    });
  });
});

describe("project and folder job directories", () => {
  it("retains project cwd for ID-only edits and detaches into an editable folder", async () => {
    await ctx.pool.query(
      "INSERT INTO projects (id, name, repo_root) VALUES ('job-location-project', 'Location', '/tmp/project-root')"
    );
    const job = await createJob("project-job", {
      projectId: "job-location-project",
      directory: "/tmp/ignored",
    });
    expect(job.directory).toBe("/tmp/project-root");
    const projectEdit = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: job.id,
      prompt: "Keep membership",
      directory: "/tmp/must-not-override",
    });
    expect(projectEdit.statusCode).toBe(200);
    expect(projectEdit.json().directory).toBe("/tmp/project-root");
    const folderEdit = await authedInject("PATCH", "/api/v1/jobs", {
      jobId: job.id,
      projectId: null,
      directory: "/tmp/folder-root",
    });
    expect(folderEdit.statusCode).toBe(200);
    expect(folderEdit.json().directory).toBe("/tmp/folder-root");
    const template = await ctx.pool.query(
      "SELECT directory, project_id FROM templates WHERE id = $1",
      [job.templateId]
    );
    expect(template.rows[0]).toEqual({
      directory: "/tmp/folder-root",
      project_id: null,
    });
    const reloaded = await authedInject(
      "GET",
      `/api/v1/jobs/history?jobId=${job.id}`
    );
    expect(reloaded.json().job.directory).toBe("/tmp/folder-root");
  });
});
