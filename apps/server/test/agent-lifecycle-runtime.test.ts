import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentLifecycleRuntime } from "../src/server/agent-lifecycle-runtime.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentManager: {
      beginArchive: vi.fn().mockResolvedValue({ id: "agt_1", name: "a1" }),
      executeArchive: vi.fn().mockReturnValue(new Promise(() => {})),
      reconcileAgentStatuses: vi.fn().mockResolvedValue([]),
      ...((overrides.agentManager as Record<string, unknown>) ?? {}),
    },
    streamManager: {
      stopStream: vi.fn(),
      ...((overrides.streamManager as Record<string, unknown>) ?? {}),
    },
    appLog: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    reconcileIntervalMs: 60_000,
    activityMonitor: (overrides.activityMonitor as never) ?? undefined,
    withStreamFlag: vi.fn(
      (agent: Record<string, unknown>) =>
        ({ ...agent, hasStream: false }) as never
    ),
    publishUiEvent: vi.fn(),
  };
}

describe("createAgentLifecycleRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("beginBackgroundArchive", () => {
    it("claims the archive and returns without awaiting teardown", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      // executeArchive never resolves in makeDeps, so returning at all proves
      // the caller is not blocked on teardown.
      const agent = await rt.beginBackgroundArchive("agt_1", "keep");

      expect(deps.agentManager.beginArchive).toHaveBeenCalledWith(
        "agt_1",
        "keep"
      );
      expect(agent).toMatchObject({ id: "agt_1" });
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({ id: "agt_1", hasStream: false }),
      });
      expect(deps.agentManager.executeArchive).toHaveBeenCalled();
    });

    it("waits for startAfter before beginning teardown", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      await rt.beginBackgroundArchive("agt_1", "auto", {
        startAfter: () => gate,
      });
      await Promise.resolve();
      expect(deps.agentManager.executeArchive).not.toHaveBeenCalled();

      release();
      await gate;
      await Promise.resolve();
      expect(deps.agentManager.executeArchive).toHaveBeenCalledWith(
        "agt_1",
        expect.any(Object)
      );
    });

    it("propagates a failed claim instead of scheduling teardown", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi
            .fn()
            .mockRejectedValue(new Error("Agent is already being archived.")),
          executeArchive: vi.fn(),
          reconcileAgentStatuses: vi.fn(),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);

      await expect(rt.beginBackgroundArchive("agt_1")).rejects.toThrow(
        "already being archived"
      );
      expect(deps.agentManager.executeArchive).not.toHaveBeenCalled();
    });

    it("swallows a rejecting teardown so no unhandled rejection escapes", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn().mockResolvedValue({ id: "agt_1", name: "a1" }),
          executeArchive: vi
            .fn()
            .mockRejectedValue(new Error("archive blew up")),
          reconcileAgentStatuses: vi.fn(),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);

      await rt.beginBackgroundArchive("agt_1");
      await rt.waitForActiveArchives(1_000);

      expect(deps.appLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), agentId: "agt_1" }),
        "Background archive failed"
      );
    });
  });

  describe("autoArchiveJobAgent", () => {
    it("calls beginArchive and executeArchive for a new agent", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");

      expect(deps.agentManager.beginArchive).toHaveBeenCalledWith(
        "agt_1",
        "auto"
      );
      expect(deps.agentManager.executeArchive).toHaveBeenCalledWith(
        "agt_1",
        expect.objectContaining({
          onPhaseChange: expect.any(Function),
          onComplete: expect.any(Function),
          onError: expect.any(Function),
        })
      );
    });

    it("publishes agent.upsert after beginArchive", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");

      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({ id: "agt_1", hasStream: false }),
      });
    });

    it("skips if agent is already being archived (dedup guard)", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");
      await rt.autoArchiveJobAgent("agt_1");

      expect(deps.agentManager.beginArchive).toHaveBeenCalledTimes(1);
    });

    it("catches beginArchive errors and logs a warning", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn().mockRejectedValue(new Error("db down")),
          executeArchive: vi.fn(),
          reconcileAgentStatuses: vi.fn(),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");

      expect(deps.appLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "agt_1" }),
        "Auto-archive of job agent failed"
      );
      expect(deps.agentManager.executeArchive).not.toHaveBeenCalled();
    });

    it("onComplete callback publishes agent.deleted and cleans up tracking", async () => {
      let capturedOnComplete!: (deletedIds: string[]) => void;
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn().mockResolvedValue({ id: "agt_1", name: "a1" }),
          executeArchive: vi.fn((_id, opts) => {
            capturedOnComplete = opts.onComplete;
            return new Promise(() => {});
          }),
          reconcileAgentStatuses: vi.fn(),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");

      capturedOnComplete(["agt_1", "agt_child"]);

      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.deleted",
        agentId: "agt_1",
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.deleted",
        agentId: "agt_child",
      });

      // After onComplete, a second archive should be allowed (dedup cleared)
      deps.agentManager.beginArchive.mockResolvedValue({
        id: "agt_1",
        name: "a1",
      });
      await rt.autoArchiveJobAgent("agt_1");
      expect(deps.agentManager.beginArchive).toHaveBeenCalledTimes(2);
    });

    it("onError callback cleans up tracking so re-archive is possible", async () => {
      let capturedOnError!: () => void;
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn().mockResolvedValue({ id: "agt_1", name: "a1" }),
          executeArchive: vi.fn((_id, opts) => {
            capturedOnError = opts.onError;
            return new Promise(() => {});
          }),
          reconcileAgentStatuses: vi.fn(),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");
      capturedOnError();

      deps.agentManager.beginArchive.mockResolvedValue({
        id: "agt_1",
        name: "a1",
      });
      await rt.autoArchiveJobAgent("agt_1");
      expect(deps.agentManager.beginArchive).toHaveBeenCalledTimes(2);
    });

    it("onPhaseChange callback publishes agent.upsert", async () => {
      let capturedOnPhaseChange!: (updated: Record<string, unknown>) => void;
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn().mockResolvedValue({ id: "agt_1", name: "a1" }),
          executeArchive: vi.fn((_id, opts) => {
            capturedOnPhaseChange = opts.onPhaseChange;
            return new Promise(() => {});
          }),
          reconcileAgentStatuses: vi.fn(),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.autoArchiveJobAgent("agt_1");
      deps.publishUiEvent.mockClear();

      capturedOnPhaseChange({ id: "agt_1", name: "a1", phase: "worktree" });

      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({ id: "agt_1", phase: "worktree" }),
      });
    });
  });

  describe("startReconcileLoop / stopReconcileLoop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("calls runAgentStatusReconciliation on the interval", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.startReconcileLoop();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.agentManager.reconcileAgentStatuses).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.agentManager.reconcileAgentStatuses).toHaveBeenCalledTimes(2);

      rt.stopReconcileLoop();
    });

    it("is idempotent — calling startReconcileLoop twice does not create a second timer", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.startReconcileLoop();
      rt.startReconcileLoop();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.agentManager.reconcileAgentStatuses).toHaveBeenCalledTimes(1);

      rt.stopReconcileLoop();
    });

    it("stopReconcileLoop is safe to call when no timer is running", () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.stopReconcileLoop();
    });

    it("stopReconcileLoop prevents further ticks", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.startReconcileLoop();
      rt.stopReconcileLoop();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(deps.agentManager.reconcileAgentStatuses).not.toHaveBeenCalled();
    });

    it("logs a warning when reconciliation throws", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn(),
          executeArchive: vi.fn(),
          reconcileAgentStatuses: vi
            .fn()
            .mockRejectedValue(new Error("db fail")),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.startReconcileLoop();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.appLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "Agent status reconciliation failed."
      );

      rt.stopReconcileLoop();
    });
  });

  describe("runAgentStatusReconciliation", () => {
    it("publishes agent.upsert for stopped agents", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn(),
          executeArchive: vi.fn(),
          reconcileAgentStatuses: vi
            .fn()
            .mockResolvedValue([
              { id: "agt_2", name: "stopped-agent", status: "stopped" },
            ]),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();

      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({ id: "agt_2", status: "stopped" }),
      });
    });

    it("resumes interrupted archives for archiving agents", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn(),
          executeArchive: vi.fn().mockReturnValue(new Promise(() => {})),
          reconcileAgentStatuses: vi
            .fn()
            .mockResolvedValue([
              { id: "agt_3", name: "archive-agent", status: "archiving" },
            ]),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();

      expect(deps.agentManager.executeArchive).toHaveBeenCalledWith(
        "agt_3",
        expect.objectContaining({
          onPhaseChange: expect.any(Function),
          onComplete: expect.any(Function),
          onError: expect.any(Function),
        })
      );
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.upsert",
        agent: expect.objectContaining({ id: "agt_3", status: "archiving" }),
      });
    });

    it("skips archiving agents that are already tracked", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn().mockResolvedValue({ id: "agt_4", name: "agt" }),
          executeArchive: vi.fn().mockReturnValue(new Promise(() => {})),
          reconcileAgentStatuses: vi
            .fn()
            .mockResolvedValue([
              { id: "agt_4", name: "agt", status: "archiving" },
            ]),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);

      // First archive via autoArchiveJobAgent puts agt_4 in the tracking set
      await rt.autoArchiveJobAgent("agt_4");
      deps.agentManager.executeArchive.mockClear();

      // Reconciliation should skip agt_4 since it's already being archived
      await rt.runAgentStatusReconciliation();
      expect(deps.agentManager.executeArchive).not.toHaveBeenCalled();
    });

    it("resumed archive onComplete stops streams and publishes deleted events", async () => {
      let capturedOnComplete!: (deletedIds: string[]) => void;
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn(),
          executeArchive: vi.fn((_id, opts) => {
            capturedOnComplete = opts.onComplete;
            return new Promise(() => {});
          }),
          reconcileAgentStatuses: vi
            .fn()
            .mockResolvedValue([
              { id: "agt_5", name: "arch", status: "archiving" },
            ]),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();
      deps.publishUiEvent.mockClear();

      capturedOnComplete(["agt_5", "agt_5_child"]);

      expect(deps.streamManager.stopStream).toHaveBeenCalledWith("agt_5");
      expect(deps.streamManager.stopStream).toHaveBeenCalledWith("agt_5_child");
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.deleted",
        agentId: "agt_5",
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.deleted",
        agentId: "agt_5_child",
      });
    });

    it("resumed archive onError logs an error", async () => {
      let capturedOnError!: (error: unknown) => void;
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn(),
          executeArchive: vi.fn((_id, opts) => {
            capturedOnError = opts.onError;
            return new Promise(() => {});
          }),
          reconcileAgentStatuses: vi
            .fn()
            .mockResolvedValue([
              { id: "agt_6", name: "arch-err", status: "archiving" },
            ]),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();

      capturedOnError(new Error("disk full"));

      expect(deps.appLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          agentId: "agt_6",
        }),
        "Resumed archive failed"
      );
    });

    it("catches reconciliation errors and logs a warning", async () => {
      const deps = makeDeps({
        agentManager: {
          beginArchive: vi.fn(),
          executeArchive: vi.fn(),
          reconcileAgentStatuses: vi
            .fn()
            .mockRejectedValue(new Error("db err")),
        },
      });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();

      expect(deps.appLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "Agent status reconciliation failed."
      );
    });

    it("calls activityMonitor.check() when provided", async () => {
      const mockCheck = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ activityMonitor: { check: mockCheck } });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();

      expect(mockCheck).toHaveBeenCalledTimes(1);
    });

    it("catches activityMonitor errors and logs a warning", async () => {
      const mockCheck = vi.fn().mockRejectedValue(new Error("tmux fail"));
      const deps = makeDeps({ activityMonitor: { check: mockCheck } });
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();

      expect(deps.appLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "Activity monitor check failed."
      );
    });

    it("skips activityMonitor when not provided", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      await rt.runAgentStatusReconciliation();
      // No error means the undefined activityMonitor path is handled
    });
  });

  describe("onArchivedAgentsDeleted", () => {
    it("stops streams and publishes agent.deleted for each ID", () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.onArchivedAgentsDeleted(["agt_a", "agt_b"]);

      expect(deps.streamManager.stopStream).toHaveBeenCalledWith("agt_a");
      expect(deps.streamManager.stopStream).toHaveBeenCalledWith("agt_b");
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.deleted",
        agentId: "agt_a",
      });
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "agent.deleted",
        agentId: "agt_b",
      });
    });
  });

  describe("onArchiveError", () => {
    it("logs the error with agent context", () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);
      rt.onArchiveError("agt_x", new Error("boom"));

      expect(deps.appLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          agentId: "agt_x",
        }),
        "Background archive failed"
      );
    });
  });

  describe("trackArchivePromise", () => {
    it("tracks the promise so waitForActiveArchives can await it", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      let resolveArchive!: () => void;
      const archivePromise = new Promise<void>((r) => {
        resolveArchive = r;
      });
      rt.trackArchivePromise("agt_t", archivePromise);

      // waitForActiveArchives should not resolve immediately
      let waited = false;
      const waitPromise = rt.waitForActiveArchives(5_000).then(() => {
        waited = true;
      });

      // Resolve the archive
      resolveArchive();
      await waitPromise;
      expect(waited).toBe(true);
    });

    it("prevents duplicate autoArchiveJobAgent calls for the tracked agent", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      rt.trackArchivePromise("agt_1", new Promise(() => {}));
      await rt.autoArchiveJobAgent("agt_1");

      expect(deps.agentManager.beginArchive).not.toHaveBeenCalled();
    });
  });

  describe("waitForActiveArchives", () => {
    it("resolves immediately when no archives are active", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      const start = Date.now();
      await rt.waitForActiveArchives(5_000);
      expect(Date.now() - start).toBeLessThan(100);
    });

    it("resolves when all archives complete before timeout", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      let resolveArchive!: () => void;
      const archivePromise = new Promise<void>((r) => {
        resolveArchive = r;
      });
      rt.trackArchivePromise("agt_w", archivePromise);

      setTimeout(() => resolveArchive(), 50);
      await rt.waitForActiveArchives(5_000);

      expect(deps.appLog.info).toHaveBeenCalledWith(
        { count: 1 },
        "Waiting for in-flight archives to complete…"
      );
    });

    it("resolves after timeout when archives are slow", async () => {
      const deps = makeDeps();
      const rt = createAgentLifecycleRuntime(deps as never);

      rt.trackArchivePromise("agt_slow", new Promise(() => {}));

      const start = Date.now();
      await rt.waitForActiveArchives(100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(500);
    });
  });
});
