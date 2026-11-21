import { parseReadyFrame } from "@dispatch/runner-protocol";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptId,
  compatible,
  fenceRecord,
  identity,
  memoryStore,
  mockUpdater,
  target,
} from "./runner-update-fixtures.js";

const { reportIdentity, dial, spawnChild, supervisorConfig, supervisor } =
  vi.hoisted(() => {
    const reportIdentity = vi.fn();
    Object.defineProperty(
      reportIdentity,
      Symbol.for("nodejs.util.promisify.custom"),
      {
        value: (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            if (args[0] === "/usr/bin/getent") {
              resolve({ stdout: "fixture:x:1000:1001::/fixture:/bin/sh\n" });
              return;
            }
            reportIdentity(
              ...args,
              (error: Error | null, stdout: string, stderr: string) => {
                if (error) reject(error);
                else resolve({ stdout, stderr });
              }
            );
          }),
      }
    );
    const fn = () => vi.fn();
    return {
      reportIdentity,
      dial: vi.fn(),
      spawnChild: vi.fn(),
      supervisorConfig: vi.fn(),
      supervisor: {
        launch: fn(),
        sessionFile: fn(),
        checkoutRelease: fn(),
        withCommandCheckout: fn(),
        checkoutDirectory: fn(),
        sessionCheckout: fn(),
        alive: fn(),
        attach: fn(),
        stop: fn(),
        discard: fn(),
        log: fn(),
        isBound: fn(),
        inspectHandoff: fn(),
        liveDirectories: fn(),
        close: fn(),
      },
    };
  });

vi.mock("node:process", async (original) => {
  const { default: process } = await original<typeof import("node:process")>();
  return {
    default: Object.create(process, {
      platform: { value: "linux" },
      getuid: { value: () => 0 },
    }),
  };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: reportIdentity,
  spawn: spawnChild,
}));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  connect: dial,
}));
vi.mock("../src/agents/remote/session-supervisor.js", async (original) => ({
  ...(await original<
    typeof import("../src/agents/remote/session-supervisor.js")
  >()),
  createSessionSupervisor: async (config: unknown) => {
    supervisorConfig(config);
    return supervisor;
  },
}));

import {
  runRemoteRunner,
  type RunnerUpdateOptions,
} from "../src/agents/remote/runner.js";
import { fileFenceStore } from "../src/agents/remote/update-fence-store.js";

const unprivilegedStatus = [
  "Uid:\t1000\t1000\t1000\t1000",
  "Gid:\t1001\t1001\t1001\t1001",
  "Groups:\t1001",
  "CapInh:\t0000000000000000",
  "CapPrm:\t0000000000000000",
  "CapEff:\t0000000000000000",
  "CapBnd:\t0000000000000000",
  "CapAmb:\t0000000000000000",
  "NoNewPrivs:\t1",
].join("\n");

const session = { agentId: "agt_one", workspace: "@session" };
/** Every command that may start a process, with a valid payload. */
const fencedCommands = {
  launch: {
    ...session,
    kind: "launch",
    launch: {
      agentId: "agt_one",
      engine: "claude",
      model: null,
      systemPrompt: null,
      resumeSessionId: null,
      repository: {
        url: "https://github.com/example/repo",
        checkout: { kind: "default" },
      },
      prepareWorkspace: true,
    },
  },
  sessionFile: {
    ...session,
    kind: "sessionFile",
    operation: { kind: "collect", path: "notes.md" },
  },
  watchCheckout: { ...session, kind: "watchCheckout" },
  openTerminal: { ...session, kind: "openTerminal" },
  viewCheckout: {
    ...session,
    kind: "viewCheckout",
    query: { kind: "directory", path: "" },
  },
  inspectCheckout: {
    ...session,
    kind: "inspectCheckout",
    query: { kind: "roots" },
  },
  sessionCheckout: {
    ...session,
    kind: "sessionCheckout",
    operation: { kind: "describe" },
  },
  checkoutCommand: {
    ...session,
    kind: "checkoutCommand",
    operation: { kind: "read", checkout: "effective", path: "README.md" },
  },
  checkoutRelease: {
    ...session,
    kind: "checkoutRelease",
    operation: { kind: "observe" },
  },
  repo: { ...session, kind: "repo" },
  stop: { ...session, kind: "stop", force: false },
  discard: { ...session, kind: "discard" },
  engineCapability: {
    ...session,
    kind: "engine",
    operation: { type: "provider_usage" },
  },
  engineStatus: { ...session, kind: "engine", operation: { type: "status" } },
  github: { ...session, kind: "github", operation: { type: "status" } },
} as const;

type Socket = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  writableLength: number;
  destroyed: boolean;
};

