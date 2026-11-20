import { EventEmitter } from "node:events";
import {
  chown,
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

const { reportIdentity, dial, supervisorConfig, passwdShell } = vi.hoisted(
  () => {
    const reportIdentity = vi.fn();
    // Preserve execFile's custom promisify return shape.
    Object.defineProperty(
      reportIdentity,
      Symbol.for("nodejs.util.promisify.custom"),
      {
        value: (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            if (args[0] === "/usr/bin/getent") {
              resolve({
                stdout: `fixture:x:1000:1001::/fixture:${passwdShell.value}\n`,
              });
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
    const passwdShell = { value: "/bin/sh" };
    return {
      reportIdentity,
      dial: vi.fn(),
      supervisorConfig: vi.fn(),
      passwdShell,
    };
  }
);

// Exercise the real runner startup on every test platform. The kernel probe
// and TLS dial are mocked along with the Linux session primitives.
vi.mock("node:process", async (original) => {
  const { default: process } = await original<typeof import("node:process")>();
  return {
    default: Object.create(process, {
      platform: { value: "linux" },
      getuid: { value: () => 0 },
    }),
  };
});
// Startup tests simulate a root supervisor without changing real ownership.
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  chown: vi.fn(async () => {}),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: reportIdentity,
}));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  connect: dial,
}));

vi.mock("../src/agents/remote/session-processes.js", async (original) => ({
  ...(await original<
    typeof import("../src/agents/remote/session-processes.js")
  >()),
  createSessionProcesses: () => ({ acquire: () => () => {} }),
}));

vi.mock("../src/agents/remote/session-supervisor.js", async (original) => {
  const real =
    await original<
      typeof import("../src/agents/remote/session-supervisor.js")
    >();
  return {
    ...real,
    createSessionSupervisor: (
      config: Parameters<typeof real.createSessionSupervisor>[0]
    ) => {
      supervisorConfig(config);
      return real.createSessionSupervisor(config);
    },
  };
});

import {
  runnerStorageKey,
  runRemoteRunner,
  runnerReconnectDelay,
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
  "Groups:\t1001 2000",
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
    passwdShell.value = "/bin/sh";
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
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["root UID", "Uid:\t1000\t1000\t1000\t1000", "Uid:\t0\t0\t0\t0"],
    ["root GID", "Gid:\t1001\t1001\t1001\t1001", "Gid:\t0\t0\t0\t0"],
    ["cleared groups", "Groups:\t1001 2000", "Groups:\t"],
    ["supplementary root group", "Groups:\t1001 2000", "Groups:\t0 1001 2000"],
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
        const ready = JSON.parse(socket.write.mock.calls[0]![0]);
        expect(ready.managedWorkspace).toBe(managed ? true : undefined);
        expect(ready).toMatchObject({
          type: "ready",
          version: 1,
          workspaces: handles,
          health: true,
        });
        socket.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "request",
              id: "invalid-discard",
              command: {
                kind: "discard",
                agentId: ["fixture"],
                workspace: "@session",
              },
            }) + "\n"
          )
        );
        expect(JSON.parse(socket.write.mock.calls[1]![0])).toEqual({
          type: "result",
          id: "invalid-discard",
          error: "Invalid runner command.",
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
        await vi.waitFor(() => expect(socket.write).toHaveBeenCalledTimes(3));
        expect(JSON.parse(socket.write.mock.calls[2]![0])).toMatchObject({
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

  it.each([
    ["/bin/sh", "/bin/sh"],
    ["/usr/sbin/nologin", "/bin/bash"],
    ["/bin/false", "/bin/bash"],
    ["", "/bin/bash"],
    ["/nonexistent/dispatch-fixture/bash", "/bin/bash"],
  ])(
    "launches ACP through the workload login shell for %s",
    async (shell, expected) => {
      passwdShell.value = shell;
      vi.stubEnv(
        "DISPATCH_AGENT_HOST_COMMAND",
        '["/fixture/dispatch","agent-host"]'
      );
      reportIdentity.mockImplementation((_command, _args, _options, callback) =>
        callback(null, unprivilegedStatus, "")
      );
      const stopAtDial = new Error("end simulated runner");
      dial.mockImplementation(() => {
        throw stopAtDial;
      });

      await expect(runRemoteRunner(config)).rejects.toBe(stopAtDial);
      const supervisor = supervisorConfig.mock.calls[0]![0];
      expect(supervisor.env).toMatchObject({
        HOME: root,
        USER: "fixture",
        LOGNAME: "fixture",
        SHELL: expected,
      });
      expect(supervisor.hostCommand("/state/host")).toEqual([
        "/usr/bin/setpriv",
        ...reportIdentity.mock.calls[0]![1].slice(0, -2),
        "/usr/bin/env",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        expected,
        "-lc",
        '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; export PATH="${PATH:+$PATH:}$1"; shift; exec "$@"',
        "dispatch-agent-host",
        expect.stringMatching(/^\/usr\/bin:\/bin:/),
        "/fixture/dispatch",
        "agent-host",
        "--state",
        "/state/host",
      ]);
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
        "--init-groups",
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
    expect((await stat(state)).mode & 0o777).toBe(0o751);
    expect((await stat(path.join(state, "sessions"))).mode & 0o777).toBe(0o751);
    expect(chown).toHaveBeenCalledWith(state, process.getuid!(), 1001);
    expect((await stat(path.join(state, "hosts"))).mode & 0o777).toBe(0o711);
    expect((await stat(path.join(state, "bindings"))).mode & 0o777).toBe(0o700);
    expect((await stat(key)).mode & 0o777).toBe(0o600);
  });
});

it("spreads failed dials, caps the delay and recovers quickly after a stable connection", () => {
  for (const random of [0, 0.5, 1]) {
    const next = runnerReconnectDelay(() => random);
    const factor = (1 + random) / 2;
    expect(Array.from({ length: 8 }, () => next(10))).toEqual(
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000].map(
        (window) => window * factor
      )
    );
    expect(next(30_000)).toBe(1000 * factor);
  }
});
