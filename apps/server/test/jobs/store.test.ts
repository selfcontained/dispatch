import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { JobStore } from "../../src/jobs/store.js";
import { getTestDatabaseUrl, runTestMigrations, setupTestDb, teardownTestDb } from "../db/setup.js";

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

describe("JobStore", () => {
  it("creates jobs, tracks runs, and requires terminal structured reports", async () => {
    expect(getTestDatabaseUrl()).toContain("dispatch_test_");
    const job = await store.createJob({
      name: "janitor",
      directory: "/tmp/repo",
      prompt: "Do work",
      schedule: null,
      timeoutMs: 1_000,
      needsInputTimeoutMs: 1_000,
      fullAccess: false,
      agentType: "claude",
      useWorktree: false,
      branchName: null,
      enabled: false,
    });
    const run = await store.createRun(job.id, {
      directory: "/tmp/repo",
      name: "janitor",
      schedule: null,
      timeoutMs: 1_000,
      needsInputTimeoutMs: 1_000,
      notify: { onComplete: [], onError: [], onNeedsInput: [] },
    });
    await expect(store.createRun(job.id, {
      directory: "/tmp/repo",
      name: "janitor",
      schedule: null,
      timeoutMs: 1_000,
      needsInputTimeoutMs: 1_000,
      notify: { onComplete: [], onError: [], onNeedsInput: [] },
    })).rejects.toThrow(`Job already has active run ${run.id}.`);
    await pool.query(
      `INSERT INTO agents (id, name, status, cwd) VALUES ('agent-1', 'Job Agent', 'running', '/tmp/repo')`
    );

    await expect(store.findActiveRun(job.id)).resolves.toMatchObject({ id: run.id, status: "started" });
    await store.attachAgent(run.id, "agent-1");
    await expect(store.getLatestRunForAgent("agent-1")).resolves.toMatchObject({ id: run.id });
    await store.logForAgent("agent-1", { task: "clean", message: "started", level: "info" });

    await expect(store.completeRunForAgent("agent-1", {
      status: "failed",
      summary: "Wrong terminal status",
      tasks: [{ name: "clean", status: "error", summary: "bad" }]
    })).rejects.toThrow('report.status must be "completed"');

    const completed = await store.completeRunForAgent("agent-1", {
      status: "completed",
      summary: "Finished",
      tasks: [{ name: "clean", status: "success", summary: "ok" }]
    });
    expect(completed.status).toBe("completed");
    expect(completed.report?.summary).toBe("Finished");
    await expect(store.findActiveRun(job.id)).resolves.toBeNull();
    await expect(store.getLatestRunForAgent("agent-1")).resolves.toMatchObject({ id: run.id, status: "completed" });

    await expect(store.markTimedOut(run.id, {
      status: "failed",
      summary: "Late timeout",
      tasks: [{ name: "guardrails", status: "error", summary: "too late" }]
    })).rejects.toThrow("is no longer active (completed)");
    await expect(store.failRunForAgent("agent-1", {
      status: "failed",
      summary: "Late failure",
      tasks: [{ name: "clean", status: "error", summary: "too late" }]
    })).rejects.toThrow("No active job run found for agent agent-1.");

    const rerun = await store.createRun(job.id, {
      directory: "/tmp/repo",
      name: "janitor",
      schedule: null,
      timeoutMs: 1_000,
      needsInputTimeoutMs: 1_000,
      notify: { onComplete: [], onError: [], onNeedsInput: [] },
    });
    expect(rerun.status).toBe("started");
  });
});