describe("runner update fence", () => {
  let root: string;
  let config: string;
  let socket: Socket;
  let running: Promise<unknown>;
  /** Write callbacks, flushed by the test unless `autoFlush`. */
  let pendingFlush: (() => void)[];
  let autoFlush: boolean;
  const end = new Error("end simulated runner");

  const frames = () =>
    socket.write.mock.calls.map(([line]) => JSON.parse(line as string));
  const statuses = () => frames().filter((f) => f.type === "update_status");
  const resultFor = (id: string) =>
    frames().find((f) => f.type === "result" && f.id === id);
  const emit = (frame: object) =>
    socket.emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
  const request = (id: string, command: object) =>
    emit({ type: "request", id, command });

  async function start(options: RunnerUpdateOptions) {
    socket = Object.assign(new EventEmitter(), {
      write: vi.fn((_line: string, flushed?: () => void) => {
        if (!flushed) return true;
        if (autoFlush) queueMicrotask(flushed);
        else pendingFlush.push(flushed);
        return true;
      }),
      destroy: vi.fn(),
      writableLength: 0,
      destroyed: false,
    });
    dial.mockReturnValueOnce(socket).mockImplementation(() => {
      throw end;
    });
    running = runRemoteRunner(config, options).catch((error) => error);
    await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1));
    socket.emit("secureConnect");
    return parseReadyFrame(frames()[0]);
  }

  async function stagedAndFenced(retainSessions = true) {
    emit({ type: "update_offer", attemptId, target, retry: false });
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ reason: "ready" })
    );
    emit({ type: "update_fence", attemptId, retainSessions });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    pendingFlush = [];
    autoFlush = true;
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-fence-"));
    config = path.join(root, "runner.json");
    const key = path.join(root, "key");
    await writeFile(key, "unused test credential", { mode: 0o600 });
    await writeFile(
      config,
      JSON.stringify({
        endpoint: "https://192.0.2.1",
        key,
        cert: key,
        ca: key,
        state: path.join(root, "state"),
        uid: 1000,
        gid: 1001,
        home: root,
        path: "/usr/bin:/bin",
        bins: {},
        workspaces: {},
      })
    );
    reportIdentity.mockImplementation((_command, _args, _options, callback) =>
      callback(null, unprivilegedStatus, "")
    );
    supervisor.inspectHandoff.mockResolvedValue({
      retained: [],
      requiresQuiescence: false,
      live: 0,
    });
    supervisor.liveDirectories.mockResolvedValue([]);
    supervisor.alive.mockResolvedValue(true);
    supervisor.log.mockResolvedValue("Guest agent host log.");
  });

  afterEach(async () => {
    socket?.emit("close");
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
    }
    if (running) await running;
    await rm(root, { recursive: true, force: true });
  });

  it("advertises nothing new to a controller unless the updater is installed", async () => {
    const legacy = await start({
      updateIdentity: null,
      fenceStore: memoryStore(),
    });
    expect(frames()[0]).not.toHaveProperty("selfUpdate");
    expect(legacy).not.toHaveProperty("selfUpdate");
    // A controller that sends update frames anyway is a protocol violation.
    emit({ type: "update_offer", attemptId, target, retry: false });
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("advertises the installed identity and the handoff formats", async () => {
    const ready = await start({
      updateIdentity: identity,
      updater: mockUpdater(),
      fenceStore: memoryStore(),
    });
    expect(ready?.selfUpdate).toEqual({
      protocol: 1,
      os: "linux",
      arch: identity.arch,
      version: identity.version,
      revision: identity.revision,
      installedSha256: identity.sha256,
      handoff: identity.handoff,
    });
    // An old controller parses the same capabilities as before.
    const { selfUpdate: _, ...rest } = frames()[0];
    expect(parseReadyFrame(rest)).toEqual(
      (({ selfUpdate: _s, ...legacy }) => legacy)(ready!)
    );
  });

  it("a supervisor restarted while fenced refuses every spawning command before it starts", async () => {
    const state = path.join(root, "update");
    await mkdir(state, { mode: 0o700 });
    await fileFenceStore(state).write({
      ...fenceRecord,
      phase: "fenced",
    });
    const ready = await start({
      updateIdentity: identity,
      updater: mockUpdater(),
      updateLayout: {
        config: "",
        installed: "",
        staging: "",
        state,
      },
    });
    expect(ready?.selfUpdate?.pendingAttemptId).toBe(attemptId);
    const startupCalls = reportIdentity.mock.calls.length;
    for (const [id, command] of Object.entries(fencedCommands)) {
      request(id, command);
      expect(resultFor(id)).toEqual({
        type: "result",
        id,
        code: "update-fenced",
        error: "The runner is updating; the operation was not started.",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const method of Object.values(supervisor))
      if (method !== supervisor.close) expect(method).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
    expect(reportIdentity.mock.calls.length).toBe(startupCalls);

    // The supervisor's own self-spawn seam and sweep are closed too.
    const options = supervisorConfig.mock.calls[0]![0];
    expect(() => options.hostCommand("/state/hosts/agt_one")).toThrow(
      "not started"
    );
    expect(options.mayStartProcess()).toBe(false);

    // Host attach and inspection stay available.
    request("alive", { ...session, kind: "alive" });
    request("log", { ...session, kind: "log" });
    await vi.waitFor(() =>
      expect(resultFor("log")).toMatchObject({ value: "Guest agent host log." })
    );
    expect(resultFor("alive")).toMatchObject({ value: true });

    // Implicit engine probes are skipped.
    emit({ type: "accept_health", engineInventory: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(frames().some((f) => f.type === "engine_inventory")).toBe(false);

    // A wrong attempt cannot release it; the matching cancel does.
    emit({
      type: "update_cancel",
      attemptId: "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
      reason: "policy_changed",
    });
    request("still-fenced", fencedCommands.stop);
    expect(resultFor("still-fenced")).toMatchObject({ code: "update-fenced" });
    emit({ type: "update_cancel", attemptId, reason: "policy_changed" });
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({
        attemptId,
        reason: "cancelled",
      })
    );
    await expect(readFile(path.join(state, "fence.json"))).rejects.toThrow();
    supervisor.stop.mockResolvedValue(undefined);
    request("released", fencedCommands.stop);
    await vi.waitFor(() =>
      expect(resultFor("released")).toMatchObject({ value: true })
    );
    expect(() => options.hostCommand("/state/hosts/agt_one")).not.toThrow();
  });

  it("flushes the reply of work admitted before the fence ahead of fence_ready", async () => {
    await start({
      updateIdentity: identity,
      updater: mockUpdater(compatible),
      fenceStore: memoryStore(),
    });
    let finish!: (value: string) => void;
    supervisor.withCommandCheckout.mockReturnValue(
      new Promise((resolve) => (finish = resolve))
    );
    emit({ type: "update_offer", attemptId, target, retry: false });
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ reason: "ready" })
    );
    // Admitted in frame order, just before the fence.
    request("admitted", fencedCommands.checkoutCommand);
    emit({ type: "update_fence", attemptId, retainSessions: true });
    request("late", fencedCommands.checkoutCommand);
    expect(resultFor("late")).toMatchObject({ code: "update-fenced" });
    expect(supervisor.withCommandCheckout).toHaveBeenCalledOnce();

    autoFlush = false;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statuses().at(-1)?.reason).toBe("ready");
    finish('{"ok":true}');
    await vi.waitFor(() => expect(resultFor("admitted")).toBeDefined());
    // Produced but not yet handed to the transport: still not ready.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statuses().at(-1)?.reason).toBe("ready");
    autoFlush = true;
    for (const flush of pendingFlush.splice(0)) flush();
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ reason: "fence_ready" })
    );
    const order = frames().map((f) => f.id ?? f.reason);
    expect(order.indexOf("admitted")).toBeLessThan(
      order.indexOf("fence_ready")
    );
    expect(supervisor.inspectHandoff).toHaveBeenCalledWith(
      compatible.outcome === "staged" && compatible.compatibility!.handoff
    );
  });

  it("defers and reopens admission when admitted work outlives its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await start({
      updateIdentity: identity,
      updater: mockUpdater(compatible),
      fenceStore: memoryStore(),
    });
    supervisor.stop.mockReturnValueOnce(new Promise(() => {}));
    request("stuck", fencedCommands.stop);
    await stagedAndFenced();
    await vi.advanceTimersByTimeAsync(20_000 + 4_000);
    expect(statuses().at(-1)?.reason).toBe("ready");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses().at(-1)).toMatchObject({
      phase: "deferred",
      reason: "operations_pending",
    });
    supervisor.stop.mockResolvedValue(undefined);
    request("after", fencedCommands.stop);
    await vi.waitFor(() =>
      expect(resultFor("after")).toMatchObject({ value: true })
    );
  });

  it("closes an open terminal with the update reason after a grace period", async () => {
    await start({
      updateIdentity: identity,
      updater: mockUpdater(compatible),
      fenceStore: memoryStore(),
      terminalGraceMs: 1_000,
    });
    supervisor.checkoutDirectory.mockResolvedValue("/fixture");
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdin,
      kill: vi.fn(),
    });
    spawnChild.mockReturnValue(child);
    request("terminal", fencedCommands.openTerminal);
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledOnce());
    expect(spawnChild.mock.calls[0]![1]).toContain("runner-terminal");
    stdout.write(
      JSON.stringify({
        type: "ready",
        info: { cwd: "/fixture", host: "runner", user: "fixture" },
      }) + "\n"
    );
    await vi.waitFor(() =>
      expect(resultFor("terminal")).toMatchObject({ value: expect.any(String) })
    );
    await stagedAndFenced();
    // The terminal is open until its grace period ends, and the boundary
    // is reported only after it was closed with its notice.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(child.kill).not.toHaveBeenCalled();
    expect(statuses().at(-1)?.reason).toBe("ready");
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ reason: "fence_ready" })
    );
    expect(child.kill).toHaveBeenCalled();
    const events = frames()
      .filter((f) => f.type === "data" && f.id === "terminal")
      .map((f) => JSON.parse(Buffer.from(f.data, "base64").toString()));
    expect(events).toContainEqual({
      type: "error",
      message: expect.stringContaining("runner is updating"),
      reason: "update",
    });
    const all = frames();
    expect(
      all.findIndex((f) => f.type === "close" && f.id === "terminal")
    ).toBeLessThan(all.findIndex((f) => f.reason === "fence_ready"));
    // Nothing new starts after the fence.
    expect(spawnChild).toHaveBeenCalledOnce();
  });
});
