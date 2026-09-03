import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "../db/setup.js";
import { JobService } from "../../src/jobs/service.js";
import { JobStore } from "../../src/jobs/store.js";
import type { AgentManager } from "../../src/agents/manager.js";

let pool: Pool;

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
  silent: vi.fn(),
  level: "debug",
} as unknown as import("fastify").FastifyBaseLogger;

const agents = {
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(async () => []),
} as unknown as AgentManager;

const config = {
  agentRuntime: "inert",
  host: "127.0.0.1",
  port: 6767,
} as const;

async function addAgent(id: string) {
  await pool.query(
    `INSERT INTO agents (id, name, type, status, cwd, codex_args, full_access)
     VALUES ($1, $1, 'claude', 'running', '/tmp', '[]'::jsonb, false)`,
    [id]
  );
}

async function job(
  overrides: Partial<Parameters<JobStore["createJob"]>[0]> = {}
) {
  return new JobStore(pool).createJob({
    name: `continuation-${Math.random().toString(36).slice(2)}`,
    directory: "/tmp/continuation",
    prompt: "Continue the work.",
    schedule: null,
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
    enabled: true,
    continuationEnabled: true,
    maxIterations: 10,
    ...overrides,
  });
}

function runConfig(name: string, iteration = 1) {
  return {
    directory: "/tmp/continuation",
    name,
    schedule: null,
    timeoutMs: 30_000,
    needsInputTimeoutMs: 30_000,
    notify: { onComplete: [], onError: [], onNeedsInput: [] },
    triggerSource: "manual" as const,
    chainId: "chain-1",
    iteration,
  };
}

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => teardownTestDb());

beforeEach(async () => {
  await pool.query("DELETE FROM job_runs");
  await pool.query("DELETE FROM jobs");
  await pool.query("DELETE FROM agents WHERE id LIKE 'agt_cont_%'");
  vi.mocked(agents.createAgent).mockReset();
  // An unstubbed getAgent resolves undefined, which JobService reads as a dead
  // session: its background monitor then marks a freshly launched run crashed
  // on its first poll, racing whatever the test does next. Mirror
  // service.test.ts and hand back a live agent so the inert runtime short-
  // circuit keeps the monitor idle.
  vi.mocked(agents.getAgent).mockResolvedValue({
    id: "mock",
    status: "running",
    tmuxSession: null,
  } as Awaited<ReturnType<AgentManager["getAgent"]>>);
});

