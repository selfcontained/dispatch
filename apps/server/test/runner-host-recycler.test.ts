import type { FastifyBaseLogger } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { RunnerHostRecycler } from "../src/agents/remote/host-recycler.js";

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
    logger: { warn: vi.fn() } as unknown as FastifyBaseLogger,
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
