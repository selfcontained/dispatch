import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "../db/setup.js";
import { JobService } from "../../src/jobs/service.js";
import { JobStore } from "../../src/jobs/store.js";
import type { AgentManager } from "../../src/agents/manager.js";

let pool: Pool;

const mockLog = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => mockLog),
  silent: vi.fn(),
  level: "debug",
} as unknown as import("fastify").FastifyBaseLogger;

const mockAgentManager = {
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(() => Promise.resolve([])),
} as unknown as AgentManager;

const mockConfig = {
  agentRuntime: "inert" as const,
  host: "127.0.0.1",
  port: 6767,
} as import("../../src/config.js").AppConfig;

function makeJob(store: JobStore, overrides: { name: string; directory: string; prompt?: string | null; schedule?: string | null }) {
  return store.createJob({
    name: overrides.name,
    directory: overrides.directory,
    prompt: overrides.prompt !== undefined ? overrides.prompt : "Test prompt",
    schedule: overrides.schedule ?? null,
    timeoutMs: 30_000,
    needsInputTimeoutMs: 30_000,
    fullAccess: false,
    agentType: "claude",
    useWorktree: false,
    branchName: null,
    enabled: false,
  });
}

function makeRunConfig(name: string) {
  return {
    directory: "/tmp/test",
    name,
    schedule: null,
    timeoutMs: 30_000,
    needsInputTimeoutMs: 30_000,
    notify: { onComplete: [], onError: [], onNeedsInput: [] },
  };
}

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query("DELETE FROM job_runs");
  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM agents WHERE id LIKE 'agt_cb_%'");
  vi.mocked(mockLog.warn).mockClear();
});

describe("JobService", () => {
  describe("onRunStateChange callbacks", () => {
    it("fires callbacks and handles errors in individual callbacks", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);

      const events: string[] = [];
      service.onRunStateChange((run) => {
        events.push(`first:${run.status}`);
      });
      service.onRunStateChange(() => {
        throw new Error("callback boom");
      });
      service.onRunStateChange((run) => {
        events.push(`third:${run.status}`);
      });

      const store = new JobStore(pool);
      const job = await makeJob(store, { name: "cb-test", directory: "/tmp/test-cb" });

      // Create a real agent record to satisfy FK constraint
      const agentId = `agt_cb_${Date.now()}`;
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, codex_args, full_access)
         VALUES ($1, 'cb-test-agent', 'claude', 'running', '/tmp', '[]'::jsonb, false)`,
        [agentId]
      );

      const run = await store.createRun(job.id, makeRunConfig("cb-test"));
      await store.attachAgent(run.id, agentId);

      // completeRunForAgent triggers emitRunStateChange
      await service.completeRunForAgent(agentId, {
        status: "completed",
        summary: "All good",
        tasks: [],
      });

      // First and third callbacks should fire even though second threw
      expect(events).toEqual(["first:completed", "third:completed"]);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "onRunStateChange callback error"
      );

      service.stopAllSchedulers();
    });
  });

  describe("scheduler lifecycle", () => {
    it("starts and stops schedulers for enabled jobs", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "sched-test",
        directory: "/tmp/test-sched",
        schedule: "0 */6 * * *",
      });
      await store.updateJobConfig(job.id, { enabled: true });

      // startSchedulers should pick it up
      await service.startSchedulers();

      // stopAllSchedulers should clean up without error
      service.stopAllSchedulers();
    });

    it("startSchedulers is safe to call with no jobs", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      await service.startSchedulers();
      service.stopAllSchedulers();
    });
  });

  describe("reconcileActiveRuns", () => {
    it("starts monitors for active runs without crashing", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      await service.reconcileActiveRuns();
      service.stopAllSchedulers();
    });
  });

  describe("listJobs with nextRun", () => {
    it("includes nextRun for enabled jobs with schedule", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "next-run-test",
        directory: "/tmp/test-nextrun",
        schedule: "0 12 * * *",
      });
      await store.updateJobConfig(job.id, { enabled: true });

      const jobs = await service.listJobs();
      const found = jobs.find((j) => j.name === "next-run-test");
      expect(found).toBeDefined();
      expect(found!.nextRun).toBeTruthy();
      expect(new Date(found!.nextRun!).getTime()).toBeGreaterThan(Date.now());

      service.stopAllSchedulers();
    });

    it("nextRun is null for disabled jobs", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "disabled-test",
        directory: "/tmp/test-disabled",
        schedule: "0 12 * * *",
      });
      await store.updateJobConfig(job.id, { enabled: false });

      const jobs = await service.listJobs();
      const found = jobs.find((j) => j.name === "disabled-test");
      expect(found).toBeDefined();
      expect(found!.nextRun).toBeNull();

      service.stopAllSchedulers();
    });
  });

  describe("error paths", () => {
    it("runJob throws when job has no prompt", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "no-prompt",
        directory: "/tmp/test-noprompt",
        prompt: null,
      });

      await expect(
        service.runJob({ name: "no-prompt", directory: "/tmp/test-noprompt" })
      ).rejects.toThrow("no prompt configured");

      service.stopAllSchedulers();
    });


    it("removeJob throws when job has active run", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "active-run-test",
        directory: "/tmp/test-activerun",
      });

      await store.createRun(job.id, makeRunConfig("active-run-test"));

      await expect(
        service.removeJob({ name: "active-run-test", directory: "/tmp/test-activerun" })
      ).rejects.toThrow("has active run");

      service.stopAllSchedulers();
    });
  });
});
