import type { Pool } from "pg";
import {
  executeArchive,
  previewArchive,
  type ArchiveDeps,
} from "../src/agents/archive.js";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync, renameSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { checkoutCommandTimeoutMs } from "@dispatch/runner-protocol";

import * as directories from "../src/runners/directory.js";
import { requestCheckoutCommand } from "../src/agents/checkout-commands.js";
import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import type { AgentRecord } from "../src/agents/types.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";

vi.mock("node:child_process", async (load) => {
  const child = await load<typeof import("node:child_process")>();
  return { ...child, spawn: vi.fn(child.spawn) };
});
vi.mock("node:fs/promises", async (load) => {
  const fs = await load<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

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

  function localArchiveAgent(): AgentRecord {
    return {
      id: "agt_hook",
      placement: controllerPlacement,
      cwd: root,
      worktreePath: null,
      workspacePath: null,
    } as AgentRecord;
  }

  async function previewLocalArchive() {
    return previewArchive(
      {
        pool: { query: async () => ({ rows: [] }) } as unknown as Pool,
        getRequiredAgent: async () => localArchiveAgent(),
      },
      localArchiveAgent().id,
      vi.fn()
    );
  }

  const archiveManifest = JSON.stringify({
    hooks: {
      archive: {
        command: ["sh", "-c", 'echo "$DISPATCH_AGENT_ID" >> invoked'],
        description: "Clean up",
      },
    },
  });

  it("reads an archive manifest from a FIFO for preview and execution", async () => {
    const manifest = path.join(root, ".dispatch/tools.json");
    await mkdir(path.dirname(manifest));
    execFileSync("mkfifo", [manifest]);
    async function supplyManifest<T>(read: () => Promise<T>) {
      const writer = spawn("sh", [
        "-c",
        'printf %s "$1" > "$2"',
        "sh",
        archiveManifest,
        manifest,
      ]);
      try {
        return await read();
      } finally {
        writer.kill();
      }
    }
    await supplyManifest(async () => {
      expect((await previewLocalArchive()).cleanupDescriptions).toEqual([
        "Clean up",
      ]);
    });
    await supplyManifest(() =>
      runLifecycleHook("archive", localArchiveAgent(), logger, {})
    );
    expect(await readFile(path.join(root, "invoked"), "utf8")).toBe(
      "agt_hook\n"
    );
  });

  it.each([false, true])(
    "executes the current regular-file archive hook after preview (edited %s)",
    async (edited) => {
      const manifest = path.join(root, ".dispatch/tools.json");
      await mkdir(path.dirname(manifest));
      await writeFile(manifest, archiveManifest);
      expect((await previewLocalArchive()).cleanupDescriptions).toEqual([
        "Clean up",
      ]);
      if (edited)
        await writeFile(
          manifest,
          JSON.stringify({
            hooks: {
              archive: {
                description: "Edited",
                command: ["sh", "-c", "echo edited >> invoked"],
              },
            },
          })
        );
      await runLifecycleHook("archive", localArchiveAgent(), logger, {});
      expect(await readFile(path.join(root, "invoked"), "utf8")).toBe(
        edited ? "edited\n" : "agt_hook\n"
      );
    }
  );

  it("runs the resolved archive command once after an unrelated manifest edit", async () => {
    const manifest = path.join(root, ".dispatch/tools.json");
    await mkdir(path.dirname(manifest));
    await writeFile(manifest, archiveManifest);
    let calls = 0;
    await runLifecycleHook(
      "archive",
      localArchiveAgent(),
      logger,
      {},
      async (request) => {
        if (++calls === 2)
          await writeFile(
            manifest,
            JSON.stringify({ ...JSON.parse(archiveManifest), tools: [] })
          );
        return request();
      }
    );
    expect(await readFile(path.join(root, "invoked"), "utf8")).toBe(
      "agt_hook\n"
    );
  });

  it("rejects a replacement directory at the same path before spawning an archive command", async () => {
    const selected = path.join(root, "selected");
    await mkdir(path.join(selected, ".dispatch"), { recursive: true });
    await writeFile(
      path.join(selected, ".dispatch/tools.json"),
      archiveManifest
    );
    let calls = 0;
    const parked = path.join(root, "parked");
    await expect(
      runLifecycleHook(
        "archive",
        { ...localArchiveAgent(), cwd: selected },
        logger,
        {},
        async (request) => {
          if (++calls === 2) {
            await rename(selected, parked);
            await mkdir(selected);
          }
          return request();
        }
      )
    ).rejects.toMatchObject({ code: "stale" });
    for (const dir of [selected, parked])
      await expect(readFile(path.join(dir, "invoked"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("passes the validated directory to spawn even if the selected alias resolves elsewhere at launch", async () => {
    const selected = path.join(root, "selected");
    const original = path.join(root, "original");
    await mkdir(path.join(original, ".dispatch"), { recursive: true });
    await writeFile(
      path.join(original, ".dispatch/tools.json"),
      archiveManifest
    );
    await symlink(original, selected);
    const expected = await realpath(original);
    const replacement = path.join(root, "replacement");
    const next = path.join(root, "next");
    await mkdir(replacement);
    await symlink(replacement, next);
    // Inspect the actual cwd argument at the spawn boundary without starting a child.
    let launchDirectory: string | undefined;
    const observed = new Error("Observed spawn");
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => {
      renameSync(next, selected);
      if (typeof options.cwd === "string")
        launchDirectory = realpathSync(options.cwd);
      throw observed;
    });
    await expect(
      runLifecycleHook(
        "archive",
        { ...localArchiveAgent(), cwd: selected },
        logger,
        {}
      )
    ).rejects.toThrow(observed.message);
    expect(launchDirectory).toBe(expected);
  });

  it("treats a manifest read failure without syscall metadata as absent", async () => {
    const failure = Object.assign(new RangeError("File is too large"), {
      code: "ERR_FS_FILE_TOO_LARGE",
    });
    vi.mocked(readFile).mockRejectedValueOnce(failure);
    expect((await previewLocalArchive()).cleanupDescriptions).toEqual([]);
    vi.mocked(readFile).mockRejectedValueOnce(failure);
    await expect(
      runLifecycleHook("archive", localArchiveAgent(), logger, {})
    ).resolves.toBeUndefined();
  });

  it("propagates transport failures carrying syscall metadata", async () => {
    const failure = new RunnerCallError({
      code: "failed",
      message: "Binding lookup failed",
      details: { syscall: "read" },
    });
    const child = {
      connection: { epoch: 1 },
      call: vi.fn().mockRejectedValue(failure),
    } as unknown as Runner;
    await expect(
      runLifecycleHook("archive", localArchiveAgent(), logger, {
        child: () => child,
      })
    ).rejects.toBe(failure);
  });

  it("retains invalid archive definitions while treating native file errors as absent", async () => {
    const manifest = path.join(root, ".dispatch/tools.json");
    await mkdir(manifest, { recursive: true });
    await expect(
      runLifecycleHook("archive", localArchiveAgent(), logger, {})
    ).resolves.toBeUndefined();
    await rm(manifest, { recursive: true });
    await writeFile(
      manifest,
      JSON.stringify({ hooks: { archive: { command: [] } } })
    );
    await expect(
      runLifecycleHook("archive", localArchiveAgent(), logger, {})
    ).rejects.toThrow('Hook "archive" must include a non-empty command array.');
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

  it("previews and executes the enrolled runner's resolved command once in its session checkout", async () => {
    const directory = "/workload/owned";
    const agent = {
      id: "enrolled",
      cwd: directory,
      placement: placementForRunner("runner-a"),
    } as AgentRecord;
    const call = vi.fn(async (op: string) => {
      if (op === "workspace.observe")
        return {
          ownership: "owned",
          owner: "enrolled",
          borrowers: [],
          checkout: null,
        };
      if (op === "checkout.read")
        return {
          data: archiveManifest,
          root: directory,
          rootIdentity: "native-id",
        };
      if (op === "workspace.release") return { removed: true };
      if (op === "checkout.exec")
        return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error(op);
    });
    const adapter = vi.spyOn(directories, "checkoutRunners").mockReturnValue({
      placement: agent.placement,
      directory: {
        for: () => ({
          call,
          archive: directories.enrolledArchivePolicy,
        }),
      },
    } as never);
    try {
      const preview = await previewArchive(
        {
          pool: { query: async () => ({ rows: [] }) } as unknown as Pool,
          getRequiredAgent: async () => agent,
        },
        agent.id,
        vi.fn()
      );
      expect(preview.cleanupDescriptions).toEqual(["Clean up"]);
      expect(call.mock.calls.map(([op]) => op)).toEqual([
        "workspace.observe",
        "checkout.read",
      ]);
      const onComplete = vi.fn();
      const onError = vi.fn();
      await executeArchive(
        {
          pool: { query: async () => ({ rows: [] }) },
          logger: { ...logger, error: vi.fn() },
          getRequiredAgent: async () => agent,
          getAgent: async () => agent,
          runtime: { stop: vi.fn(), clearRemoteState: vi.fn() },
          beginStopStream: vi.fn(),
          settleStream: vi.fn(),
          setArchivePhase: vi.fn(),
        } as unknown as ArchiveDeps,
        agent.id,
        { onPhaseChange: vi.fn(), onComplete, onError }
      );
      expect(onError).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith([agent.id]);
      expect(call.mock.calls.map(([op]) => op)).toEqual([
        "workspace.observe",
        "checkout.read",
        "workspace.observe",
        "checkout.read",
        "checkout.exec",
        "workspace.observe",
        "workspace.release",
      ]);
      expect(call).toHaveBeenCalledWith(
        "checkout.exec",
        expect.objectContaining({
          target: { session: agent.id, checkout: "launch" },
          guard: { root: directory, identity: "native-id" },
          timeoutMs: 60000,
          env: { DISPATCH_AGENT_ID: agent.id },
        })
      );
    } finally {
      adapter.mockRestore();
    }
  });

  it("resumes after a disconnect between checkouts without running the acknowledged command twice", async () => {
    const agent = {
      ...localArchiveAgent(),
      workspacePath: path.join(root, "moved"),
    };
    await mkdir(path.join(root, ".dispatch"));
    await mkdir(path.join(agent.workspacePath, ".dispatch"), {
      recursive: true,
    });
    await writeFile(path.join(root, ".dispatch/tools.json"), archiveManifest);
    await writeFile(
      path.join(agent.workspacePath, ".dispatch/tools.json"),
      archiveManifest
    );
    const movedManifest = await realpath(
      path.join(agent.workspacePath, ".dispatch/tools.json")
    );
    const original = vi.mocked(readFile).getMockImplementation()!;
    let offline = true;
    vi.mocked(readFile).mockImplementation((...args) => {
      if (offline && args[0] === movedManifest)
        return Promise.reject(
          new RunnerCallError({ code: "unavailable", message: "offline" })
        );
      return original(...args);
    });
    try {
      const runners = {
        recordArchivePhase: async (phase: AgentRecord["archivePhase"]) => {
          agent.archivePhase = phase;
        },
      };
      await expect(
        runLifecycleHook("archive", agent, logger, runners)
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(agent.archivePhase).toBe("archive-launch-complete");
      offline = false;
      await runLifecycleHook("archive", agent, logger, runners);
      expect(await readFile(path.join(root, "invoked"), "utf8")).toBe(
        "agt_hook\n"
      );
      expect(
        await readFile(path.join(agent.workspacePath, "invoked"), "utf8")
      ).toBe("agt_hook\n");
      expect(agent.archivePhase).toBe("archive-hooks-complete");
      agent.archivePhase = "archive-hook-running";
      await expect(
        runLifecycleHook("archive", agent, logger, runners)
      ).rejects.toMatchObject({ code: "unknown_outcome" });
    } finally {
      vi.mocked(readFile).mockImplementation(original);
    }
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
  const call = vi.fn(async (_runner, op, input) => {
    const kind = op === "checkout.read" ? "read" : "run";
    kinds.push(input.target.checkout + " " + kind);
    if (refused.delete(kind)) throw new Error("fenced");
    if (kind === "read")
      return {
        data: JSON.stringify({ hooks: { stop: { command: ["true"] } } }),
        digest: "a".repeat(64),
      };
    return { exitCode: 0, stderr: "", stdout: "", truncated: false };
  });
  await runLifecycleHook(
    "stop",
    {
      id: "session",
      cwd: "/machine/work",
      placement: placementForRunner("machine"),
    } as AgentRecord,
    logger,
    {
      remote: { call } as unknown as RemoteRunnerService,
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
  const call = vi.fn(async (_runner, op, input) => {
    const checkout = input.target.checkout;
    if (op === "checkout.read")
      return {
        data: JSON.stringify({
          hooks: { stop: { command: ["cleanup", checkout] } },
        }),
        digest: "a".repeat(64),
      };
    return {
      exitCode: checkout === "launch" ? 23 : 0,
      stderr: "cleanup failed",
      stdout: "",
      truncated: false,
    };
  });
  const remote = { call } as unknown as RemoteRunnerService;
  const agent = {
    id: "session",
    cwd: "/machine/work",
    placement: placementForRunner("machine"),
  } as AgentRecord;
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      runLifecycleHook("stop", agent, { ...logger, warn }, { remote })
    ).resolves.toBeUndefined();
  }
  expect(
    call.mock.calls.map(([, op, input]) => [
      input.target.checkout,
      op === "checkout.read" ? "read" : "run",
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
