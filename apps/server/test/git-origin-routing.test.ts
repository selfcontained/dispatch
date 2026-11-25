import { expect, it, vi } from "vitest";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { createEnrolledCheckoutRunner } from "../src/runners/enrolled/checkout.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";

it("asks a ready local child for the verbatim origin path", async () => {
  const call = vi.fn(async () => ({ url: "https://example.com/repo" }));
  const child = { call, connection: { state: "ready" } } as unknown as Runner;
  const runner = runnerDirectory({ child: () => child }).for(
    controllerPlacement
  );
  expect(await runner.call("git.origin", { path: "~/verbatim" })).toEqual({
    url: "https://example.com/repo",
  });
  expect(call).toHaveBeenCalledExactlyOnceWith(
    "git.origin",
    { path: "~/verbatim" },
    { wait: false }
  );
});
it("does not substitute a local answer for a child's operation error", async () => {
  const error = new RunnerCallError({ code: "forbidden", message: "denied" });
  const call = vi.fn(async () => {
    throw error;
  });
  const child = { call, connection: { state: "ready" } } as unknown as Runner;
  await expect(
    runnerDirectory({ child: () => child })
      .for(controllerPlacement)
      .call("git.origin", { path: "/path" })
  ).rejects.toBe(error);
  expect(call).toHaveBeenCalledTimes(1);
});
it("uses the enrolled runner carrier without a session", async () => {
  const readRepositoryOrigin = vi.fn(async () => ({ url: null }));
  const service = { readRepositoryOrigin } as unknown as RemoteRunnerService;
  const runner = createEnrolledCheckoutRunner(
    service,
    "test-runner",
    null,
    undefined,
    () => ({}) as never
  );
  expect(await runner.call("git.origin", { path: "/runner/path" })).toEqual({
    url: null,
  });
  expect(readRepositoryOrigin).toHaveBeenCalledExactlyOnceWith("test-runner", {
    path: "/runner/path",
  });
});
it("does not fall back when the enrolled runner is unavailable", async () => {
  const runner = createEnrolledCheckoutRunner(
    undefined,
    "test-runner",
    null,
    undefined,
    () => ({}) as never
  );
  await expect(
    runner.call("git.origin", { path: "/path" })
  ).rejects.toMatchObject({ code: "unavailable" });
});
it.each(["starting", "unavailable"] as const)(
  "reads in process while the child is %s",
  async (state) => {
    // A child that is not connected answers a single attempt with
    // `unavailable` at once, as the local session does.
    const call = vi.fn(async () => {
      throw new RunnerCallError({
        code: "unavailable",
        message: "fixture transport",
      });
    });
    const child = { call, connection: { state } } as unknown as Runner;
    const runner = runnerDirectory({ child: () => child }).for(
      controllerPlacement
    );
    expect(
      await runner.call("git.origin", { path: "/missing/git-origin-fixture" })
    ).toEqual({ url: null });
    // One attempt, never waiting: that attempt dials a restarted child.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toContainEqual({ wait: false });
  }
);
it.each(["unavailable", "unknown_outcome"] as const)(
  "reads in process after the child answers %s",
  async (code) => {
    const call = vi.fn(async () => {
      throw new RunnerCallError({ code, message: "lost child" });
    });
    const child = { call, connection: { state: "ready" } } as unknown as Runner;
    const runner = runnerDirectory({ child: () => child }).for(
      controllerPlacement
    );
    expect(
      await runner.call("git.origin", { path: "/missing/git-origin-fixture" })
    ).toEqual({ url: null });
    expect(call).toHaveBeenCalledTimes(1);
  }
);
