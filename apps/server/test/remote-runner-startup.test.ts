import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportIdentity, dial } = vi.hoisted(() => {
  const reportIdentity = vi.fn();
  // Preserve execFile's custom promisify return shape.
  Object.defineProperty(
    reportIdentity,
    Symbol.for("nodejs.util.promisify.custom"),
    {
      value: (...args: unknown[]) =>
        new Promise((resolve, reject) => {
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
  return { reportIdentity, dial: vi.fn() };
});

// Exercise the real runner startup on every test platform. The kernel probe
// and TLS dial are the only external operations replaced by the test.
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
}));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  connect: dial,
}));

import {
  runnerStorageKey,
  runRemoteRunner,
} from "../src/agents/remote/runner.js";

it("preserves prototype storage while keeping opaque wire IDs out of paths", () => {
  expect(runnerStorageKey("agt_123456")).toBe("agt_123456");
  const key = runnerStorageKey("../tenant/Agent:42");
  expect(key).toMatch(/^opaque-[A-Za-z0-9_-]{43}$/);
  expect(runnerStorageKey("../tenant/Agent:42")).toBe(key);
  expect(runnerStorageKey("../tenant/agent:42")).not.toBe(key);
  expect(runnerStorageKey("logs")).not.toBe("logs");
});

const unprivilegedStatus = [
  "Uid:\t1000\t1000\t1000\t1000",
  "Gid:\t1001\t1001\t1001\t1001",
  "Groups:\t ",
  "CapInh:\t0000000000000000",
  "CapPrm:\t0000000000000000",
  "CapEff:\t0000000000000000",
  "CapBnd:\t0000000000000000",
  "CapAmb:\t0000000000000000",
  "NoNewPrivs:\t1",
].join("\n");

describe("remote runner startup", () => {
  let root: string;
  let config: string;
  let state: string;
  let key: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-startup-"));
    config = path.join(root, "runner.json");
    state = path.join(root, "state");
    key = path.join(root, "key");
    await writeFile(key, "unused test credential", { mode: 0o600 });
    await writeFile(
      config,
      JSON.stringify({
        endpoint: "https://192.0.2.1",
        key,
        cert: key,
        ca: key,
        state,
        uid: 1000,
        gid: 1001,
        home: root,
        path: "/usr/bin:/bin",
        bins: {},
        workspaces: {},
      })
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["root UID", "Uid:\t1000\t1000\t1000\t1000", "Uid:\t0\t0\t0\t0"],
    ["root GID", "Gid:\t1001\t1001\t1001\t1001", "Gid:\t0\t0\t0\t0"],
    ["supplementary root group", "Groups:\t ", "Groups:\t0"],
    [
      "retained capability",
      "CapBnd:\t0000000000000000",
      "CapBnd:\t0000000000000001",
    ],
    ["later privilege gain", "NoNewPrivs:\t1", "NoNewPrivs:\t0"],
  ])("refuses enrollment with %s", async (_label, from, to) => {
    reportIdentity.mockImplementation((_command, _args, _options, callback) =>
      callback(null, unprivilegedStatus.replace(from, to), "")
    );
    await expect(runRemoteRunner(config)).rejects.toThrow(
      "cannot verify unprivileged execution"
    );
    expect(dial).not.toHaveBeenCalled();
    await expect(stat(state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses enrollment when setpriv cannot change identity", async () => {
    reportIdentity.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error("Operation not permitted"))
    );
    await expect(runRemoteRunner(config)).rejects.toThrow(
      "cannot verify unprivileged execution"
    );
    expect(dial).not.toHaveBeenCalled();
    await expect(stat(state)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { workspaces: undefined, handles: ["@session"], managed: true },
    { workspaces: {}, handles: ["@session"], managed: true },
    {
      workspaces: { proof: { cwd: "/fixture" } },
      handles: ["proof"],
      managed: false,
    },
    {
      workspaces: { "@session": { cwd: "/fixture" } },
      handles: ["@session"],
      managed: false,
    },
  ])(
    "advertises only the configured workspace mode: $workspaces",
    async ({ workspaces, handles, managed }) => {
      const input = JSON.parse(await readFile(config, "utf8"));
      await writeFile(config, JSON.stringify({ ...input, workspaces }));
      reportIdentity.mockImplementation((_command, _args, _options, callback) =>
        callback(null, unprivilegedStatus, "")
      );
      const socket = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        destroy: vi.fn(),
        writableLength: 0,
        destroyed: false,
      });
      const end = new Error("end simulated runner after reconnect");
      dial.mockReturnValueOnce(socket).mockImplementation(() => {
        throw end;
      });
      vi.useFakeTimers();
      const running = runRemoteRunner(config).catch((error) => error);
      try {
        await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1));
        socket.emit("secureConnect");
        expect(JSON.parse(socket.write.mock.calls[0]![0])).toEqual({
          type: "ready",
          version: 1,
          workspaces: handles,
          ...(managed ? { managedWorkspace: true } : {}),
        });
        socket.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "request",
              id: "discard-test",
              command: {
                kind: "discard",
                agentId: "fixture",
                workspace: "@session",
              },
            }) + "\n"
          )
        );
        await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(2));
        expect(JSON.parse(socket.write.mock.calls[1]![0])).toMatchObject({
          type: "result",
          id: "discard-test",
          ...(managed ? { value: true } : { error: expect.any(String) }),
        });
      } finally {
        socket.emit("close");
        await vi.advanceTimersByTimeAsync(1000);
        await expect(running).resolves.toBe(end);
        vi.useRealTimers();
      }
    }
  );

  it("leaves the host parent traversable and keeps enrollment state private", async () => {
    // A retained host directory created with umask 0077 has mode 0700.
    await mkdir(path.join(state, "hosts"), { recursive: true, mode: 0o700 });
    reportIdentity.mockImplementation((_command, _args, _options, callback) =>
      callback(null, unprivilegedStatus, "")
    );
    const stopAtDial = new Error("stop the test before the network dial");
    dial.mockImplementation(() => {
      throw stopAtDial;
    });

    await expect(runRemoteRunner(config)).rejects.toBe(stopAtDial);
    expect(dial).toHaveBeenCalledWith(
      expect.objectContaining({ host: "192.0.2.1", rejectUnauthorized: true })
    );
    expect(dial.mock.calls[0]![0]).not.toHaveProperty("servername");
    expect(reportIdentity).toHaveBeenCalledWith(
      "/usr/bin/setpriv",
      [
        "--reuid=1000",
        "--regid=1001",
        "--clear-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        "--",
        "/bin/cat",
        "/proc/self/status",
      ],
      expect.any(Object),
      expect.any(Function)
    );
    expect((await stat(state)).mode & 0o777).toBe(0o711);
    expect((await stat(path.join(state, "hosts"))).mode & 0o777).toBe(0o711);
    expect((await stat(path.join(state, "bindings"))).mode & 0o777).toBe(0o700);
    expect((await stat(key)).mode & 0o777).toBe(0o600);
  });
});
