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

      await service.shutdown();
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
      await service.shutdown();
    });

    it("startSchedulers is safe to call with no jobs", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      await service.startSchedulers();
      await service.shutdown();
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
      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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
          // The Chat launch post gets only the user-authored job prompt.
          launchContext: {
            prompt: "Test prompt",
          },
        })
      );

      await service.completeRunForAgent("agt_job_rename", {
        status: "completed",
        summary: "done",
        tasks: [],
      });
      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
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
      await service.shutdown();
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

      await service.shutdown();
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

      await service.shutdown();
    });
  });

  describe("addJob validation", () => {
    it("rejects invalid cron expression", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await expect(
        service.addJob({
          name: "bad-cron",
          directory: "/tmp/test-bad-cron",
          prompt: "Test",
          schedule: "invalid cron",
        })
      ).rejects.toThrow("invalid cron expression");

      await service.shutdown();
    });

    it("rejects enabled without schedule", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await expect(
        service.addJob({
          name: "no-sched-enabled",
          directory: "/tmp/test-no-sched",
          prompt: "Test",
          enabled: true,
        })
      ).rejects.toThrow("needs a schedule");

      await service.shutdown();
    });

    it("treats empty string schedule as null", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "empty-sched",
        directory: "/tmp/test-empty-sched",
        prompt: "Test",
        schedule: "",
      });

      expect(job.schedule).toBeNull();
      await service.shutdown();
    });

    it("creates a backing template for the job", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "template-test",
        directory: "/tmp/test-template",
        prompt: "My prompt",
        agentType: "codex",
        useWorktree: true,
      });

      expect(job.templateId).toBeTruthy();

      const { rows } = await pool.query(
        "SELECT * FROM templates WHERE id = $1",
        [job.templateId]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].prompt).toBe("My prompt");
      expect(rows[0].agent_type).toBe("codex");
      expect(rows[0].use_worktree).toBe(true);

      await service.shutdown();
    });

    it("uses provided defaults for optional fields", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "defaults-test",
        directory: "/tmp/test-defaults",
        prompt: "p",
        timeoutMs: 60_000,
        needsInputTimeoutMs: 120_000,
        autoArchive: false,
        singleton: false,
        callable: true,
      });

      expect(job.timeoutMs).toBe(60_000);
      expect(job.needsInputTimeoutMs).toBe(120_000);
      expect(job.autoArchive).toBe(false);
      expect(job.singleton).toBe(false);
      expect(job.callable).toBe(true);

      await service.shutdown();
    });
  });

  describe("updateJob validation and logic", () => {
    it("rejects invalid cron on update", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "upd-bad-cron",
        directory: "/tmp/test-upd-cron",
        prompt: "Test",
      });

      await expect(
        service.updateJob({
          name: "upd-bad-cron",
          directory: "/tmp/test-upd-cron",
          schedule: "not a cron",
        })
      ).rejects.toThrow("invalid cron expression");

      await service.shutdown();
    });

    it("rejects enabling without schedule on update", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "upd-no-sched",
        directory: "/tmp/test-upd-no-sched",
        prompt: "Test",
      });

      await expect(
        service.updateJob({
          name: "upd-no-sched",
          directory: "/tmp/test-upd-no-sched",
          enabled: true,
        })
      ).rejects.toThrow("needs a schedule");

      await service.shutdown();
    });

    it("rejects duplicate name on rename", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "original-a",
        directory: "/tmp/test-rename-dup",
        prompt: "A",
      });
      await service.addJob({
        name: "original-b",
        directory: "/tmp/test-rename-dup",
        prompt: "B",
      });

      await expect(
        service.updateJob({
          name: "original-a",
          directory: "/tmp/test-rename-dup",
          displayName: "original-b",
        })
      ).rejects.toThrow("already exists");

      await service.shutdown();
    });

    it("propagates config changes to backing template", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "prop-test",
        directory: "/tmp/test-prop",
        prompt: "Original",
        agentType: "claude",
      });

      await service.updateJob({
        name: "prop-test",
        directory: "/tmp/test-prop",
        prompt: "Updated prompt",
        agentType: "codex",
        fullAccess: true,
      });

      const { rows } = await pool.query(
        "SELECT * FROM templates WHERE id = $1",
        [job.templateId]
      );
      expect(rows[0].prompt).toBe("Updated prompt");
      expect(rows[0].agent_type).toBe("codex");
      expect(rows[0].full_access).toBe(true);

      await service.shutdown();
    });

    it("stops scheduler when disabling via updateJob", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "sched-disable",
        directory: "/tmp/test-sched-dis",
        prompt: "Test",
        schedule: "0 */6 * * *",
        enabled: true,
      });

      const updated = await service.updateJob({
        name: "sched-disable",
        directory: "/tmp/test-sched-dis",
        enabled: false,
      });

      expect(updated.enabled).toBe(false);
      await service.shutdown();
    });
  });

  describe("enableJob / disableJob", () => {
    it("enableJob throws when job has no schedule", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await service.addJob({
        name: "enable-no-sched",
        directory: "/tmp/test-enable-nosched",
        prompt: "Test",
      });

      await expect(
        service.enableJob({
          name: "enable-no-sched",
          directory: "/tmp/test-enable-nosched",
        })
      ).rejects.toThrow("no schedule configured");

      await service.shutdown();
    });

    it("enableJob rejects too-frequent schedule", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "enable-freq",
        directory: "/tmp/test-enable-freq",
        schedule: "* * * * *",
      });

      await expect(
        service.enableJob({
          name: "enable-freq",
          directory: "/tmp/test-enable-freq",
        })
      ).rejects.toThrow();

      await service.shutdown();
    });

    it("enableJob succeeds with valid schedule", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      await makeJob(store, {
        name: "enable-valid",
        directory: "/tmp/test-enable-valid",
        schedule: "0 */6 * * *",
      });

      const updated = await service.enableJob({
        name: "enable-valid",
        directory: "/tmp/test-enable-valid",
      });

      expect(updated.enabled).toBe(true);
      await service.shutdown();
    });

    it("disableJob stops scheduler and marks disabled", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "disable-test",
        directory: "/tmp/test-disable",
        schedule: "0 */6 * * *",
      });
      await store.updateJobConfig(job.id, { enabled: true });

      const updated = await service.disableJob({
        name: "disable-test",
        directory: "/tmp/test-disable",
      });

      expect(updated.enabled).toBe(false);
      await service.shutdown();
    });
  });

  describe("removeJob", () => {
    it("removes job and cleans up backing template", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const job = await service.addJob({
        name: "remove-clean",
        directory: "/tmp/test-remove-clean",
        prompt: "Test",
      });
      const templateId = job.templateId!;

      const removed = await service.removeJob({
        name: "remove-clean",
        directory: "/tmp/test-remove-clean",
      });

      expect(removed.id).toBe(job.id);

      const { rows } = await pool.query(
        "SELECT * FROM templates WHERE id = $1",
        [templateId]
      );
      expect(rows.length).toBe(0);

      await service.shutdown();
    });

    it("throws for non-existent job", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await expect(
        service.removeJob({
          name: "ghost",
          directory: "/tmp/test-ghost",
        })
      ).rejects.toThrow("not found");

      await service.shutdown();
    });
  });

  describe("runJob singleton enforcement", () => {
    it("throws when singleton job already has active run", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "singleton-test",
        directory: "/tmp/test-singleton",
      });

      await store.createRun(job.id, {
        ...makeRunConfig("singleton-test"),
        triggerSource: "manual",
        autoArchive: true,
      });

      await expect(
        service.runJob({
          name: "singleton-test",
          directory: "/tmp/test-singleton",
        })
      ).rejects.toThrow("already has active run");

      await service.shutdown();
    });
  });

  describe("runJob crash on agent spawn", () => {
    it("marks run as crashed when agent creation fails", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      await makeJob(store, {
        name: "crash-spawn",
        directory: "/tmp/test-crash",
      });

      vi.mocked(mockAgentManager.createAgent).mockRejectedValue(
        new Error("tmux exploded")
      );

      await expect(
        service.runJob({
          name: "crash-spawn",
          directory: "/tmp/test-crash",
        })
      ).rejects.toThrow("failed to start: tmux exploded");

      const runs = await store.listRunsForJob(
        (await store.getJobByDirectoryAndName(
          "/tmp/test-crash",
          "crash-spawn"
        ))!.id
      );
      expect(runs[0].status).toBe("crashed");

      await service.shutdown();
    });
  });

  describe("listRunsForJob", () => {
    it("returns job and runs", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );
      const store = new JobStore(pool);

      const job = await makeJob(store, {
        name: "list-runs",
        directory: "/tmp/test-list-runs",
      });
      await store.createRun(job.id, {
        ...makeRunConfig("list-runs"),
        triggerSource: "manual",
        autoArchive: true,
      });

      const result = await service.listRunsForJob({
        name: "list-runs",
        directory: "/tmp/test-list-runs",
      });

      expect(result.job.id).toBe(job.id);
      expect(result.runs.length).toBe(1);

      await service.shutdown();
    });

    it("throws for non-existent job", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      await expect(
        service.listRunsForJob({
          name: "nope",
          directory: "/tmp/nope",
        })
      ).rejects.toThrow("not found");

      await service.shutdown();
    });
  });

  describe("getStats", () => {
    it("returns stats and recent runs", async () => {
      const service = new JobService(
        pool,
        mockAgentManager,
        mockLog,
        mockConfig
      );

      const result = await service.getStats();

      expect(result).toHaveProperty("stats");
      expect(result).toHaveProperty("recentRuns");
      expect(result.stats).toHaveProperty("totalRuns");
      expect(result.stats).toHaveProperty("successCount");
      expect(result.stats).toHaveProperty("failureCount");
      expect(result.stats).toHaveProperty("daily");
      expect(Array.isArray(result.recentRuns)).toBe(true);

      await service.shutdown();
    });
  });
});
