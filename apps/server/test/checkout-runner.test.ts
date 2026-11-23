import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutCommand, Command } from "@dispatch/runner-protocol";
import {
  sessionFromWire,
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { RunnerConnection } from "@dispatch/runner-client/v1/connection";
import { wireFrames } from "@dispatch/runner-client/v1/node";
import { RemoteRunnerService } from "../src/agents/remote/service.js";
import { checkoutRunners } from "../src/runners/directory.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

const agent = {
  id: "agt_123",
  cwd: "/checkout",
  placement: controllerPlacement,
  worktreePath: null,
  workspacePath: null,
};
const path = ".dispatch/tools.json";
const state = "a".repeat(64);
const argv = ["example", "a b", "$literal"];
const req: Req<"checkout.exec"> = {
  target: { session: sessionFromWire(agent.id), checkout: "current" },
  guard: { path, digest: state },
  argv,
  env: {},
  timeoutMs: null,
  maxOutput: null,
  shell: "direct",
};
const operation: CheckoutCommand = {
  checkout: "effective",
  path,
  kind: "run",
  state,
  argv,
};

describe("checkout.exec", () => {
  it("delegates a local call with its native binding and no wire output cap", async () => {
    const result = { exitCode: 0, stdout: "x".repeat(70_000), stderr: "" };
    const requestSession = vi.fn(async () => ({
      value: JSON.stringify(result),
    }));
    const { directory, placement } = checkoutRunners(
      { local: { requestSession } },
      agent
    );
    const runner: Runner = directory.for(placement);
    await expect(runner.call("checkout.exec", req)).resolves.toEqual(result);
    expect(requestSession).toHaveBeenCalledExactlyOnceWith(
      { kind: "checkoutCommand", agentId: agent.id, operation },
      { checkout: agent }
    );
  });

  it("sends the same v1 wire bytes for the agent's stored workspace", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
    );
    const socket = new PassThrough();
    const lines: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => lines.push(chunk));
    const result = { exitCode: 0, stdout: "ok", stderr: "", truncated: false };
    const write = wireFrames(socket, () => {});
    const connection = new RunnerConnection((frame) => {
      write(frame);
      if (frame.type === "request")
        queueMicrotask(() =>
          connection.receive({
            type: "result",
            id: frame.id,
            value: JSON.stringify(result),
          })
        );
    });
    // Use the real service's session envelope and framing while stubbing
    // authenticated peer lookup at the service-to-connection boundary.
    const remote = Object.assign(Object.create(RemoteRunnerService.prototype), {
      request: (
        _placement: unknown,
        command: Command,
        _open: boolean,
        _progress: unknown,
        signal?: AbortSignal
      ) => connection.request(command, { signal }),
    }) as RemoteRunnerService;
    try {
      const placementV1 = {
        runner: "enrolled",
        workspace: "session-workspace",
      };
      const before = {
        kind: "checkoutCommand",
        agentId: agent.id,
        operation,
      } as const;
      await remote.requestSession(placementV1, before);
      const { directory, placement } = checkoutRunners(
        { local: { requestSession: vi.fn() }, remote },
        {
          ...agent,
          cwd: "runner://enrolled/session-workspace",
          placement: placementForRunner(placementV1.runner),
        }
      );
      const runner: Runner = directory.for(placement);
      await expect(runner.call("checkout.exec", req)).resolves.toEqual(result);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toEqual(lines[0]);
    } finally {
      connection.close();
      socket.destroy();
      vi.restoreAllMocks();
    }
  });
});
