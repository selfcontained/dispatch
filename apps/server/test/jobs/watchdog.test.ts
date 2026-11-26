import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../../src/jobs/service.js";

function fixture() {
  const run = {
    id: "run",
    agentId: "agent",
    status: "running",
    startedAt: new Date().toISOString(),
    statusUpdatedAt: new Date().toISOString(),
    config: { timeoutMs: 3600000, needsInputTimeoutMs: 3600000 },
  };
  const manager = {
    getCommands: vi.fn((): unknown[] | null => []),
    getAgent: vi.fn(async () => ({ status: "running" })),
    getLastEngineActivity: vi.fn(() => Date.parse(run.startedAt)),
    hasOpenTurn: vi.fn(() => true),
    stopAgent: vi.fn(async () => undefined),
  };
  const service = new JobService(
    {} as never,
    manager as never,
    { warn: vi.fn() } as never,
    {} as never
  );
  const store = {
    getRun: vi.fn(async () => run),
    listActiveRuns: vi.fn(async () => [run]),
    markTimedOut: vi.fn(async (_id, report) => {
      Object.assign(run, { status: "timed_out", report });
      return run;
    }),
    markCrashed: vi.fn(async () => {
      run.status = "crashed";
      return run;
    }),
    scheduleRecovery: vi.fn(async () => null),
  };
  Object.assign(service, { store });
  return { run, manager, service, store };
}

afterEach(() => vi.useRealTimers());
describe("job inactivity watchdog", () => {
  it("fails and force stops a silent job", async () => {
    vi.useFakeTimers();
    const { service, manager, store } = fixture();
    await service.reconcileActiveRuns();
    await vi.advanceTimersByTimeAsync(600000);
    expect(store.markTimedOut).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        summary: expect.stringContaining("no engine events"),
      })
    );
    expect(manager.stopAgent).toHaveBeenCalledWith("agent", { force: true });
    await service.shutdown();
  });
  it("publishes the timeout and schedules recovery if stopping fails", async () => {
    vi.useFakeTimers();
    const { service, manager, store } = fixture();
    manager.stopAgent.mockRejectedValue(new Error("stop failed"));
    const notify = vi.fn();
    service.onRunStateChange(notify);
    await service.reconcileActiveRuns();
    await vi.advanceTimersByTimeAsync(600000);
    expect(store.scheduleRecovery).toHaveBeenCalledWith("run");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ status: "timed_out" })
    );
    await service.shutdown();
  });
  it("keeps a live host awaiting attachment monitored on startup", async () => {
    vi.useFakeTimers();
    const { service, manager, store } = fixture();
    manager.hasOpenTurn.mockReturnValue(false);
    manager.getCommands.mockReturnValue(null);
    await service.reconcileActiveRuns();
    expect(store.markCrashed).not.toHaveBeenCalled();
    expect(service.getRuntimeMetrics().activeMonitors).toBe(1);
    service.stopAllSchedulers();
    await vi.advanceTimersByTimeAsync(2000);
    await service.shutdown();
  });
  it("keeps a long job alive while engine events continue", async () => {
    vi.useFakeTimers();
    const { service, manager, store } = fixture();
    manager.getLastEngineActivity.mockImplementation(() => Date.now());
    await service.reconcileActiveRuns();
    await vi.advanceTimersByTimeAsync(1200000);
    expect(store.markTimedOut).not.toHaveBeenCalled();
    service.stopAllSchedulers();
    await vi.advanceTimersByTimeAsync(2000);
    await service.shutdown();
  });
  it("includes the last twenty trimmed legacy setup lines, following links and ignoring read failures", async () => {
    const agentId = `agt_${randomUUID().replaceAll("-", "")}`;
    const log = `/tmp/dispatch_setup_${agentId}.log`;
    const dir = await mkdtemp(path.join(tmpdir(), "job-setup-"));
    const target = path.join(dir, "source");
    async function expectTail(tail: string) {
      const { service, run, manager, store } = fixture();
      run.agentId = agentId;
      manager.hasOpenTurn.mockReturnValue(false);
      await service.reconcileActiveRuns();
      const message =
        "Job turn was lost before server startup reconciliation." + tail;
      expect(store.markCrashed).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({
          tasks: [
            expect.objectContaining({
              errors: [expect.objectContaining({ message })],
            }),
          ],
        })
      );
    }
    try {
      await symlink(target, log);
      await expectTail("");
      await writeFile(target, "  \n ");
      await expectTail("");
      const lines = Array.from({ length: 23 }, (_, i) => `entry ${i}`);
      await writeFile(target, "  " + lines.join("\n") + "  \n");
      await expectTail("\n\nSetup log tail:\n" + lines.slice(-20).join("\n"));
    } finally {
      await rm(log, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reconciles a running row whose turn is gone on startup", async () => {
    const { service, manager, store } = fixture();
    manager.hasOpenTurn.mockReturnValue(false);
    await service.reconcileActiveRuns();
    expect(store.markCrashed).toHaveBeenCalled();
    expect(service.getRuntimeMetrics().activeMonitors).toBe(0);
  });
});
