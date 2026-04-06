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

const definition = {
  name: "cleanup",
  schedule: "0 * * * *",
  timeoutMs: 60_000,
  needsInputTimeoutMs: 86_400_000,
  fullAccess: false,
  notify: { onComplete: ["slack"], onError: ["slack"], onNeedsInput: [] },
  body: "Clean things up",
  directory: "/tmp/test-repo",
  filePath: "/tmp/test-repo/.dispatch/jobs/cleanup.md",
};

const runConfig = {
  directory: definition.directory,
  filePath: definition.filePath,
  name: definition.name,
  schedule: definition.schedule,
  timeoutMs: definition.timeoutMs,
  needsInputTimeoutMs: definition.needsInputTimeoutMs,
  notify: definition.notify,
};

describe("JobStore Phase 2 — list, history, enable/disable", () => {
  it("listJobs returns jobs with latest run info", async () => {
    const job = await store.upsertJobFromDefinition(definition);
    const jobs = await store.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const found = jobs.find((j) => j.id === job.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("cleanup");
    expect(found!.lastRunId).toBeNull();
    expect(found!.lastRunStatus).toBeNull();
  });

  it("listJobs shows latest run after a run completes", async () => {
    const job = await store.upsertJobFromDefinition(definition);
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
    const job = await store.upsertJobFromDefinition({
      ...definition,
      name: "history-test",
      filePath: "/tmp/test-repo/.dispatch/jobs/history-test.md",
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
    const job = await store.upsertJobFromDefinition({
      ...definition,
      name: "toggle-test",
      filePath: "/tmp/test-repo/.dispatch/jobs/toggle-test.md",
    });
    expect(job.enabled).toBe(false);

    const enabled = await store.setEnabled(job.id, true);
    expect(enabled.enabled).toBe(true);

    const disabled = await store.setEnabled(job.id, false);
    expect(disabled.enabled).toBe(false);
  });

  it("getJobByDirectoryAndFilePath finds job", async () => {
    await store.upsertJobFromDefinition(definition);
    const found = await store.getJobByDirectoryAndFilePath("/tmp/test-repo", "/tmp/test-repo/.dispatch/jobs/cleanup.md");
    expect(found).toBeDefined();
    expect(found!.name).toBe("cleanup");
  });

  it("getJobByDirectoryAndFilePath returns null for unknown", async () => {
    const found = await store.getJobByDirectoryAndFilePath("/nonexistent", "/nonexistent/.dispatch/jobs/nope.md");
    expect(found).toBeNull();
  });

  it("listRunsForJob respects limit", async () => {
    const job = await store.upsertJobFromDefinition({
      ...definition,
      name: "limit-test",
      filePath: "/tmp/test-repo/.dispatch/jobs/limit-test.md",
    });

    const run = await store.createRun(job.id, { ...runConfig, name: "limit-test" });
    const runs = await store.listRunsForJob(job.id, 1);
    expect(runs.length).toBe(1);
  });
});
