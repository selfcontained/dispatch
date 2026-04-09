import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { JobStore } from "../../src/jobs/store.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "../db/setup.js";

let pool: Pool;
let store: JobStore;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  store = new JobStore(pool);
});

afterAll(async () => {
  await teardownTestDb();
});

const createInput = {
  name: "cleanup",
  directory: "/tmp/test-repo",
  prompt: "Clean things up",
  schedule: "0 * * * *",
  timeoutMs: 60_000,
  needsInputTimeoutMs: 86_400_000,
  fullAccess: false,
};

const runConfig = {
  directory: createInput.directory,
  name: createInput.name,
  schedule: createInput.schedule,
  timeoutMs: createInput.timeoutMs!,
  needsInputTimeoutMs: createInput.needsInputTimeoutMs!,
  notify: { onComplete: [] as string[], onError: [] as string[], onNeedsInput: [] as string[] },
};

describe("JobStore Phase 2 — list, history, enable/disable", () => {
  it("listJobs returns jobs with latest run info", async () => {
    const job = await store.createJob(createInput);
    const jobs = await store.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const found = jobs.find((j) => j.id === job.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("cleanup");
    expect(found!.lastRunId).toBeNull();
    expect(found!.lastRunStatus).toBeNull();
  });

  it("listJobs shows latest run after a run completes", async () => {
    const job = await store.createJob({ ...createInput, name: "list-run-test" });
    const run = await store.createRun(job.id, runConfig);

    await pool.query(
      `INSERT INTO agents (id, name, status, cwd) VALUES ('agent-list-1', 'Test Agent', 'running', '/tmp/test-repo')
       ON CONFLICT (id) DO NOTHING`
    );
    await store.attachAgent(run.id, "agent-list-1");
    await store.completeRunForAgent("agent-list-1", {
      status: "completed",
      summary: "All clean",
      tasks: [{ name: "sweep", status: "success", summary: "ok" }],
    });

    const jobs = await store.listJobs();
    const found = jobs.find((j) => j.id === job.id);
    expect(found!.lastRunStatus).toBe("completed");
    expect(found!.lastRunId).toBe(run.id);
  });

  it("listRunsForJob returns runs in descending order", async () => {
    const job = await store.createJob({ ...createInput, name: "history-test" });

    // Create first run and complete it
    const run1 = await store.createRun(job.id, { ...runConfig, name: "history-test" });
    await pool.query(
      `INSERT INTO agents (id, name, status, cwd) VALUES ('agent-hist-1', 'Test', 'running', '/tmp/test-repo')
       ON CONFLICT (id) DO NOTHING`
    );
    await store.attachAgent(run1.id, "agent-hist-1");
    await store.completeRunForAgent("agent-hist-1", {
      status: "completed",
      summary: "Done 1",
      tasks: [{ name: "t", status: "success", summary: "ok" }],
    });

    // Create second run
    const run2 = await store.createRun(job.id, { ...runConfig, name: "history-test" });

    const runs = await store.listRunsForJob(job.id);
    expect(runs.length).toBe(2);
    expect(runs[0].id).toBe(run2.id); // newest first
    expect(runs[1].id).toBe(run1.id);
  });

  it("setEnabled toggles enabled flag", async () => {
    const job = await store.createJob({ ...createInput, name: "toggle-test" });
    expect(job.enabled).toBe(false);

    const enabled = await store.setEnabled(job.id, true);
    expect(enabled.enabled).toBe(true);

    const disabled = await store.setEnabled(job.id, false);
    expect(disabled.enabled).toBe(false);
  });

  it("getJob finds job by id", async () => {
    const job = await store.createJob({ ...createInput, name: "get-by-id-test" });
    const found = await store.getJob(job.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("get-by-id-test");
  });

  it("getJob returns null for unknown id", async () => {
    const found = await store.getJob("00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  it("createJob stores full config on insert", async () => {
    const job = await store.createJob({
      ...createInput,
      name: "config-test",
      schedule: "30 2 * * 1-5",
      timeoutMs: 120_000,
      needsInputTimeoutMs: 7_200_000,
      prompt: "Original prompt",
    });
    expect(job.schedule).toBe("30 2 * * 1-5");
    expect(job.timeoutMs).toBe(120_000);
    expect(job.needsInputTimeoutMs).toBe(7_200_000);
    expect(job.prompt).toBe("Original prompt");
  });

  it("updateJobConfig updates prompt and preserves other config", async () => {
    const job = await store.createJob({
      ...createInput,
      name: "update-test",
      schedule: "0 3 * * *",
      timeoutMs: 300_000,
      prompt: "First prompt",
    });

    const updated = await store.updateJobConfig(job.id, {
      name: "Update Test Renamed",
      prompt: "Updated prompt",
    });

    expect(updated.name).toBe("Update Test Renamed");
    expect(updated.prompt).toBe("Updated prompt");
    expect(updated.schedule).toBe("0 3 * * *"); // preserved
    expect(updated.timeoutMs).toBe(300_000);      // preserved
  });

  it("listRunsForJob respects limit", async () => {
    const job = await store.createJob({ ...createInput, name: "limit-test" });
    await store.createRun(job.id, { ...runConfig, name: "limit-test" });
    const runs = await store.listRunsForJob(job.id, 1);
    expect(runs.length).toBe(1);
  });
});
