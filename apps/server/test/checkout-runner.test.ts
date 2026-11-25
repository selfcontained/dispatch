import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  CheckoutCommand,
  CheckoutView,
  Command,
} from "@dispatch/runner-protocol";
import {
  pathFromWire,
  sessionFromWire,
  type Req,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { RunnerConnection } from "@dispatch/runner-client/v1/connection";
import { wireFrames } from "@dispatch/runner-client/v1/node";
import {
  inspectAgentCheckout,
  readAgentView,
} from "../src/agents/checkout-runner.js";
import type { AgentRecord } from "../src/agents/types.js";
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

describe("legacy checkout reads", () => {
  const placement = { runner: "enrolled", workspace: "session-workspace" };
  const enrolled = {
    ...agent,
    cwd: "runner://enrolled/session-workspace",
    placement: placementForRunner(placement.runner),
    baseBranch: null,
  };
  it("preserves both caller query orders for the file diff frame", async () => {
    const requestSession = vi
      .fn()
      .mockResolvedValue({ value: '{"data":null}' });
    const remote = { requestSession } as unknown as RemoteRunnerService;
    const queries: CheckoutView[] = [
      {
        kind: "fileDiff",
        path,
        baseBranch: null,
        ignoreWhitespace: true,
        includeUncommitted: true,
      },
      {
        kind: "fileDiff",
        path,
        baseBranch: null,
        includeUncommitted: true,
        ignoreWhitespace: false,
      },
    ];
    for (const query of queries) {
      await expect(
        readAgentView(enrolled, query, remote, "main")
      ).resolves.toBeNull();
    }
    expect(
      requestSession.mock.calls.map(([location, operation]) => {
        expect(location).toEqual(placement);
        return JSON.stringify(operation);
      })
    ).toEqual(
      queries.map((query) =>
        JSON.stringify({
          kind: "viewCheckout",
          agentId: enrolled.id,
          query: { ...query, baseBranch: "main" },
        })
      )
    );
  });

  it("keeps the legacy UTF-8 inspection request and response bytes", async () => {
    const requestSession = vi.fn(async () => ({
      value: '{"kind":"readFile","content":"legacy text"}',
    }));
    const { directory, placement: selected } = checkoutRunners(
      { remote: { requestSession } as never },
      enrolled
    );
    expect(
      await directory.for(selected).call("checkout.read", {
        target: {
          session: sessionFromWire(enrolled.id),
          checkout: "current",
        },
        path,
        encoding: "utf8",
        maxBytes: null,
      })
    ).toEqual({ data: "legacy text" });
    expect(
      requestSession.mock.calls.map((call) => JSON.stringify(call))
    ).toEqual([
      '[{"runner":"enrolled","workspace":"session-workspace"},{"kind":"inspectCheckout","agentId":"agt_123","query":{"kind":"readFile","path":".dispatch/tools.json"}}]',
    ]);
  });

  it("streams launch files from the owned checkout and current files from the selected workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-selectors-"));
    const owned = join(root, "owned");
    const moved = join(root, "moved");
    await mkdir(owned);
    await mkdir(moved);
    const ownedBytes = Buffer.alloc(5 * 1024 * 1024, 0xff);
    ownedBytes.set([0, 128, 239, 127]);
    const movedBytes = Buffer.alloc(5 * 1024 * 1024, 0x80);
    const ownedText = "owned¥".repeat(1024 * 1024);
    const movedText = "moved¥".repeat(1024 * 1024);
    try {
      for (const [directory, bytes, data] of [
        [owned, ownedBytes, ownedText],
        [moved, movedBytes, movedText],
      ] as const) {
        await writeFile(join(directory, "binary"), bytes);
        await writeFile(join(directory, "text"), data);
      }
      const streamCheckoutRead = vi.fn(async (_location, op, request) => {
        const { target, ...parameters } = request;
        return checkoutWorkload.run(
          op,
          {
            directory: target.checkout === "launch" ? owned : moved,
            request: parameters,
          },
          {}
        );
      });
      const requestSession = vi.fn(() => {
        throw new Error("Unexpected legacy read");
      });
      const { directory, placement: selected } = checkoutRunners(
        { remote: { streamCheckoutRead, requestSession } as never },
        enrolled
      );
      for (const checkout of ["current", "launch"] as const) {
        const call = (
          encoding: "utf8" | "base64",
          maxBytes: number | null = null
        ) =>
          directory.for(selected).call("checkout.read", {
            target: { session: sessionFromWire(enrolled.id), checkout },
            path: encoding === "base64" ? "binary" : "text",
            encoding,
            maxBytes,
          });
        const binary = await call("base64");
        expect(
          Buffer.from(binary!.data, "base64").equals(
            checkout === "launch" ? ownedBytes : movedBytes
          )
        ).toBe(true);
        const text = await call("utf8");
        expect(
          text?.data === (checkout === "launch" ? ownedText : movedText)
        ).toBe(true);
        await expect(call("utf8", 1)).rejects.toMatchObject({
          code: "too_large",
        });
        await expect(call("base64", 1)).rejects.toMatchObject({
          code: "too_large",
        });
      }
      expect(requestSession).not.toHaveBeenCalled();
      expect(streamCheckoutRead).toHaveBeenCalledTimes(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not use legacy inspection for a launch read when streaming is unavailable", async () => {
    const requestSession = vi.fn();
    const { directory, placement: selected } = checkoutRunners(
      { remote: { requestSession } as never },
      enrolled
    );
    await expect(
      directory.for(selected).call("checkout.read", {
        target: { session: sessionFromWire(enrolled.id), checkout: "launch" },
        path,
        encoding: "utf8",
        maxBytes: null,
      })
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(requestSession).not.toHaveBeenCalled();
  });

  it("still rejects a legacy inspection reply above the v1 file cap", async () => {
    const query = { kind: "readFile", path } as const;
    const requestSession = vi.fn().mockResolvedValue({
      value: JSON.stringify({
        kind: "readFile",
        content: "x".repeat(256 * 1024 + 1),
      }),
    });
    const remote = { requestSession } as unknown as RemoteRunnerService;
    await expect(
      inspectAgentCheckout(enrolled as AgentRecord, query, remote)
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(requestSession.mock.calls).toEqual([
      [
        placement,
        {
          kind: "inspectCheckout",
          agentId: enrolled.id,
          query,
        },
      ],
    ]);
  });
  it("keeps the legacy image frame and its bytes for a peer without streams", async () => {
    const bytes = Buffer.from("png bytes").toString("base64");
    const requestSession = vi
      .fn()
      .mockResolvedValue({ value: JSON.stringify({ data: bytes }) });
    const remote = { requestSession } as unknown as RemoteRunnerService;
    const query: CheckoutView = {
      kind: "image",
      path: "a.png",
      side: "new",
      baseBranch: null,
      includeUncommitted: true,
    };
    await expect(readAgentView(enrolled, query, remote, "main")).resolves.toBe(
      bytes
    );
    expect(JSON.stringify(requestSession.mock.calls[0]![1])).toBe(
      JSON.stringify({
        kind: "viewCheckout",
        agentId: enrolled.id,
        query: { ...query, baseBranch: "main" },
      })
    );
  });

  it("keeps the legacy default-branch files frame for a peer without streams", async () => {
    const reply = {
      kind: "defaultBranchFiles",
      hasOrigin: true,
      files: [{ path: ".agents/personas/a.md", content: "a" }],
      warnings: [],
      refreshing: false,
      updatedAt: 1,
      truncated: false,
    };
    const requestSession = vi
      .fn()
      .mockResolvedValue({ value: JSON.stringify(reply) });
    const remote = { requestSession } as unknown as RemoteRunnerService;
    const query = {
      kind: "defaultBranchFiles",
      directories: [".agents/personas"],
      waitForRefresh: false,
    } as const;
    await expect(
      inspectAgentCheckout(enrolled as AgentRecord, query, remote)
    ).resolves.toEqual(reply);
    expect(requestSession.mock.calls).toEqual([
      [placement, { kind: "inspectCheckout", agentId: enrolled.id, query }],
    ]);
  });
});
