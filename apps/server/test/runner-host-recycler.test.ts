import type { FastifyBaseLogger } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { RunnerHostRecycler } from "../src/agents/remote/host-recycler.js";
import type { RunnerHostIdentity } from "../src/agents/runtime.js";

afterEach(() => vi.useRealTimers());

it("coalesces settlement retries and keeps a bounded fallback scan", async () => {
  vi.useFakeTimers();
  const host = {
    agentId: "agt_old",
    instanceId: "01234567-89ab-4cde-8fab-0123456789ab",
    build: { version: "1.7.28", revision: "a".repeat(40) },
    quiesceSupported: true,
  };
  const recycle = vi.fn(async () => false);
  const recycler = new RunnerHostRecycler({
    hosts: () => [host],
    recycle,
    logger: { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger,
  });
  const update = {
    runnerId: "r1",
    attemptId: "11111111-1111-4111-8111-111111111111",
    revision: "b".repeat(40),
    sha256: "c".repeat(64),
  };
  recycler.start(update);
  recycler.start(update);
  await vi.advanceTimersByTimeAsync(0);
  expect(recycle).toHaveBeenCalledTimes(1);
  recycler.settled("agt_local");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(recycle).toHaveBeenCalledTimes(1);

  recycler.settled(host.agentId);
  await vi.advanceTimersByTimeAsync(999);
  recycler.settled(host.agentId);
  expect(recycle).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(recycle).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(4_999);
  expect(recycle).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(recycle).toHaveBeenCalledTimes(3);
  recycler.stop("r1");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(recycle).toHaveBeenCalledTimes(3);
  expect(recycler.progress("r1")).toBeNull();
});

it("settles the restarts already under way when it is stopped", async () => {
  let finish!: () => void;
  const recycler = new RunnerHostRecycler({
    hosts: () => [
      {
        agentId: "agt_old",
        instanceId: "01234567-89ab-4cde-8fab-0123456789ab",
        build: { version: "1.7.28", revision: "a".repeat(40) },
        quiesceSupported: true,
      },
    ],
    recycle: () =>
      new Promise<boolean>((resolve) => (finish = () => resolve(true))),
    logger: { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger,
  });
  recycler.start({
    runnerId: "r1",
    attemptId: "11111111-1111-4111-8111-111111111111",
    revision: "b".repeat(40),
    sha256: "c".repeat(64),
  });
  // An ordinary stop must not make the restart forgettable.
  recycler.stop("r1");
  let settled = false;
  const settling = recycler.stopAndSettle("r1").then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(recycler.progress("r1")).toBeNull();
  finish();
  await settling;
  await recycler.stopAndSettle("r2");
});

it("stops a running pass before settling it", async () => {
  const recycler = new RunnerHostRecycler({
    hosts: () => [],
    recycle: async () => false,
    logger: { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger,
  });
  recycler.start({
    runnerId: "r1",
    attemptId: "11111111-1111-4111-8111-111111111111",
    revision: "b".repeat(40),
    sha256: "c".repeat(64),
  });
  expect(recycler.progress("r1")).not.toBeNull();
  await recycler.stopAndSettle("r1");
  expect(recycler.progress("r1")).toBeNull();
});

it("counts only hosts that report a different revision from the confirmed build", async () => {
  vi.useFakeTimers();
  const confirmed = { version: "1.7.29", revision: "b".repeat(40) };
  const previous = { version: "1.7.28", revision: "a".repeat(40) };
  const hosts: RunnerHostIdentity[] = [];
  const recycle = vi.fn(async () => false);
  const recycler = new RunnerHostRecycler({
    hosts: () => hosts,
    recycle,
    logger: { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger,
  });
  recycler.start({
    runnerId: "r1",
    attemptId: "11111111-1111-4111-8111-111111111111",
    revision: confirmed.revision,
    sha256: "c".repeat(64),
  });

  const fresh = {
    agentId: "agt_fresh",
    instanceId: "01234567-89ab-4cde-8fab-0123456789ab",
    quiesceSupported: true,
  };
  hosts.push(fresh);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(recycler.progress("r1")?.oldBuild).toBe(0);
  expect(recycle).not.toHaveBeenCalled();

  hosts[0] = { ...fresh, build: confirmed };
  hosts.push({ ...fresh, agentId: "agt_old", build: previous });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(recycler.progress("r1")).toEqual({
    oldBuild: 1,
    waiting: 1,
    recycled: 0,
  });
  expect(recycle.mock.calls).toHaveLength(1);
  expect(recycle).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ agentId: "agt_old" }),
    expect.any(Function)
  );
  recycler.stop("r1");
});

it("logs unsupported and unidentified hosts once per refusal, without bypassing safeguards", async () => {
  vi.useFakeTimers();
  const info = vi.fn();
  const recycle = vi.fn(async () => true);
  const recycler = new RunnerHostRecycler({
    hosts: () => [
      { agentId: "unknown" },
      {
        agentId: "legacy",
        instanceId: "old",
        build: { version: "1", revision: "a".repeat(40) },
        quiesceSupported: false,
      },
    ],
    recycle,
    logger: { info, warn: vi.fn() } as unknown as FastifyBaseLogger,
  });
  recycler.start({
    runnerId: "r1",
    attemptId: "attempt",
    revision: "b".repeat(40),
    sha256: "c".repeat(64),
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(recycle).not.toHaveBeenCalled();
  expect(
    info.mock.calls.map(([fields]) => fields.reason).filter(Boolean)
  ).toEqual(["missing_build_identity", "quiesce_unsupported"]);
  recycler.stop("r1");
});