describe("continuation jobs", () => {
  it("arms without cron, defaults to ten, and exposes its complete list shape", async () => {
    const service = new JobService(pool, agents, logger, config);
    const created = await service.addJob({
      name: "armed-no-cron",
      directory: "/tmp/armed-no-cron",
      prompt: "work",
      enabled: true,
      continuationEnabled: true,
      completionCriteria: ["done"],
      recoveryInstructions: "try once",
    });
    expect(created).toMatchObject({
      enabled: true,
      schedule: null,
      continuationEnabled: true,
      maxIterations: 10,
      autoArchive: true,
    });
    const listed = (await service.listJobs()).find(
      (entry) => entry.id === created.id
    );
    expect(listed).toMatchObject({
      continuationEnabled: true,
      maxIterations: 10,
      completionCriteria: ["done"],
      recoveryInstructions: "try once",
      continuationPending: false,
      lastRunChainId: null,
      lastRunIteration: null,
    });
    await service.shutdown();
  });

  it("allows an unlimited cap and preserves cron alongside continuation", async () => {
    const service = new JobService(pool, agents, logger, config);
    const created = await service.addJob({
      name: "unlimited",
      directory: "/tmp/unlimited",
      prompt: "work",
      schedule: "0 * * * *",
      enabled: true,
      continuationEnabled: true,
      maxIterations: null,
    });
    expect(created).toMatchObject({
      schedule: "0 * * * *",
      maxIterations: null,
      continuationEnabled: true,
    });
    await service.shutdown();
  });

  it("continues only after completion, increments iterations, and blocks a second Run now", async () => {
    const store = new JobStore(pool);
    const record = await job();
    const first = await store.createRun(record.id, runConfig(record.name));
    await addAgent("agt_cont_first");
    await store.attachAgent(first.id, "agt_cont_first");
    const completed = await store.completeRunForAgent("agt_cont_first", {
      status: "completed",
      summary: "keep going",
      tasks: [],
      continuation: {
        action: "continue",
        summary: "next",
        nextIntent: "Start the next slice.",
      },
    });
    expect(completed.continuationPending).toBe(true);

    const service = new JobService(pool, agents, logger, config);
    await expect(
      service.runJob({ name: record.name, directory: record.directory })
    ).rejects.toThrow("pending continuation");
    await addAgent("agt_cont_second");
    vi.mocked(agents.createAgent).mockResolvedValue({
      id: "agt_cont_second",
    } as never);
    const successor = await service.launchPendingContinuation(first.id);
    expect(successor).toMatchObject({
      agentId: "agt_cont_second",
      status: "running",
    });
    const runs = await store.listRunsForJob(record.id);
    const second = runs.find((run) => run.id === successor!.runId)!;
    expect(second).toMatchObject({ chainId: "chain-1", chainIteration: 2 });
    expect(second.config).toMatchObject({
      triggerSource: "continuation",
      continuationOfRunId: first.id,
      recoveryAttempt: 0,
    });
    await service.shutdown();
  });

  it("requires a next intent before starting another Loop run", async () => {
    const store = new JobStore(pool);
    const record = await job();
    const run = await store.createRun(record.id, runConfig(record.name));
    await addAgent("agt_cont_missing_intent");
    await store.attachAgent(run.id, "agt_cont_missing_intent");

    await expect(
      store.completeRunForAgent("agt_cont_missing_intent", {
        status: "completed",
        summary: "work finished",
        tasks: [],
        continuation: { action: "continue" },
      })
    ).rejects.toThrow("nextIntent is required");
    expect(await store.getRun(run.id)).toMatchObject({
      status: "running",
      continuationPending: false,
    });
  });

  it("atomically admits one concurrent root run and arms a manual continuation", async () => {
    const store = new JobStore(pool);
    const record = await job({ enabled: false });
    const results = await Promise.allSettled([
      store.createRun(record.id, runConfig(record.name)),
      store.createRun(record.id, runConfig(record.name)),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect((await store.getJob(record.id))!.enabled).toBe(true);
    expect(await store.listRunsForJob(record.id)).toHaveLength(1);
  });

  it("pauses, finishes, caps, and disables pending continuation work", async () => {
    const store = new JobStore(pool);
    const capped = await job({ maxIterations: 1 });
    const capRun = await store.createRun(capped.id, runConfig(capped.name));
    await addAgent("agt_cont_cap");
    await store.attachAgent(capRun.id, "agt_cont_cap");
    expect(
      (
        await store.completeRunForAgent("agt_cont_cap", {
          status: "completed",
          summary: "done",
          tasks: [],
        })
      ).continuationPending
    ).toBe(false);
    expect((await store.getJob(capped.id))!.enabled).toBe(true);

    const paused = await job();
    const pauseRun = await store.createRun(paused.id, runConfig(paused.name));
    await addAgent("agt_cont_pause");
    await store.attachAgent(pauseRun.id, "agt_cont_pause");
    expect(
      (
        await store.completeRunForAgent("agt_cont_pause", {
          status: "completed",
          summary: "pause",
          tasks: [],
          continuation: { action: "pause" },
        })
      ).continuationPending
    ).toBe(false);

    const finished = await job();
    const finishRun = await store.createRun(
      finished.id,
      runConfig(finished.name)
    );
    await addAgent("agt_cont_finish");
    await store.attachAgent(finishRun.id, "agt_cont_finish");
    await store.completeRunForAgent("agt_cont_finish", {
      status: "completed",
      summary: "finish",
      tasks: [],
      continuation: { action: "finish" },
    });
    expect((await store.getJob(finished.id))!.enabled).toBe(false);

    const pending = await job();
    const pendingRun = await store.createRun(
      pending.id,
      runConfig(pending.name)
    );
    await addAgent("agt_cont_pending");
    await store.attachAgent(pendingRun.id, "agt_cont_pending");
    await store.completeRunForAgent("agt_cont_pending", {
      status: "completed",
      summary: "next",
      tasks: [],
      continuation: { action: "continue", nextIntent: "Continue the work." },
    });
    await store.updateJobConfig(pending.id, { continuationEnabled: false });
    expect((await store.getRun(pendingRun.id))!.continuationPending).toBe(
      false
    );

    const disabled = await job();
    const disabledRun = await store.createRun(
      disabled.id,
      runConfig(disabled.name)
    );
    await store.markCrashed(disabledRun.id, {
      status: "failed",
      summary: "crashed",
      tasks: [],
    });
    await store.updateJobConfig(disabled.id, { enabled: false });
    expect(await store.scheduleRecovery(disabledRun.id)).toBeNull();
  });

  it("seeds exactly one same-iteration recovery and never retries job_failed", async () => {
    const store = new JobStore(pool);
    const record = await job();
    const crash = await store.createRun(record.id, runConfig(record.name, 4));
    await store.markCrashed(crash.id, {
      status: "failed",
      summary: "crashed",
      tasks: [],
    });
    expect((await store.scheduleRecovery(crash.id))!.continuationPending).toBe(
      true
    );

    const handoff = await store.startPendingContinuation(crash.id, {
      ...runConfig(record.name, 4),
      triggerSource: "continuation",
      continuationOfRunId: crash.id,
      recoveryAttempt: 1,
    });
    const recovered = (await store.getRun(handoff!.successor.id))!;
    expect(recovered).toMatchObject({ chainId: "chain-1", chainIteration: 4 });
    expect(recovered.config).toMatchObject({
      recoveryAttempt: 1,
      continuationOfRunId: crash.id,
    });
    expect((await store.getRun(crash.id))!.continuationPending).toBe(false);

    // A recovery attempt that crashes in turn is the end of the chain.
    await store.markCrashed(recovered.id, {
      status: "failed",
      summary: "crashed again",
      tasks: [],
    });
    expect(await store.scheduleRecovery(recovered.id)).toBeNull();

    const failed = await store.createRun(record.id, runConfig(record.name, 5));
    await addAgent("agt_cont_failed");
    await store.attachAgent(failed.id, "agt_cont_failed");
    await store.failRunForAgent("agt_cont_failed", {
      status: "failed",
      summary: "agent failed",
      tasks: [],
    });
    expect(await store.scheduleRecovery(failed.id)).toBeNull();
  });

  it("launches the recovery successor at the same iteration with its own agent", async () => {
    const store = new JobStore(pool);
    const record = await job();
    const crash = await store.createRun(record.id, runConfig(record.name, 4));
    await store.markCrashed(crash.id, {
      status: "failed",
      summary: "crashed",
      tasks: [],
    });
    await store.scheduleRecovery(crash.id);

    const service = new JobService(pool, agents, logger, config);
    await addAgent("agt_cont_recovery");
    vi.mocked(agents.createAgent).mockResolvedValue({
      id: "agt_cont_recovery",
    } as never);
    const successor = await service.launchPendingContinuation(crash.id);
    expect(successor).toMatchObject({
      agentId: "agt_cont_recovery",
      status: "running",
    });
    const recovered = (await store.getRun(successor!.runId))!;
    expect(recovered).toMatchObject({
      chainId: "chain-1",
      chainIteration: 4,
      agentId: "agt_cont_recovery",
    });
    expect(recovered.config).toMatchObject({
      triggerSource: "continuation",
      recoveryAttempt: 1,
      continuationOfRunId: crash.id,
    });

    // launchPendingContinuation leaves a monitor polling the successor. Settle
    // it here and drain the monitor in shutdown so nothing writes to this run
    // after the test returns.
    await store.completeRunForAgent("agt_cont_recovery", {
      status: "completed",
      summary: "recovered",
      tasks: [],
      continuation: { action: "pause" },
    });
    await service.shutdown();
    expect((await store.getRun(recovered.id))!.status).toBe("completed");
  });

  it("keeps one predecessor barrier during a failed successor launch and pauses it after the retry fails", async () => {
    const store = new JobStore(pool);
    const record = await job();
    const predecessor = await store.createRun(
      record.id,
      runConfig(record.name, 3)
    );
    await store.markCrashed(predecessor.id, {
      status: "failed",
      summary: "infrastructure crash",
      tasks: [],
    });
    await store.scheduleRecovery(predecessor.id);

    const service = new JobService(pool, agents, logger, config);
    vi.mocked(agents.createAgent).mockRejectedValue(new Error("spawn failed"));
    await expect(
      service.launchPendingContinuation(predecessor.id)
    ).rejects.toThrow("spawn failed");

    const storedPredecessor = (await store.getRun(predecessor.id))!;
    const runs = await store.listRunsForJob(record.id);
    const successors = runs.filter((run) => run.id !== predecessor.id);
    expect(storedPredecessor).toMatchObject({
      continuationPending: false,
      continuationRetries: 2,
    });
    expect(successors).toHaveLength(2);
    expect(successors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "crashed",
          continuationPending: false,
          chainIteration: 3,
        }),
      ])
    );
    expect(runs.filter((run) => run.continuationPending)).toHaveLength(0);
    await service.shutdown();
  });

  it("cancels an unattached successor reservation when disabled", async () => {
    const store = new JobStore(pool);
    const record = await job();
    const predecessor = await store.createRun(
      record.id,
      runConfig(record.name)
    );
    await store.markCrashed(predecessor.id, {
      status: "failed",
      summary: "crashed",
      tasks: [],
    });
    await store.scheduleRecovery(predecessor.id);
    const reserved = await store.startPendingContinuation(predecessor.id, {
      ...runConfig(record.name, 1),
      triggerSource: "continuation",
      continuationOfRunId: predecessor.id,
    });
    expect(reserved?.successor.agentId).toBeNull();
    await store.setEnabled(record.id, false);
    expect((await store.getRun(reserved!.successor.id))?.status).toBe(
      "crashed"
    );
  });

  it("writes the durable Brain handoff after persisting the terminal continuation barrier", async () => {
    const store = new JobStore(pool);
    const record = await job({ directory: process.cwd() });
    const run = await store.createRun(record.id, runConfig(record.name));
    await addAgent("agt_cont_brain");
    await store.attachAgent(run.id, "agt_cont_brain");
    let stateWhenStored: Awaited<ReturnType<JobStore["getRun"]>>;
    const brainStore = {
      getObject: vi.fn().mockResolvedValue(null),
      storeObject: vi.fn(async () => {
        stateWhenStored = await store.getRun(run.id);
        return {};
      }),
    };
    const service = new JobService(
      pool,
      agents,
      logger,
      config,
      brainStore as never
    );

    await service.completeRunForAgent("agt_cont_brain", {
      status: "completed",
      summary: "handoff ready",
      tasks: [],
      continuation: {
        action: "continue",
        summary: "next",
        nextIntent: "Start the next slice.",
      },
    });

    expect(stateWhenStored).toMatchObject({
      status: "completed",
      continuationPending: true,
    });
    expect(brainStore.storeObject).toHaveBeenCalledWith(
      expect.any(String),
      "agt_cont_brain",
      expect.objectContaining({
        collection: "job-continuations",
        name: `job-${record.id}`,
      })
    );
    await service.shutdown();
  });

  it("retries a deferred Brain handoff with deduped backoff", async () => {
    const service = new JobService(pool, agents, logger, config);
    const retry = vi
      .spyOn(service, "launchPendingContinuation")
      .mockRejectedValue(new Error("temporary Brain outage"));
    vi.useFakeTimers();
    try {
      const run = {
        id: "brain-retry-run",
        jobId: "brain-retry-job",
        continuationPending: true,
      };
      (
        service as never as { scheduleBrainRetry(run: unknown): void }
      ).scheduleBrainRetry(run);
      (
        service as never as { scheduleBrainRetry(run: unknown): void }
      ).scheduleBrainRetry(run);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    await service.shutdown();
  });

  it("accepts per-run worktrees on create and on update", async () => {
    const service = new JobService(pool, agents, logger, config);
    const created = await service.addJob({
      name: "loop-worktree",
      directory: "/tmp/loop-worktree",
      prompt: "work",
      continuationEnabled: true,
      useWorktree: true,
      baseBranch: "main",
      branchName: "loop-branch",
    });
    expect(created).toMatchObject({
      continuationEnabled: true,
      useWorktree: true,
      baseBranch: "main",
      branchName: "loop-branch",
    });

    // Turning the loop on for a job that already runs in a worktree is the
    // other order the same combination can be reached.
    const ordinary = await service.addJob({
      name: "ordinary-worktree",
      directory: "/tmp/ordinary-worktree",
      prompt: "work",
      schedule: "0 * * * *",
      useWorktree: true,
      enabled: true,
    });
    expect(ordinary).toMatchObject({
      useWorktree: true,
      continuationEnabled: false,
      enabled: true,
    });
    const looped = await service.updateJob({
      name: "ordinary-worktree",
      directory: "/tmp/ordinary-worktree",
      continuationEnabled: true,
    });
    expect(looped).toMatchObject({
      useWorktree: true,
      continuationEnabled: true,
    });
    await service.shutdown();
  });

  it("gives a continuation successor its own worktree agent", async () => {
    const store = new JobStore(pool);
    const record = await job({
      useWorktree: true,
      baseBranch: "main",
      branchName: null,
    });
    const first = await store.createRun(record.id, runConfig(record.name, 1));
    await addAgent("agt_cont_worktree_1");
    await store.attachAgent(first.id, "agt_cont_worktree_1");
    await store.completeRunForAgent("agt_cont_worktree_1", {
      status: "completed",
      summary: "iteration one",
      tasks: [],
      continuation: { action: "continue", nextIntent: "keep going" },
    });

    const service = new JobService(pool, agents, logger, config);
    await addAgent("agt_cont_worktree_2");
    vi.mocked(agents.createAgent).mockResolvedValue({
      id: "agt_cont_worktree_2",
    } as never);
    const successor = await service.launchPendingContinuation(first.id);
    expect(successor).toMatchObject({ agentId: "agt_cont_worktree_2" });
    expect(vi.mocked(agents.createAgent).mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/continuation",
      useWorktree: true,
      baseBranch: "main",
      launchContext: {
        prompt: expect.stringContaining("Continuation chain: chain-1"),
      },
      // No stored branch name, so each iteration gets its own generated branch
      // rather than colliding with the previous iteration's.
      worktreeBranch: undefined,
    });
    const successorRun = (await store.getRun(successor!.runId))!;
    expect(successorRun).toMatchObject({
      chainId: "chain-1",
      chainIteration: 2,
    });

    await store.completeRunForAgent("agt_cont_worktree_2", {
      status: "completed",
      summary: "iteration two",
      tasks: [],
      continuation: { action: "finish" },
    });
    await service.shutdown();
  });

  it("hands a successor the job's stored branch name unchanged", async () => {
    // A stored branch name reaches every iteration verbatim, so a fixed name
    // means iteration 2 asks git for a branch and worktree path that already
    // exist and the chain stops. That is the same dead end an ordinary
    // scheduled job with a fixed branch name hits on its second run — the
    // name is the user's, and neither job type rewrites it. Pinned here so a
    // future change to that rule is deliberate rather than incidental.
    const store = new JobStore(pool);
    const record = await job({
      useWorktree: true,
      baseBranch: "main",
      branchName: "pinned-branch",
    });
    const first = await store.createRun(record.id, runConfig(record.name, 1));
    await addAgent("agt_cont_pinned_1");
    await store.attachAgent(first.id, "agt_cont_pinned_1");
    await store.completeRunForAgent("agt_cont_pinned_1", {
      status: "completed",
      summary: "iteration one",
      tasks: [],
      continuation: { action: "continue", nextIntent: "keep going" },
    });

    const service = new JobService(pool, agents, logger, config);
    await addAgent("agt_cont_pinned_2");
    vi.mocked(agents.createAgent).mockResolvedValue({
      id: "agt_cont_pinned_2",
    } as never);
    const successor = await service.launchPendingContinuation(first.id);
    expect(vi.mocked(agents.createAgent).mock.calls[0]?.[0]).toMatchObject({
      useWorktree: true,
      worktreeBranch: "pinned-branch",
    });

    await store.completeRunForAgent("agt_cont_pinned_2", {
      status: "completed",
      summary: "iteration two",
      tasks: [],
      continuation: { action: "finish" },
    });
    expect(successor).toMatchObject({ agentId: "agt_cont_pinned_2" });
    await service.shutdown();
  });
});
