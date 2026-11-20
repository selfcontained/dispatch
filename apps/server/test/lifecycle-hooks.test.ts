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
    "uses the shared deadline for native %s checkout commands",
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
      const timer = vi.spyOn(globalThis, "setTimeout");
      try {
        const result = await runner.requestSession(
          {
            kind: "checkoutCommand",
            agentId: checkout.id,
            operation: {
              kind: "read",
              checkout: selection,
              path: ".dispatch/tools.json",
            },
          },
          { checkout }
        );
        expect(JSON.parse(String(result.value))).toMatchObject({
          content: expect.stringContaining('"stop"'),
        });
        expect(timer).toHaveBeenCalledWith(
          expect.any(Function),
          checkoutCommandTimeoutMs(selection)
        );
      } finally {
        timer.mockRestore();
      }
    }
  );

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
