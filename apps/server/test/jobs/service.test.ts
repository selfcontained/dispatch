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

      // Insert a job and run, then complete it to trigger callbacks
      const store = new JobStore(pool);
      const job = await store.upsertJobFromDefinition({
        name: "cb-test",
        schedule: null,
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        fullAccess: false,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        body: "Test prompt",
        directory: "/tmp/test-cb",
        filePath: "/tmp/test-cb/.dispatch/jobs/cb-test.md",
      });

      // Create a real agent record to satisfy FK constraint
      const agentId = `agt_cb_${Date.now()}`;
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, codex_args, full_access)
         VALUES ($1, 'cb-test-agent', 'claude', 'running', '/tmp', '[]'::jsonb, false)`,
        [agentId]
      );

      const run = await store.createRun(job.id, {
        directory: "/tmp/test-cb",
        filePath: "/tmp/test-cb/.dispatch/jobs/cb-test.md",
        name: "cb-test",
        schedule: null,
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        triggerSource: "manual",
      });
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

      const job = await store.upsertJobFromDefinition({
        name: "sched-test",
        schedule: "0 */6 * * *",
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        fullAccess: false,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        body: "Scheduled job",
        directory: "/tmp/test-sched",
        filePath: "/tmp/test-sched/.dispatch/jobs/sched-test.md",
      });
      await store.updateJobConfig(job.id, { enabled: true });

      // startSchedulers should pick it up
      await service.startSchedulers();

      // stopAllSchedulers should clean up without error
      service.stopAllSchedulers();
    });

    it("startSchedulers is safe to call with no jobs", async () => {
      // Use a fresh service that won't see jobs from other tests
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      await service.startSchedulers();
      service.stopAllSchedulers();
    });
  });

  describe("reconcileActiveRuns", () => {
    it("starts monitors for active runs without crashing", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);

      // Should handle empty list gracefully
      await service.reconcileActiveRuns();

      service.stopAllSchedulers();
    });
  });

  describe("listJobs with nextRun", () => {
    it("includes nextRun for enabled jobs with schedule", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await store.upsertJobFromDefinition({
        name: "next-run-test",
        schedule: "0 12 * * *",
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        fullAccess: false,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        body: "Test",
        directory: "/tmp/test-nextrun",
        filePath: "/tmp/test-nextrun/.dispatch/jobs/next-run-test.md",
      });
      await store.updateJobConfig(job.id, { enabled: true });

      const jobs = await service.listJobs();
      const found = jobs.find((j) => j.name === "next-run-test");
      expect(found).toBeDefined();
      expect(found!.nextRun).toBeTruthy();
      // Verify it's a valid ISO date
      expect(new Date(found!.nextRun!).getTime()).toBeGreaterThan(Date.now());

      service.stopAllSchedulers();
    });

    it("nextRun is null for disabled jobs", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await store.upsertJobFromDefinition({
        name: "disabled-test",
        schedule: "0 12 * * *",
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        fullAccess: false,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        body: "Test",
        directory: "/tmp/test-disabled",
        filePath: "/tmp/test-disabled/.dispatch/jobs/disabled-test.md",
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

      await store.upsertJobFromDefinition({
        name: "no-prompt",
        schedule: null,
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        fullAccess: false,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        body: "",
        directory: "/tmp/test-noprompt",
        filePath: "/tmp/test-noprompt/.dispatch/jobs/no-prompt.md",
      });

      await expect(
        service.runJob({ name: "no-prompt", directory: "/tmp/test-noprompt" })
      ).rejects.toThrow("no prompt configured");

      service.stopAllSchedulers();
    });

    it("removeJob throws when job has active run", async () => {
      const service = new JobService(pool, mockAgentManager, mockLog, mockConfig);
      const store = new JobStore(pool);

      const job = await store.upsertJobFromDefinition({
        name: "active-run-test",
        schedule: null,
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        fullAccess: false,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        body: "Some prompt",
        directory: "/tmp/test-activerun",
        filePath: "/tmp/test-activerun/.dispatch/jobs/active-run-test.md",
      });

      // Create a run that stays in started status
      await store.createRun(job.id, {
        directory: "/tmp/test-activerun",
        filePath: "/tmp/test-activerun/.dispatch/jobs/active-run-test.md",
        name: "active-run-test",
        schedule: null,
        timeoutMs: 30_000,
        needsInputTimeoutMs: 30_000,
        notify: { onComplete: [], onError: [], onNeedsInput: [] },
        triggerSource: "manual",
      });

      await expect(
        service.removeJob({ name: "active-run-test", directory: "/tmp/test-activerun" })
      ).rejects.toThrow("has active run");

      service.stopAllSchedulers();
    });
  });
});
