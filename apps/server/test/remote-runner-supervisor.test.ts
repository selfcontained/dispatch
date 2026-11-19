import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseProcessStat,
  type SessionIdentity,
  type SessionProcesses,
} from "../src/agents/remote/session-processes.js";
import { createSessionSupervisor } from "../src/agents/remote/session-supervisor.js";

type Supervisor = Awaited<ReturnType<typeof createSessionSupervisor>>;

const marker = "DISPATCH_OWNED_00000000000000000000000000000000=1";
const identity = { pid: 100, start: "500", scope: "boot:namespace", marker };
const agentId = "agt_fixture";
const launch = (workspace: string) =>
  ({
    kind: "launch",
    agentId,
    workspace,
    launch: { engine: "codex" },
  }) as const;

describe("runner session supervision", () => {
  let root: string;
  let state: string;
  let record: string;
  let supervisor: Supervisor | undefined;
  let kernelHost: SessionIdentity | undefined;
  let locked: boolean;

  const processes = {
    acquire: vi.fn(() => {
      if (locked) throw new Error("Already locked");
      locked = true;
      return () => {
        locked = false;
      };
    }),
    alive: vi.fn(
      (record: SessionIdentity) =>
        record.scope === kernelHost?.scope &&
        record.pid === kernelHost.pid &&
        record.start === kernelHost.start
    ),
    stop: vi.fn(async (record: SessionIdentity) => {
      if (processes.alive(record)) kernelHost = undefined;
    }),
    cleanup: vi.fn(async (_identity: SessionIdentity) => {}),
    cleanupLegacy: vi.fn(async () => {}),
    socketInUse: vi.fn(() => false),
    spawn: vi.fn<SessionProcesses["spawn"]>(),
  } satisfies SessionProcesses;

  async function start(workspaces: string[]) {
    supervisor = await createSessionSupervisor(
      {
        state,
        uid: process.getuid!(),
        gid: process.getgid!(),
        ca: "ca",
        bins: { claudeBin: "", codexBin: "" },
        env: {},
        workspaces: new Set(workspaces),
        hostCommand: () => ["/test-host"],
        asWorkload: vi.fn(),
      },
      processes
    );
    return supervisor;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    processes.socketInUse.mockReturnValue(false);
    processes.spawn.mockImplementation(
      async (_command, _cwd, _env, _log, save) => {
        await save(identity);
        expect(JSON.parse(await readFile(record, "utf8"))).toEqual(identity);
        kernelHost = identity;
      }
    );
    kernelHost = undefined;
    locked = false;
    root = await mkdtemp(path.join(os.tmpdir(), "runner-supervisor-"));
    state = path.join(await realpath(root), "state");
    record = path.join(state, "bindings", agentId + ".host");
  });

  afterEach(async () => {
    supervisor?.close();
    supervisor = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { config: ["configured", "other"], workspace: "configured" },
    { config: [], workspace: "@session" },
  ])(
    "rediscovers a $workspace host and stops it under the original binding",
    async ({ config, workspace }) => {
      const first = await start(config);
      await first.launch(launch(workspace), root);
      expect((await stat(record)).mode & 0o777).toBe(0o600);

      first.close();
      const recovered = await start(config);
      expect(await recovered.alive(agentId, workspace)).toBe(true);
      expect(await recovered.liveDirectories()).toEqual([
        path.join(state, "hosts", agentId),
      ]);
      await expect(recovered.launch(launch(workspace), root)).rejects.toThrow(
        "already has a host"
      );
      await expect(recovered.discard(agentId, workspace)).rejects.toThrow(
        "Stop the guest host"
      );
      if (config.length) {
        expect(await recovered.alive(agentId, "other")).toBe(false);
        await expect(recovered.stop(agentId, "other", true)).rejects.toThrow(
          "not bound"
        );
        await expect(recovered.attach(agentId, "other")).rejects.toThrow(
          "not bound"
        );
      }
      expect(processes.spawn).toHaveBeenCalledTimes(1);

      await writeFile(path.join(state, "hosts", agentId, "host.pid"), "666\n");
      await recovered.stop(agentId, workspace, true);
      expect(processes.stop).toHaveBeenCalledExactlyOnceWith(identity, true);
      expect(processes.cleanup).toHaveBeenCalledExactlyOnceWith(identity);
      expect(await recovered.liveDirectories()).toEqual([]);
      await recovered.discard(agentId, workspace);
      await expect(
        stat(path.join(state, "hosts", agentId))
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (!config.length)
        await expect(recovered.launch(launch(workspace), root)).rejects.toThrow(
          "archived"
        );
    }
  );

  it("rejects a retry after launch was recorded but the receipt was lost", async () => {
    const first = await start(["configured"]);
    processes.spawn.mockImplementationOnce(
      async (_command, _cwd, _env, _log, save) => {
        await save(identity);
        kernelHost = identity;
        throw new Error("receipt lost");
      }
    );
    await expect(first.launch(launch("configured"), root)).rejects.toThrow(
      "receipt lost"
    );
    first.close();

    const recovered = await start(["configured"]);
    await expect(recovered.launch(launch("configured"), root)).rejects.toThrow(
      "already has a host"
    );
    expect(await recovered.alive(agentId, "configured")).toBe(true);
    expect(processes.spawn).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping launches and stops", async () => {
    const running = await start(["configured"]);
    const first = running.launch(launch("configured"), root);
    const second = running.launch(launch("configured"), root);
    const stopped = running.stop(agentId, "configured", false);
    await expect(second).rejects.toThrow("already has a host");
    await first;
    await stopped;
    expect(processes.spawn).toHaveBeenCalledTimes(1);
    expect(processes.stop).toHaveBeenCalledExactlyOnceWith(identity, false);
  });

  it("treats a recycled PID as stale and leaves an unrelated host running", async () => {
    const running = await start(["configured"]);
    await running.launch(launch("configured"), root);
    const unrelated = { ...identity, start: "501" };
    kernelHost = unrelated;
    expect(await running.alive(agentId, "configured")).toBe(false);
    expect(await running.attach(agentId, "configured")).toBeNull();
    await running.stop(agentId, "configured", true);
    expect(kernelHost).toBe(unrelated);
  });

  it("fences a legacy live socket and rejects a second supervisor", async () => {
    const running = await start(["configured"]);
    await expect(start(["configured"])).rejects.toThrow("Already locked");
    const hostDir = path.join(state, "hosts", agentId);
    await mkdir(hostDir);
    await writeFile(path.join(hostDir, "host.pid"), "100\n");
    processes.socketInUse.mockReturnValue(true);
    await expect(running.launch(launch("configured"), root)).rejects.toThrow(
      "cannot verify ownership"
    );
    await expect(running.stop(agentId, "configured", true)).rejects.toThrow(
      "cannot verify ownership"
    );
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(processes.stop).not.toHaveBeenCalled();
  });

  it("leaves the durable record in place when cleanup fails", async () => {
    const running = await start(["configured"]);
    await running.launch(launch("configured"), root);
    processes.cleanup.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(running.stop(agentId, "configured", true)).rejects.toThrow(
      "cleanup failed"
    );
    await expect(stat(record)).resolves.toBeDefined();
    await running.stop(agentId, "configured", true);
    await expect(stat(record)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("reads session and start time after a process name containing parentheses", () => {
  const stat = "100 (process ) name) S 1 100 100 " + "0 ".repeat(15) + "500 0";
  expect(parseProcessStat(stat)).toEqual({
    session: 100,
    start: "500",
    dead: false,
  });
});
