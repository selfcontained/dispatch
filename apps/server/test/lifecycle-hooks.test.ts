import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutCommandTimeoutMs } from "@dispatch/runner-protocol";

import { createLocalRunner } from "../src/agents/local-runner.js";
import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import type { AgentRecord } from "../src/agents/types.js";

const logger = {
  info: () => {},
  warn: () => {},
} as unknown as import("fastify").FastifyBaseLogger;

async function repoWithStopHook(dir: string): Promise<void> {
  await mkdir(path.join(dir, ".dispatch"), { recursive: true });
  await writeFile(
    path.join(dir, ".dispatch", "tools.json"),
    JSON.stringify({
      hooks: {
        stop: { command: ["sh", "-c", 'echo "$DISPATCH_AGENT_ID" > stopped'] },
      },
    })
  );
}

describe("runLifecycleHook", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-hooks-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(["effective", "launch", "moved"] as const)(
    "bounds native %s checkout commands as main did: hooks 15s, repo tools never",
    async (selection) => {
      const checkout = {
        id: "agt_hook",
        cwd: root,
        workspacePath: path.join(root, "moved"),
        worktreePath: null,
      };
      const dir = selection === "launch" ? root : checkout.workspacePath;
      await repoWithStopHook(dir);
      const runner = createLocalRunner(root, logger);
      const target = {
        checkout: selection,
        path: ".dispatch/tools.json",
      } as const;
      const read = await runner.requestSession(
        {
          kind: "checkoutCommand",
          agentId: checkout.id,
          operation: { ...target, kind: "read" },
        },
        { checkout }
      );
      const { state } = JSON.parse(String(read.value)) as { state: string };
      const timer = vi.spyOn(globalThis, "setTimeout");
      try {
        const result = await runner.requestSession(
          {
            kind: "checkoutCommand",
            agentId: checkout.id,
            operation: { ...target, kind: "run", state, argv: ["true"] },
          },
          { checkout }
        );
        expect(JSON.parse(String(result.value))).toMatchObject({
          exitCode: 0,
        });
        const delays = timer.mock.calls.map(([, delay]) => delay);
        if (selection === "effective")
          expect(delays.filter((delay) => (delay ?? 0) >= 1_000)).toEqual([]);
        else expect(delays).toContain(15_000);
      } finally {
        timer.mockRestore();
      }
    }
  );

  it("kills only the timed-out stop hook, leaving what it started running", async () => {
    const launch = path.join(root, "launch");
    await mkdir(path.join(launch, ".dispatch"), { recursive: true });
    await writeFile(
      path.join(launch, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: {
          stop: {
            command: [
              "sh",
              "-c",
              "sleep 60 >/dev/null 2>&1 & echo $! > child.pid; wait",
            ],
          },
        },
      })
    );
    // Shorten only the hook's 15s deadline so the test runs in well under 15s.
    const realSetTimeout = globalThis.setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) =>
        realSetTimeout(
          callback,
          delay === checkoutCommandTimeoutMs("launch") ? 300 : delay,
          ...args
        )) as typeof setTimeout);
    let pid: number | undefined;
    try {
      const warn = vi.fn();
      await runLifecycleHook(
        "stop",
        {
          id: "agt_hook",
          cwd: launch,
          worktreePath: launch,
          workspacePath: null,
        } as AgentRecord,
        { ...logger, warn } as unknown as typeof logger,
        { local: createLocalRunner(root, logger) }
      );
      timer.mockRestore();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({
            message: "Checkout command timed out.",
          }),
        }),
        expect.any(String)
      );
      pid = Number(await readFile(path.join(launch, "child.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      await new Promise((resolve) => realSetTimeout(resolve, 200));
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      timer.mockRestore();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  it("runs the stop hook in the launch checkout and the moved workspace", async () => {
    const launch = path.join(root, "launch");
    const moved = path.join(root, "moved");
    await repoWithStopHook(launch);
    await repoWithStopHook(moved);

    await runLifecycleHook(
      "stop",
      {
        id: "agt_hook",
        cwd: launch,
        worktreePath: launch,
        workspacePath: moved,
      } as AgentRecord,
      logger,
      { local: createLocalRunner(root, logger) }
    );

    await expect(readFile(path.join(launch, "stopped"), "utf8")).resolves.toBe(
      "agt_hook\n"
    );
    await expect(readFile(path.join(moved, "stopped"), "utf8")).resolves.toBe(
      "agt_hook\n"
    );
  });

  it("runs once when the agent never moved", async () => {
    const launch = path.join(root, "launch");
    await repoWithStopHook(launch);
    await writeFile(
      path.join(launch, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: { stop: { command: ["sh", "-c", "echo x >> stopped"] } },
      })
    );

    await runLifecycleHook(
      "stop",
      {
        id: "agt_hook",
        cwd: launch,
        worktreePath: null,
        workspacePath: null,
      } as AgentRecord,
      logger,
      { local: createLocalRunner(root, logger) }
    );

    await expect(readFile(path.join(launch, "stopped"), "utf8")).resolves.toBe(
      "x\n"
    );
  });
});

it("puts each of a hook's runner requests through the fence retry", async () => {
  const refused = new Set(["read", "run"]);
  const kinds: string[] = [];
  const requestSession = vi.fn(async (_placement, { operation }) => {
    kinds.push(`${operation.checkout} ${operation.kind}`);
    if (refused.delete(operation.kind)) throw new Error("fenced");
    const content = JSON.stringify({ hooks: { stop: { command: ["true"] } } });
    return {
      value: JSON.stringify(
        operation.kind === "read"
          ? { content, state: "a".repeat(64) }
          : { exitCode: 0, stderr: "", stdout: "", truncated: false }
      ),
    };
  });
  await runLifecycleHook(
    "stop",
    { id: "session", cwd: "runner://machine/work" } as AgentRecord,
    logger,
    {
      local: createLocalRunner("/tmp/runner-hooks-unused", logger),
      remote: { requestSession } as unknown as RemoteRunnerService,
    },
    (request) => request().catch(request)
  );
  expect(kinds).toEqual([
    "launch read",
    "launch read",
    "launch run",
    "launch run",
    "moved read",
    "moved run",
  ]);
});

it("reports a runner hook failure and still runs the moved checkout on each teardown attempt", async () => {
  const warn = vi.fn();
  const call = vi.fn(async (_placement, { operation }) => {
    const content = JSON.stringify({
      hooks: { stop: { command: ["cleanup", operation.checkout] } },
    });
    return {
      value: JSON.stringify(
        operation.kind === "read"
          ? { content, state: "a".repeat(64) }
          : {
              exitCode: operation.checkout === "launch" ? 23 : 0,
              stderr: "cleanup failed",
              stdout: "",
              truncated: false,
            }
      ),
    };
  });
  const remote = { requestSession: call } as unknown as RemoteRunnerService;
  const agent = { id: "session", cwd: "runner://machine/work" } as AgentRecord;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      runLifecycleHook(
        "stop",
        agent,
        { ...logger, warn },
        { local: createLocalRunner("/tmp/runner-hooks-unused", logger), remote }
      )
    ).resolves.toBeUndefined();
  }
  expect(
    call.mock.calls.map(([, { operation }]) => [
      operation.checkout,
      operation.kind,
    ])
  ).toEqual([
    ["launch", "read"],
    ["launch", "run"],
    ["moved", "read"],
    ["moved", "run"],
    ["launch", "read"],
    ["launch", "run"],
    ["moved", "read"],
    ["moved", "run"],
  ]);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      checkout: "launch",
      exitCode: 23,
      stderr: "cleanup failed",
    }),
    expect.any(String)
  );
});
