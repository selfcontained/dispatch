import { streamHelper } from "./helpers/stream-helper.js";
import { embeddedBuild } from "../src/agents/build-identity.js";
import { gitSha, packageVersion } from "../src/generated/runtime-assets.js";
import { issueAuthority } from "../src/agents/remote/certificate-authority.js";
import { channelStreams } from "@dispatch/runner-client/transport/local-socket";

import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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
        launchSession: fn(),
        withSessionFile: fn(),
        observeWorkspace: fn(),
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
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/session-supervisor.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../packages/runner/src/workload/agents/remote/session-supervisor.js")
    >()),
    createSessionSupervisor: async (config: unknown) => {
      supervisorConfig(config);
      return supervisor;
    },
  })
);

import {
  runRemoteRunner,
  type RunnerUpdateOptions,
} from "../../../packages/runner/src/workload/agents/remote/runner.js";
import { fileFenceStore } from "../../../packages/runner/src/workload/agents/remote/update-fence-store.js";

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

const session = { session: "agt_one" };
const sessionTarget = { target: session };
const fencedCommands = {
  "session.launch": {
    ...session,
    launchId: attemptId,
    engine: "claude",
    model: null,
    effort: null,
    access: "default",
    resume: null,
    systemText: null,
    firstText: null,
    overflowNotice: null,
    env: {},
    mcp: [],
    owner: null,
  },
  "files.get": { ...session, path: "notes.md" },
  "checkout.watch": sessionTarget,
  "terminal.open": { ...sessionTarget, rows: 24, cols: 80 },
  "checkout.list": { ...sessionTarget, path: "" },
  "git.roots": sessionTarget,
  "workspace.describe": session,
  "checkout.read": {
    ...sessionTarget,
    path: "README.md",
    encoding: "utf8",
    maxBytes: null,
  },
  "workspace.observe": session,
  "session.stop": { ...session, force: false },
  "session.discard": session,
  "session.retire": session,
  "engine.list": { refresh: false, background: true },
  "github.account": {},
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
  let nextId = 0;
  const ids = new Map<string, number>();
  const resultFor = (label: string) =>
    frames().find((f) => f.id === ids.get(label) && typeof f.ok === "boolean");
  const send = (frame: object) =>
    socket.emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
  const request = (label: string, op: string, input: object = {}) => {
    const id = ++nextId;
    ids.set(label, id);
    send({ id, op, input });
  };
  const update = (name: string, input: object) =>
    request(name + ids.size, "update." + name, input);

  async function start(
    options: Omit<RunnerUpdateOptions, "build" | "healthBuild" | "streamHelper">
  ) {
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
    running = runRemoteRunner(config, {
      build: embeddedBuild,
      healthBuild: { version: packageVersion, revision: gitSha },
      streamHelper,
      ...options,
    }).catch((error) => error);
    await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1));
    socket.emit("secureConnect");
    request("description", "runner.describe");
    await vi.waitFor(() => expect(resultFor("description")?.ok).toBe(true));
    return resultFor("description").value.capabilities;
  }

  async function stagedAndFenced(retainSessions = true) {
    update("offer", { attempt: attemptId, target, retry: false });
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ reason: "ready" })
    );
    update("fence", { attempt: attemptId, retained: retainSessions });
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    pendingFlush = [];
    ids.clear();
    autoFlush = true;
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-fence-"));
    config = path.join(root, "runner.json");
    const key = path.join(root, "key");
    await writeFile(key, issueAuthority("fixture").cert, { mode: 0o600 });
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
    supervisor.isBound.mockResolvedValue(true);
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
    // An unavailable updater answers the authenticated request.
    update("offer", { attempt: attemptId, target, retry: false });
    await vi.waitFor(() =>
      expect(frames().at(-1)).toMatchObject({
        ok: false,
        error: { code: "unsupported" },
      })
    );
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
  });

  it("reports health again once an update is confirmed", async () => {
    const at = "2026-01-10T12:00:00Z";
    await writeFile(
      path.join(root, "last-maintenance-failure.json"),
      JSON.stringify({ step: "stage", exitCode: 1, at })
    );
    await start({
      updateIdentity: identity,
      updater: mockUpdater(),
      fenceStore: memoryStore(),
      updateLayout: {
        config: "",
        installed: path.join(root, "dispatch"),
        staging: "",
        state: root,
      },
    });
    request("before", "runner.health");
    await vi.waitFor(() =>
      expect(resultFor("before")?.value.maintenanceFailure?.at).toBe(at)
    );
    // What a commit does before its confirmation is reported.
    const installed = path.join(root, "installed-release");
    await writeFile(installed, "1:2 v1.7.28\n");
    const later = new Date(Date.parse(at) + 60_000);
    await utimes(installed, later, later);
    update("offer", {
      attempt: attemptId,
      target: { ...target, sha256: identity.sha256 },
      retry: false,
    });
    await vi.waitFor(() => expect(statuses().at(-1)?.phase).toBe("confirmed"));
    request("after", "runner.health");
    await vi.waitFor(() => expect(resultFor("after")?.ok).toBe(true));
    expect(resultFor("after").value.maintenanceFailure).toBeUndefined();
  });

  it("sends no health to a controller that never accepted it", async () => {
    await start({
      updateIdentity: identity,
      updater: mockUpdater(),
      fenceStore: memoryStore(),
    });
    update("offer", {
      attempt: attemptId,
      target: { ...target, sha256: identity.sha256 },
      retry: false,
    });
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({ phase: "confirmed" })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames().filter((frame) => frame.type === "health")).toEqual([]);
  });

  it("a supervisor restarted while fenced refuses every spawning command before it starts", async () => {
    const state = path.join(root, "update");
    await mkdir(state, { mode: 0o700 });
    const persisted = { ...fenceRecord, phase: "fenced" } as const;
    const store = fileFenceStore(state);
    await store.write(persisted);
    expect(await store.read()).toEqual(persisted);
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
      request(id, id, command);
      expect(resultFor(id)).toEqual({
        ok: false,
        id: ids.get(id),
        error: {
          code: "fenced",
          message: "The runner is updating; the operation was not started.",
        },
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
    request("alive", "session.alive", session);
    request("log", "session.logs", { ...session, lines: 10 });
    await vi.waitFor(() =>
      expect(resultFor("log")).toMatchObject({
        value: { text: "Guest agent host log." },
      })
    );
    expect(resultFor("alive")).toMatchObject({ value: { state: "live" } });

    // Implicit engine probes are skipped.
    request("inventory", "engine.list", { refresh: false, background: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resultFor("inventory")).toMatchObject({ error: { code: "fenced" } });
    expect(spawnChild).not.toHaveBeenCalled();

    // A wrong attempt cannot release it; the matching cancel does.
    update("cancel", {
      attempt: "7f1c1d1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f",
      reason: "policy_changed",
    });
    request("still-fenced", "session.stop", fencedCommands["session.stop"]);
    expect(resultFor("still-fenced")).toMatchObject({
      error: { code: "fenced" },
    });
    update("cancel", { attempt: attemptId, reason: "policy_changed" });
    await vi.waitFor(() =>
      expect(statuses().at(-1)).toMatchObject({
        attemptId,
        reason: "cancelled",
      })
    );
    await expect(readFile(path.join(state, "fence.json"))).rejects.toThrow();
    supervisor.stop.mockResolvedValue(undefined);
    request("released", "session.stop", fencedCommands["session.stop"]);
    await vi.waitFor(() =>
      expect(resultFor("released")).toMatchObject({ ok: true, value: {} })
    );
    expect(() => options.hostCommand("/state/hosts/agt_one")).not.toThrow();
  });

  it.each([true, false])(
    "flushes one admitted session stop before fence_ready (retain sessions: %s)",
    async (retainSessions) => {
      await start({
        updateIdentity: identity,
        updater: mockUpdater(compatible),
        fenceStore: memoryStore(),
      });
      let finish!: () => void;
      supervisor.stop.mockReturnValue(
        new Promise((resolve) => (finish = resolve))
      );
      update("offer", { attempt: attemptId, target, retry: false });
      await vi.waitFor(() =>
        expect(statuses().at(-1)).toMatchObject({ reason: "ready" })
      );
      // Admitted in frame order, just before the fence.
      request("admitted", "session.stop", fencedCommands["session.stop"]);
      update("fence", { attempt: attemptId, retained: retainSessions });
      request("late", "session.stop", fencedCommands["session.stop"]);
      expect(resultFor("late")).toMatchObject({ error: { code: "fenced" } });
      expect(supervisor.stop).toHaveBeenCalledOnce();

      autoFlush = false;
      expect(statuses().at(-1)?.reason).toBe("ready");
      finish();
      await vi.waitFor(() => expect(resultFor("admitted")).toBeDefined());
      // Produced but not yet handed to the transport: still not ready.
      expect(pendingFlush).toHaveLength(1);
      expect(statuses().at(-1)?.reason).toBe("ready");
      autoFlush = true;
      for (const flush of pendingFlush.splice(0)) flush();
      await vi.waitFor(() =>
        expect(statuses().at(-1)).toMatchObject({ reason: "fence_ready" })
      );
      const order = frames().map((f) => f.id ?? f.reason);
      expect(order.indexOf(ids.get("admitted"))).toBeLessThan(
        order.indexOf("fence_ready")
      );
      expect(supervisor.stop).toHaveBeenCalledOnce();
    }
  );

  it("defers and reopens admission when admitted work outlives its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await start({
      updateIdentity: identity,
      updater: mockUpdater(compatible),
      fenceStore: memoryStore(),
    });
    supervisor.stop.mockReturnValueOnce(new Promise(() => {}));
    request("stuck", "session.stop", fencedCommands["session.stop"]);
    await stagedAndFenced();
    await vi.advanceTimersByTimeAsync(20_000 + 4_000);
    expect(statuses().at(-1)?.reason).toBe("ready");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses().at(-1)).toMatchObject({
      phase: "deferred",
      reason: "operations_pending",
    });
    supervisor.stop.mockResolvedValue(undefined);
    request("after", "session.stop", fencedCommands["session.stop"]);
    await vi.waitFor(() =>
      expect(resultFor("after")).toMatchObject({ ok: true, value: {} })
    );
  });

  it.each([
    { retainSessions: true, credit: true },
    { retainSessions: false, credit: true },
    { retainSessions: true, credit: false },
  ])(
    "closes the terminal at the deadline and reopens on the new supervisor (retain $retainSessions, credit $credit)",
    async ({ retainSessions, credit }) => {
      await start({
        updateIdentity: identity,
        updater: mockUpdater(compatible),
        fenceStore: memoryStore(),
        terminalGraceMs: 1_000,
      });
      supervisor.checkoutDirectory.mockResolvedValue("/fixture");
      const shell = () =>
        Object.assign(new EventEmitter(), {
          stderr: new PassThrough(),
          stdout: new PassThrough(),
          stdin: new PassThrough(),
          kill: vi.fn(),
        });
      const child = shell();

      spawnChild.mockReturnValue(child);
      request("terminal", "terminal.open", fencedCommands["terminal.open"]);
      await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledOnce());
      expect(spawnChild.mock.calls[0]![1]).toContain("runner-terminal");
      child.stderr.end(
        JSON.stringify({ cwd: "/fixture", host: "runner", user: "fixture" })
      );
      await vi.waitFor(() =>
        expect(resultFor("terminal")).toMatchObject({
          value: { cwd: "/fixture", host: "runner", user: "fixture" },
        })
      );
      const output = channelStreams(ids.get("terminal")!).out;
      if (credit)
        send({
          type: "stream",
          action: "credit",
          id: output,
          bytes: 256 * 1024,
        });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await stagedAndFenced(retainSessions);
      // The terminal is open until its grace period ends, and the boundary
      // is reported only after it was closed with its notice.
      await vi.advanceTimersByTimeAsync(999);
      expect(child.kill).not.toHaveBeenCalled();
      expect(statuses().at(-1)?.reason).toBe("ready");
      // Fire it from a macrotask, as a real timer is: the close is a nextTick.
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          vi.advanceTimersByTime(1);
          resolve();
        })
      );
      await vi.waitFor(() =>
        expect(statuses().at(-1)).toMatchObject({ reason: "fence_ready" })
      );
      expect(child.kill).toHaveBeenCalledOnce();
      const events = frames()
        .filter((f) => f.action === "chunk" && f.id === output)
        .map((f) => JSON.parse(Buffer.from(f.data, "base64").toString()));
      if (credit)
        expect(events).toContainEqual({
          type: "error",
          message: expect.stringContaining("runner is updating"),
          reason: "update",
        });
      else expect(events).toEqual([]);
      const all = frames();
      const end = all.findIndex(
        (f) =>
          f.id === output &&
          (credit
            ? f.action === "end"
            : f.action === "cancel" && f.code === "fenced")
      );
      expect(end).toBeGreaterThan(-1);
      expect(end).toBeLessThan(
        all.findIndex((f) => f.reason === "fence_ready")
      );
      request("too-early", "terminal.open", fencedCommands["terminal.open"]);
      expect(resultFor("too-early")).toMatchObject({
        error: { code: "fenced" },
      });
      expect(spawnChild).toHaveBeenCalledOnce();

      // End the retired supervisor and start another link on the new build.
      vi.useRealTimers();
      socket.emit("close");
      await running;
      dial.mockClear();
      await start({
        updateIdentity: {
          ...identity,
          version: target.version,
          revision: target.revision,
          sha256: target.sha256,
        },
        updater: mockUpdater(),
        fenceStore: memoryStore(),
      });
      const reopened = shell();
      spawnChild.mockReturnValue(reopened);
      request("reopened", "terminal.open", fencedCommands["terminal.open"]);
      await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledTimes(2));
      reopened.stderr.end(
        JSON.stringify({ cwd: "/fixture", host: "runner", user: "fixture" })
      );
      await vi.waitFor(() =>
        expect(resultFor("reopened")).toMatchObject({
          value: { cwd: "/fixture", host: "runner", user: "fixture" },
        })
      );
      expect(reopened.kill).not.toHaveBeenCalled();
    }
  );
});
