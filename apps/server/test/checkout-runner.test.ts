import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutCommand, Command } from "@dispatch/runner-protocol";
import {
  pathFromWire,
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
  it("runs a local call in the workload, on the request's terms", async () => {
    const root = await mkdtemp(join(tmpdir(), "checkout-runner-"));
    try {
      await mkdir(join(root, ".dispatch"));
      await writeFile(join(root, path), "{}");
      const local = { ...agent, cwd: root };
      const { directory, placement } = checkoutRunners({}, local);
      const runner = directory.for(placement);
      const file = await runner.readManifest({
        checkout: "effective",
        path,
        kind: "read",
      });
      expect(file?.content).toBe("{}");
      const call = (patch: Partial<Req<"checkout.exec">>) =>
        runner.call("checkout.exec", {
          ...req,
          guard: { path, digest: file!.state },
          argv: [
            "sh",
            "-c",
            'printf %70000s "" | tr " " x; printf "$DISPATCH_AGENT_ID" >&2',
          ],
          env: { DISPATCH_AGENT_ID: agent.id },
          ...patch,
        });
      // No output limit unless the request names one, as main ran repo tools.
      const result = await call({});
      expect(result.stdout).toHaveLength(70_000);
      expect(result.stderr).toBe(agent.id);
      expect(result).not.toHaveProperty("truncated");
      await expect(call({ maxOutput: 10 })).resolves.toMatchObject({
        stdout: "x".repeat(10),
        truncated: true,
      });
      await expect(
        call({ guard: { path, digest: state } })
      ).rejects.toMatchObject({ code: "stale" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a local call in the child only when it holds the selected checkout", async () => {
    const child = {
      connection: { state: "ready", epoch: 1, onChange: () => () => {} },
      call: vi.fn(async (op: string) => {
        if (op === "workspace.describe")
          return {
            path: pathFromWire("/moved"),
            moved: true,
            origin: null,
            checkoutRoot: pathFromWire("/checkout"),
            worktree: null,
          };
        return { exitCode: 0, stdout: "child", stderr: "" };
      }),
    } as unknown as Runner;
    const moved = { ...agent, workspacePath: "/moved" };
    const { directory, placement } = checkoutRunners(
      { child: () => child },
      moved
    );
    const runner = directory.for(placement);
    for (const checkout of ["current", "launch", "moved"] as const)
      await expect(
        runner.call("checkout.exec", {
          ...req,
          target: { session: req.target.session, checkout } as never,
        })
      ).resolves.toMatchObject({ stdout: "child" });
    expect(
      child.call.mock.calls
        .filter(([op]) => op === "checkout.exec")
        .map(([, input]) => (input as Req<"checkout.exec">).target)
    ).toEqual(
      ["current", "launch", "moved"].map((checkout) => ({
        session: req.target.session,
        checkout,
      }))
    );

    // A binding elsewhere: the workload runs it here, against its own guard.
    const elsewhere = checkoutRunners(
      { child: () => child },
      { ...agent, cwd: "/other" }
    );
    await expect(
      elsewhere.directory.for(elsewhere.placement).call("checkout.exec", req)
    ).rejects.toThrow();
    expect(
      child.call.mock.calls.filter(([op]) => op === "checkout.exec")
    ).toHaveLength(3);
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
        { remote },
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
