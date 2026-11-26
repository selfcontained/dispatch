import type { Pool } from "pg";
import { previewArchive } from "../src/agents/archive.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutCommandTimeoutMs } from "@dispatch/runner-protocol";

import { requestCheckoutCommand } from "../src/agents/checkout-commands.js";
import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import type { AgentRecord } from "../src/agents/types.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

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
      const runners = {};
      const agent = { ...checkout, placement: controllerPlacement };
      const target = {
        checkout: selection,
        path: ".dispatch/tools.json",
      } as const;
      const read = await requestCheckoutCommand(runners, agent, {
        ...target,
        kind: "read",
      });
      const state = read!.state;
      const timer = vi.spyOn(globalThis, "setTimeout");
      try {
        const result = await requestCheckoutCommand(runners, agent, {
          ...target,
          kind: "run",
          state,
          argv: ["true"],
        });
        expect(result).toMatchObject({ exitCode: 0 });
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
          placement: controllerPlacement,
          cwd: launch,
          worktreePath: launch,
          workspacePath: null,
        } as AgentRecord,
        { ...logger, warn } as unknown as typeof logger,
        {}
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
        placement: controllerPlacement,
        cwd: launch,
        worktreePath: launch,
        workspacePath: moved,
      } as AgentRecord,
      logger,
      {}
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
        placement: controllerPlacement,
        cwd: launch,
        worktreePath: null,
        workspacePath: null,
      } as AgentRecord,
      logger,
      {}
    );

    await expect(readFile(path.join(launch, "stopped"), "utf8")).resolves.toBe(
      "x\n"
    );
  });

  it("uses the launch checkout's archive hook for an older worktree", async () => {
    const launch = path.join(root, "launch");
    const worktree = path.join(root, "worktree");
    await repoWithStopHook(worktree);
    await mkdir(path.join(launch, ".dispatch"), { recursive: true });
    await writeFile(
      path.join(launch, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: {
          archive: {
            command: ["sh", "-c", 'echo "$DISPATCH_AGENT_ID" > archived'],
          },
        },
      })
    );

    await runLifecycleHook(
      "archive",
      {
        id: "agt_hook",
        cwd: worktree,
        placement: controllerPlacement,
        launchCwd: launch,
        worktreePath: worktree,
      } as AgentRecord,
      logger,
      {}
    );

    await expect(readFile(path.join(launch, "archived"), "utf8")).resolves.toBe(
      "agt_hook\n"
    );
  });

  it("preserves the failing archive command error including trimmed stderr", async () => {
    await mkdir(path.join(root, ".dispatch"), { recursive: true });
    const command = ["sh", "-c", "echo reason >&2; exit 3"];
    await writeFile(
      path.join(root, ".dispatch", "tools.json"),
      JSON.stringify({ hooks: { archive: { command } } })
    );
    await expect(
      runLifecycleHook(
        "archive",
        {
          id: "fixture",
          cwd: root,
          placement: controllerPlacement,
        } as AgentRecord,
        logger,
        {}
      )
    ).rejects.toThrow(
      "Command failed (sh -c echo reason >&2; exit 3), exitCode=3, stderr=reason"
    );
  });

  it("leaves enrolled archive manifests and hooks untouched", async () => {
    const requestSession = vi.fn();
    await runLifecycleHook(
      "archive",
      {
        id: "enrolled",
        cwd: "runner://runner-a/main",
        placement: placementForRunner("runner-a"),
      } as AgentRecord,
      logger,
      { remote: { requestSession } as unknown as RemoteRunnerService }
    );
    expect(requestSession).not.toHaveBeenCalled();
  });

  it("previews configured cascade cleanup without running hooks", async () => {
    const plain = path.join(root, "plain");
    const configured = path.join(root, "configured");
    await repoWithStopHook(plain);
    await mkdir(path.join(configured, ".dispatch"), { recursive: true });
    const description =
      "Permanently deletes the owned isolated dev database and logs.";
    await writeFile(
      path.join(configured, ".dispatch", "tools.json"),
      JSON.stringify({
        hooks: {
          archive: {
            command: ["sh", "-c", "echo wiped > archived"],
            description,
          },
        },
      })
    );
    const agents = new Map<string, AgentRecord>([
      [
        "parent",
        {
          id: "parent",
          placement: controllerPlacement,
          cwd: plain,
        } as AgentRecord,
      ],
      [
        "child",
        {
          id: "child",
          placement: controllerPlacement,
          cwd: plain,
          worktreePath: plain,
          launchCwd: configured,
        } as AgentRecord,
      ],
    ]);
    const getRequiredAgent = vi.fn(async (id: string) => agents.get(id)!);
    const pool = {
      query: vi.fn(async (_sql: string, [id]: [string]) => ({
        rows: id === "parent" ? [{ id: "child" }] : [],
      })),
    } as unknown as Pool;

    await expect(
      previewArchive({ pool, getRequiredAgent }, "parent", vi.fn())
    ).resolves.toEqual({
      worktreeStatus: null,
      subAgentCount: 1,
      cleanupDescriptions: [description],
    });
    await expect(
      readFile(path.join(configured, "archived"))
    ).rejects.toMatchObject({ code: "ENOENT" });
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
    {
      id: "session",
      cwd: "runner://machine/work",
      placement: placementForRunner("machine"),
    } as AgentRecord,
    logger,
    {
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
  const agent = {
    id: "session",
    cwd: "runner://machine/work",
    placement: placementForRunner("machine"),
  } as AgentRecord;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      runLifecycleHook("stop", agent, { ...logger, warn }, { remote })
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
