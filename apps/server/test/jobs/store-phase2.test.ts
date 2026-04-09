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

const jobDefaults = {
  schedule: "0 * * * *",
  timeoutMs: 60_000,
  needsInputTimeoutMs: 86_400_000,
  fullAccess: false,
  agentType: "claude" as const,
  useWorktree: false,
  branchName: null,
  enabled: false,
};

const runConfig = {
  directory: "/tmp/test-repo",
  name: "cleanup",
  schedule: "0 * * * *",
  timeoutMs: 60_000,
  needsInputTimeoutMs: 86_400_000,
  notify: { onComplete: ["slack"], onError: ["slack"], onNeedsInput: [] },
};

describe("JobStore Phase 2 — list, history, enable/disable", () => {
  it("listJobs returns jobs with latest run info", async () => {
    const job = await store.createJob({
      ...jobDefaults,
      name: "cleanup",
      directory: "/tmp/test-repo",
      prompt: "Clean things up",
    });
    const jobs = await store.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const found = jobs.find((j) => j.id === job.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("cleanup");
    expect(found!.lastRunId).toBeNull();
    expect(found!.lastRunStatus).toBeNull();
  });

  it("listJobs shows latest run after a run completes", async () => {
    const job = await store.createJob({
      ...jobDefaults,
      name: "cleanup-run-test",
      directory: "/tmp/test-repo",
      prompt: "Clean things up",
    });
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
    const job = await store.createJob({
      ...jobDefaults,
      name: "history-test",
      directory: "/tmp/test-repo",
      prompt: "History test prompt",
    });

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
    const job = await store.createJob({
      ...jobDefaults,
      name: "toggle-test",
      directory: "/tmp/test-repo",
      prompt: "Toggle test",
    });
    expect(job.enabled).toBe(false);

    const enabled = await store.setEnabled(job.id, true);
    expect(enabled.enabled).toBe(true);

    const disabled = await store.setEnabled(job.id, false);
    expect(disabled.enabled).toBe(false);
  });

  it("getJobByDirectoryAndName finds job", async () => {
    await store.createJob({
      ...jobDefaults,
      name: "find-by-name",
      directory: "/tmp/test-repo",
      prompt: "Find me",
    });
    const found = await store.getJobByDirectoryAndName("/tmp/test-repo", "find-by-name");
    expect(found).toBeDefined();
    expect(found!.name).toBe("find-by-name");
  });

  it("getJobByDirectoryAndName returns null for unknown", async () => {
    const found = await store.getJobByDirectoryAndName("/nonexistent", "nope");
    expect(found).toBeNull();
  });

  it("createJob stores full config", async () => {
    const job = await store.createJob({
      ...jobDefaults,
      name: "config-test",
      directory: "/tmp/test-repo",
      prompt: "Original prompt",
      schedule: "30 2 * * 1-5",
      timeoutMs: 120_000,
      needsInputTimeoutMs: 7_200_000,
    });
    expect(job.schedule).toBe("30 2 * * 1-5");
    expect(job.timeoutMs).toBe(120_000);
    expect(job.needsInputTimeoutMs).toBe(7_200_000);
    expect(job.prompt).toBe("Original prompt");
  });

  it("updateJobConfig updates prompt and name", async () => {
    const job = await store.createJob({
      ...jobDefaults,
      name: "update-test",
      directory: "/tmp/test-repo",
      prompt: "First prompt",
      schedule: "0 3 * * *",
      timeoutMs: 300_000,
    });

    const updated = await store.updateJobConfig(job.id, {
      name: "Update Test Renamed",
      prompt: "Updated prompt",
    });

    expect(updated.name).toBe("Update Test Renamed");
    expect(updated.prompt).toBe("Updated prompt");
    expect(updated.schedule).toBe("0 3 * * *");     // preserved
    expect(updated.timeoutMs).toBe(300_000);          // preserved
  });

  it("listRunsForJob respects limit", async () => {
    const job = await store.createJob({
      ...jobDefaults,
      name: "limit-test",
      directory: "/tmp/test-repo",
      prompt: "Limit test",
    });

    await store.createRun(job.id, { ...runConfig, name: "limit-test" });
    const runs = await store.listRunsForJob(job.id, 1);
    expect(runs.length).toBe(1);
  });
});
