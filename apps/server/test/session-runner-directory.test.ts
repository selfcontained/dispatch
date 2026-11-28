import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { sessionRunnerDirectory } from "../src/runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import {
  sessionHostChannel,
  type SessionLaunchObservation,
} from "../src/runners/session.js";
import {
  RunnerAcknowledgementLost,
  RunnerHostGone,
  RunnerUnavailable,
  RunnerUpdateFenced,
} from "../src/agents/remote/service.js";

const session = sessionFromWire("agt_session");
const launch = { session, launchId: "same-attempt" } as never;
const watch = { timeoutMs: 60_000, pollMs: 250 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("selects the carrier once while keeping session requests and empty launch acknowledgements unchanged", async () => {
  vi.useFakeTimers();
  const call = vi.fn(async () => ({}));
  const remoteCall = vi.fn(async () => ({}));
  const directory = sessionRunnerDirectory(
    {
      child: () => ({ call, openStream: vi.fn() }) as never,
      remote: {
        available: () => true,
        call: remoteCall,
        openStream: vi.fn(),
      } as never,
    },
    watch
  );
  const local = directory.for(controllerPlacement),
    remote = directory.for(placementForRunner("r1"));
  let observation: SessionLaunchObservation | undefined;
  expect(
    await local.call("session.launch", launch, {
      observeLaunch: (value) => {
        observation = value;
      },
    })
  ).toEqual({});
  expect(observation?.launchExited()).toBe(false);
  observation!.launchSettled();
  expect(call).toHaveBeenCalledWith(
    "session.launch",
    launch,
    expect.objectContaining({ timeoutMs: null })
  );
  const unused = vi.fn();
  expect(
    await remote.call("session.launch", launch, { observeLaunch: unused })
  ).toEqual({});
  expect(remoteCall).toHaveBeenCalledWith("r1", "session.launch", launch);
  expect(unused).not.toHaveBeenCalled();
  expect(directory.for(placementForRunner("r1"))).toBe(remote);
});

it("keeps fast Local stop uncertainty separate from the native updater's bounded idle stop", async () => {
  const timeout = new RunnerCallError({
    code: "timeout",
    message: "lost stop acknowledgement",
  });
  const call = vi.fn(async () => {
    throw timeout;
  });
  const runner = sessionRunnerDirectory(
    { child: () => ({ call }) as never },
    watch
  ).for(controllerPlacement);
  await expect(
    runner.call("session.stop", { session, force: false })
  ).rejects.toBeInstanceOf(RunnerAcknowledgementLost);
  expect(call).toHaveBeenLastCalledWith(
    "session.stop",
    { session, force: false },
    { wait: false, timeoutMs: 30_000 }
  );
  await expect(
    runner.call(
      "session.stop",
      { session, force: false, idleOnly: true },
      { wait: true }
    )
  ).rejects.toBe(timeout);
  expect(call).toHaveBeenLastCalledWith(
    "session.stop",
    { session, force: false, idleOnly: true },
    expect.objectContaining({ timeoutMs: null })
  );
});

it("preserves Local host-failure log formatting without changing raw log calls or enrolled logs", async () => {
  const call = vi.fn(async () => ({ text: "  details\n" }));
  const remoteCall = vi.fn(async () => ({ text: "  details\n" }));
  const directory = sessionRunnerDirectory(
    {
      child: () => ({ call }) as never,
      remote: { available: () => true, call: remoteCall } as never,
    },
    watch
  );
  const request = { session, lines: 20 };
  expect(
    await directory.for(controllerPlacement).call("session.logs", request)
  ).toEqual({ text: "  details\n" });
  expect(
    await directory
      .for(controllerPlacement)
      .call("session.logs", request, { hostLog: true })
  ).toEqual({ text: "\n\nHost log (last 20 lines):\ndetails" });
  expect(
    await directory
      .for(placementForRunner("r1"))
      .call("session.logs", request, { hostLog: true })
  ).toEqual({ text: "  details\n" });
  call.mockRejectedValue(new Error("cannot read log"));
  expect(
    await directory
      .for(controllerPlacement)
      .call("session.logs", request, { hostLog: true })
  ).toEqual({ text: "" });
  await expect(
    directory.for(controllerPlacement).call("session.logs", request)
  ).rejects.toThrow("cannot read log");
});

it.each([
  ["host_gone", RunnerHostGone],
  ["unavailable", RunnerUnavailable],
  ["unknown_outcome", RunnerAcknowledgementLost],
  ["fenced", RunnerUpdateFenced],
] as const)(
  "keeps enrolled %s translation at the carrier boundary",
  async (code, ErrorType) => {
    const call = vi.fn(async () => {
      throw new RunnerCallError({ code, message: code });
    });
    const runner = sessionRunnerDirectory(
      { remote: { available: () => true, call } as never },
      watch
    ).for(placementForRunner("r1"));
    await expect(
      runner.call("session.alive", { session })
    ).rejects.toBeInstanceOf(ErrorType);
  }
);

it("distinguishes a disabled remote service from a restarting Local child", async () => {
  const directory = sessionRunnerDirectory({}, watch);
  const local = directory.for(controllerPlacement),
    remote = directory.for(placementForRunner("r1"));
  expect(local.enabled).toBe(true);
  expect(remote.enabled).toBe(false);
  await expect(
    local.call("session.list", { owner: null })
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    remote.call("session.list", { owner: null })
  ).rejects.toBeInstanceOf(RunnerUnavailable);
});

it.each([controllerPlacement, placementForRunner("r1")])(
  "adapts the selected session channel for HostClient (%j)",
  async (placement) => {
    const raw = new PassThrough();
    const open = vi.fn(async () => ({ info: {}, channel: raw }));
    const directory = sessionRunnerDirectory(
      {
        child: () => ({ openStream: open }) as never,
        remote: { available: () => true, openStream: open } as never,
      },
      watch
    );
    const channel = await sessionHostChannel(
      directory.for(placement),
      "agt_session"
    );
    try {
      const received = new Promise<string>((resolve) =>
        channel.once("data", (chunk) => resolve(chunk.toString()))
      );
      raw.write(
        JSON.stringify({ type: "welcome", sessionId: "engine" }) + "\n"
      );
      expect(JSON.parse(await received)).toMatchObject({
        type: "welcome",
        agentId: "agt_session",
        sessionId: "engine",
      });
    } finally {
      channel.destroy();
    }
  }
);
