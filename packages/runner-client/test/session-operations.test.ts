import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  RunnerCallError,
  sessionFromWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import {
  launchLocalSession,
  readLocalSession,
  requestLocalSession,
  type LocalSessionRunner,
} from "../src/session/operations.js";

const session = sessionFromWire("agt_local");
const launch = { session, launchId: "same-launch" } as Req<"session.launch">;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const child = (call: ReturnType<typeof vi.fn>) =>
  ({ call, openStream: vi.fn() }) as unknown as LocalSessionRunner;

it("bounds an unavailable read and preserves unavailable rather than reporting a dead host", async () => {
  const call = vi.fn(
    (_op, _input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new RunnerCallError({ code: "cancelled", message: "cancelled" })
            ),
          { once: true }
        );
      })
  );
  const result = readLocalSession(child(call), "session.alive", { session });
  const rejected = expect(result).rejects.toMatchObject({
    code: "unavailable",
  });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(call.mock.calls[0]![2].signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
});

it("keeps launch identity and lets the session transport own retry and per-attempt deadlines", async () => {
  const call = vi.fn(
    async (_op: string, _input: unknown, _options: unknown) => ({})
  );
  await requestLocalSession(child(call), "session.launch", launch);
  expect(call).toHaveBeenCalledWith(
    "session.launch",
    launch,
    expect.objectContaining({ timeoutMs: null })
  );
  expect(call.mock.calls[0]![1]).toBe(launch);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(90_000);
});

it("does not relabel a runner's own refusal as an expired wait", async () => {
  const refusal = new RunnerCallError({
    code: "timeout",
    message: "runner reply timed out",
  });
  await expect(
    requestLocalSession(
      child(
        vi.fn(async () => {
          throw refusal;
        })
      ),
      "session.stop",
      { session, force: false }
    )
  ).rejects.toBe(refusal);
  expect(AbortSignal.timeout).toHaveBeenCalledWith(30_000);
});

it("detects an early exit, ignores unavailable polls, and ends watching after handshake", async () => {
  let polls = 0;
  const call = vi.fn(async (op: string) => {
    if (op === "session.launch") return {};
    polls++;
    if (polls === 1)
      throw new RunnerCallError({ code: "unavailable", message: "restarting" });
    return { state: "gone" };
  });
  const observation = await launchLocalSession(child(call), launch, {
    timeoutMs: 60_000,
    pollMs: 250,
  });
  expect(observation.launchExited()).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(observation.launchExited()).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(observation.launchExited()).toBe(true);
  expect(call).toHaveBeenLastCalledWith(
    "session.alive",
    { session },
    { wait: false }
  );
  observation.launchSettled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(polls).toBe(2);
});

it("stops the early-exit poll when the caller finishes its handshake", async () => {
  const call = vi.fn(async (op: string) =>
    op === "session.launch" ? {} : { state: "live" }
  );
  const observation = await launchLocalSession(child(call), launch, {
    timeoutMs: 60_000,
    pollMs: 250,
  });
  observation.launchSettled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(observation.launchExited()).toBe(false);
  expect(call).toHaveBeenCalledTimes(1);
});
