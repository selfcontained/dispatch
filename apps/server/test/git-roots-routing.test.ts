import {
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { expect, it, vi } from "vitest";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { createEnrolledCheckoutRunner } from "../src/runners/enrolled/checkout.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";

it("asks a ready local child for the verbatim roots path", async () => {
  const call = vi.fn(async () => ({
    repositoryRoot: "/repo",
    checkoutRoot: "/repo",
  }));
  const child = { call, connection: { state: "ready" } } as unknown as Runner;
  const runner = runnerDirectory({ child: () => child }).for(
    controllerPlacement
  );
  expect(
    await runner.call("git.roots", {
      target: { path: pathFromWire("~/verbatim") },
    })
  ).toEqual({
    repositoryRoot: "/repo",
    checkoutRoot: "/repo",
  });
  expect(call).toHaveBeenCalledExactlyOnceWith(
    "git.roots",
    { target: { path: pathFromWire("~/verbatim") } },
    expect.objectContaining({ wait: false, timeoutMs: null })
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
      .call("git.roots", { target: { path: pathFromWire("/path") } })
  ).rejects.toBe(error);
  expect(call).toHaveBeenCalledTimes(1);
});
it("uses the enrolled runner carrier without a session", async () => {
  const readRepositoryRoots = vi.fn(async () => ({
    repositoryRoot: null,
    checkoutRoot: null,
  }));
  const service = { readRepositoryRoots } as unknown as RemoteRunnerService;
  const runner = createEnrolledCheckoutRunner(
    service,
    "test-runner",
    null,
    undefined,
    () => ({}) as never
  );
  expect(
    await runner.call("git.roots", {
      target: { path: pathFromWire("/runner/path") },
    })
  ).toEqual({
    repositoryRoot: null,
    checkoutRoot: null,
  });
  expect(readRepositoryRoots).toHaveBeenCalledExactlyOnceWith("test-runner", {
    target: { path: pathFromWire("/runner/path") },
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
    runner.call("git.roots", { target: { path: pathFromWire("/path") } })
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
      await runner.call("git.roots", {
        target: { path: pathFromWire("/missing/git-origin-fixture") },
      })
    ).toEqual({ repositoryRoot: null, checkoutRoot: null });
    // One attempt, never waiting: that attempt dials a restarted child.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![2]).toMatchObject({
      wait: false,
      timeoutMs: null,
    });
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
      await runner.call("git.roots", {
        target: { path: pathFromWire("/missing/git-origin-fixture") },
      })
    ).toEqual({ repositoryRoot: null, checkoutRoot: null });
    expect(call).toHaveBeenCalledTimes(1);
  }
);

it.each(["unavailable", "unknown_outcome"] as const)(
  "falls back if the session binding probe answers %s",
  async (code) => {
    const call = vi.fn(async () => {
      throw new RunnerCallError({ code, message: "lost binding probe" });
    });
    const child = {
      call,
      connection: { state: "ready", epoch: 1 },
    } as unknown as Runner;
    const actor = {
      id: "agt_roots_binding",
      cwd: "/missing/git-roots-fixture",
      worktreePath: null,
      workspacePath: null,
      placement: controllerPlacement,
    };
    const runner = runnerDirectory({ child: () => child }, actor).for(
      controllerPlacement
    );
    expect(
      await runner.call("git.roots", {
        target: { session: sessionFromWire(actor.id) },
      })
    ).toEqual({ repositoryRoot: null, checkoutRoot: null });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toBe("workspace.describe");
    expect(call.mock.calls[0][2]).toMatchObject({
      wait: false,
      timeoutMs: null,
    });
  }
);

it("manager roots use git.roots for an enrolled session and retain reply bytes", async () => {
  const { AgentManager } = await import("../src/agents/manager.js");
  const { placementForRunner } = await import("../src/runners/placement.js");
  const requestSession = vi.fn(async () => ({
    value: JSON.stringify({
      data: {
        checkoutRoot: "/runner/worktree",
        repositoryRoot: "/runner/repo",
      },
    }),
  }));
  const result = await AgentManager.prototype.inspectCheckout.call(
    {
      checkoutReadRunners: () => ({
        local: undefined,
        remote: { requestSession, supportsGitQueries: () => true },
      }),
    } as never,
    {
      id: "roots-agent",
      cwd: "runner://enrolled/session-workspace",
      placement: placementForRunner("enrolled"),
      worktreePath: null,
      workspacePath: null,
    } as never,
    { kind: "roots" }
  );
  expect(JSON.stringify(result)).toBe(
    '{"kind":"roots","checkoutRoot":"/runner/worktree","repositoryRoot":"/runner/repo"}'
  );
  expect(requestSession).toHaveBeenCalledExactlyOnceWith(
    { runner: "enrolled", workspace: "session-workspace" },
    {
      agentId: "roots-agent",
      kind: "gitQuery",
      operation: {
        op: "git.roots",
        request: { target: { session: "roots-agent", checkout: "current" } },
      },
    },
    undefined,
    undefined
  );
});
