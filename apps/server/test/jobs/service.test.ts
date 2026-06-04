import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "../db/setup.js";
import { JobService, WebhookNotFoundError } from "../../src/jobs/service.js";
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

function makeJob(
  store: JobStore,
  overrides: {
    name: string;
    directory: string;
    prompt?: string | null;
    schedule?: string | null;
  }
) {
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
    baseBranch: null,
    branchName: null,
    autoArchive: true,
    callable: false,
    singleton: true,
    webhookEnabled: false,
    webhookSecret: null,
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
  await pool.query(
    "DELETE FROM agents WHERE id LIKE 'agt_cb_%' OR id LIKE 'agt_job_%' OR id LIKE 'agt_wh_%'"
  );
  vi.mocked(mockLog.warn).mockClear();
  vi.mocked(mockAgentManager.createAgent).mockReset();
  vi.mocked(mockAgentManager.getAgent).mockResolvedValue({
    id: "mock",
    status: "running",
    tmuxSession: null,
  } as Awaited<ReturnType<AgentManager["getAgent"]>>);
});

describe("JobService", () => {
  describe("onRunStateChange callbacks", () => {
    it("fires callbacks and handles errors in individual callbacks", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

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
      const job = await makeJob(store, {
        name: "cb-test",
        directory: "/tmp/test-cb",
      });

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
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
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
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      await service.startSchedulers();
      service.stopAllSchedulers();
    });
  });

  describe("reconcileActiveRuns", () => {
    it("starts monitors for active runs without crashing", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      await service.reconcileActiveRuns();
      service.stopAllSchedulers();
    });
  });

  describe("listJobs with nextRun", () => {
    it("includes nextRun for enabled jobs with schedule", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
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
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
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
    it("runJob creates a job agent with the production-generated default name", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "Rename Test",
        directory: "/tmp/test-rename",
      });

      vi.mocked(mockAgentManager.createAgent).mockImplementation(async () => {
        const createdAt = new Date().toISOString();
        await pool.query(
          `INSERT INTO agents (id, name, type, status, cwd, codex_args, full_access)
           VALUES ('agt_job_rename', 'job-Rename_Test-placeholder', 'claude', 'running', '/tmp/test-rename', '[]'::jsonb, false)`
        );
        return {
          id: "agt_job_rename",
          name: "job-Rename_Test-placeholder",
          type: "claude",
          status: "running",
          cwd: "/tmp/test-rename",
          tmuxSession: null,
          createdAt,
          updatedAt: createdAt,
          metadata: null,
          codexArgs: [],
          claudeArgs: [],
          opencodeArgs: [],
          latestEvent: null,
          fullAccess: false,
          useWorktree: false,
          worktreePath: null,
          worktreeBranch: null,
          setupPhase: null,
          parentAgentId: null,
          persona: null,
          autoReview: false,
          baseBranch: null,
        } as Awaited<ReturnType<AgentManager["createAgent"]>>;
      });

      const result = await service.runJob({
        name: "Rename Test",
        directory: "/tmp/test-rename",
        wait: false,
      });

      expect(result.status).toBe("running");
      expect(mockAgentManager.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          jobRunId: result.runId,
          name: `job-Rename_Test-${result.runId.slice(0, 8)}`,
        })
      );

      await service.completeRunForAgent("agt_job_rename", {
        status: "completed",
        summary: "done",
        tasks: [],
      });
      service.stopAllSchedulers();
    });

    it("runJob throws when job has no prompt", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
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
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "active-run-test",
        directory: "/tmp/test-activerun",
      });

      await store.createRun(job.id, makeRunConfig("active-run-test"));

      await expect(
        service.removeJob({
          name: "active-run-test",
          directory: "/tmp/test-activerun",
        })
      ).rejects.toThrow("has active run");

      service.stopAllSchedulers();
    });
  });

  describe("webhook triggers", () => {
    it("addJob with webhookEnabled generates a secret", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "wh-create-test",
        directory: "/tmp/test-wh-create",
        prompt: "Test prompt",
        webhookEnabled: true,
      });

      expect(job.webhookEnabled).toBe(true);
      expect(job.webhookSecret).toBeTruthy();
      expect(typeof job.webhookSecret).toBe("string");
      expect(job.webhookSecret!.length).toBeGreaterThan(10);

      service.stopAllSchedulers();
    });

    it("addJob without webhookEnabled has no secret", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "wh-no-enable",
        directory: "/tmp/test-wh-no-enable",
        prompt: "Test prompt",
      });

      expect(job.webhookEnabled).toBe(false);
      expect(job.webhookSecret).toBeNull();

      service.stopAllSchedulers();
    });

    it("updateJob enabling webhook generates a new secret", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "wh-update-test",
        directory: "/tmp/test-wh-update",
        prompt: "Test prompt",
        webhookEnabled: false,
      });

      const updated = await service.updateJob({
        name: "wh-update-test",
        directory: "/tmp/test-wh-update",
        webhookEnabled: true,
      });

      expect(updated.webhookEnabled).toBe(true);
      expect(updated.webhookSecret).toBeTruthy();

      service.stopAllSchedulers();
    });

    it("updateJob disabling webhook clears the secret", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "wh-disable-test",
        directory: "/tmp/test-wh-disable",
        prompt: "Test prompt",
        webhookEnabled: true,
      });

      const updated = await service.updateJob({
        name: "wh-disable-test",
        directory: "/tmp/test-wh-disable",
        webhookEnabled: false,
      });

      expect(updated.webhookEnabled).toBe(false);
      expect(updated.webhookSecret).toBeNull();

      service.stopAllSchedulers();
    });

    it("updateJob re-enabling webhook does not change existing secret", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const created = await service.addJob({
        name: "wh-reenable-test",
        directory: "/tmp/test-wh-reenable",
        prompt: "Test prompt",
        webhookEnabled: true,
      });
      const originalSecret = created.webhookSecret;

      const updated = await service.updateJob({
        name: "wh-reenable-test",
        directory: "/tmp/test-wh-reenable",
        webhookEnabled: true,
      });

      expect(updated.webhookSecret).toBe(originalSecret);

      service.stopAllSchedulers();
    });

    it("runJobByWebhook runs the matching job", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "wh-run-test",
        directory: "/tmp/test-wh-run",
        prompt: "Webhook prompt",
        webhookEnabled: true,
      });

      const agentId = `agt_wh_${Date.now()}`;
      vi.mocked(mockAgentManager.createAgent).mockImplementation(async () => {
        const createdAt = new Date().toISOString();
        await pool.query(
          `INSERT INTO agents (id, name, type, status, cwd, codex_args, full_access)
           VALUES ($1, 'wh-test-agent', 'claude', 'running', '/tmp/test-wh-run', '[]'::jsonb, false)`,
          [agentId]
        );
        return {
          id: agentId,
          name: "wh-test-agent",
          type: "claude",
          status: "running",
          cwd: "/tmp/test-wh-run",
          tmuxSession: null,
          createdAt,
          updatedAt: createdAt,
          metadata: null,
          codexArgs: [],
          claudeArgs: [],
          opencodeArgs: [],
          latestEvent: null,
          fullAccess: false,
          useWorktree: false,
          worktreePath: null,
          worktreeBranch: null,
          setupPhase: null,
          parentAgentId: null,
          persona: null,
          autoReview: false,
          baseBranch: null,
        } as Awaited<ReturnType<AgentManager["createAgent"]>>;
      });

      const result = await service.runJobByWebhook(job.webhookSecret!);

      expect(result.jobId).toBe(job.id);
      expect(result.status).toBe("running");

      const store = new JobStore(pool);
      const run = await store.getRun(result.runId);
      expect(run?.config.triggerSource).toBe("webhook");

      await service.completeRunForAgent(agentId, {
        status: "completed",
        summary: "done",
        tasks: [],
      });
      service.stopAllSchedulers();
    });

    it("runJobByWebhook throws WebhookNotFoundError for unknown secret", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await expect(
        service.runJobByWebhook("nonexistent-secret")
      ).rejects.toThrow(WebhookNotFoundError);

      service.stopAllSchedulers();
    });

    it("runJobByWebhook throws for disabled webhook", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "wh-disabled-run",
        directory: "/tmp/test-wh-disabled-run",
        prompt: "Test prompt",
        webhookEnabled: true,
      });
      const secret = job.webhookSecret!;

      await service.updateJob({
        name: "wh-disabled-run",
        directory: "/tmp/test-wh-disabled-run",
        webhookEnabled: false,
      });

      await expect(service.runJobByWebhook(secret)).rejects.toThrow(
        WebhookNotFoundError
      );

      service.stopAllSchedulers();
    });
  });
});
