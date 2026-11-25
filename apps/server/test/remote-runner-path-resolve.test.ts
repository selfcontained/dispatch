import { streamHelper } from "./helpers/stream-helper.js";
import { embeddedBuild } from "../src/agents/build-identity.js";
import { gitSha, packageVersion } from "../src/generated/runtime-assets.js";
/*
 * The Linux runner's path.resolve (a launch folder an agent on this runner
 * names, D7): resolved by a worker the supervisor starts under the
 * workload's own uid/gid (setpriv, no new privileges, no capabilities) in
 * its login environment, so `~` is the workload's HOME and every stat and
 * realpath has only the workload's access. No session binding is read.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { reportIdentity, dial, spawnWorker, bound, passwdShell } = vi.hoisted(
  () => {
    const passwdShell = { value: "/bin/sh" };
    const reportIdentity = vi.fn();
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
    return {
      reportIdentity,
      dial: vi.fn(),
      spawnWorker: vi.fn(),
      bound: { cwd: "/srv/runner/sessions/fixture/checkout", calls: 0 },
      passwdShell,
    };
  }
);

vi.mock("node:process", async (original) => {
  const { default: process } = await original<typeof import("node:process")>();
  return {
    default: Object.create(process, {
      platform: { value: "linux" },
      getuid: { value: () => 0 },
    }),
  };
});
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  chown: vi.fn(async () => {}),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: reportIdentity,
  spawn: spawnWorker,
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
// The supervisor's own binding resolution, standing in for its files.
vi.mock("../src/agents/remote/session-supervisor.js", async (original) => {
  const real =
    await original<
      typeof import("../src/agents/remote/session-supervisor.js")
    >();
  return {
    ...real,
    createSessionSupervisor: async (
      config: Parameters<typeof real.createSessionSupervisor>[0]
    ) => {
      const supervisor = await real.createSessionSupervisor(config);
      return Object.assign(supervisor, {
        async withCommandCheckout<T>(
          _agentId: string,
          _workspace: string,
          _checkout: string,
          _configured: string | undefined,
          _signal: AbortSignal,
          run: (cwd: string) => Promise<T>
        ) {
          bound.calls += 1;
          return run(bound.cwd);
        },
      });
    },
  };
});

import { createSessionCore } from "@dispatch/runner/cli";
import { runRemoteRunner } from "../src/agents/remote/runner.js";

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

const resolved = {
  resolvedPath: "/fixture/src/app",
  canonicalPath: "/srv/app",
  exists: true,
  isDirectory: true,
  isGitRepo: false,
  privacyRestricted: false,
  projectRoot: null,
  git: null,
};

let root: string;
let config: string;

beforeEach(async () => {
  vi.resetAllMocks();
  bound.calls = 0;
  root = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-path-"));
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
  spawnWorker.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    let input = "";
    child.stdin.on("data", (chunk) => (input += chunk));
    child.stdin.on("end", () => {
      (spawnWorker as unknown as { input?: string }).input = input;
      child.stdout.end(JSON.stringify({ data: resolved }));
      child.stderr.end();
      setImmediate(() => child.emit("exit", 0, null));
    });
    return child;
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolve = (id: string, request: object) =>
  Buffer.from(
    JSON.stringify({
      type: "request",
      id,
      command: {
        kind: "pathResolve",
        agentId: "@path",
        workspace: "@session",
        operation: { op: "path.resolve", request },
      },
    }) + "\n"
  );

it("resolves a folder as the workload, never as the supervisor", async () => {
  const socket = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    destroy: vi.fn(),
    writableLength: 0,
    destroyed: false,
  });
  const end = new Error("end simulated runner");
  dial.mockReturnValueOnce(socket).mockImplementation(() => {
    throw end;
  });
  const running = runRemoteRunner(config, {
    build: embeddedBuild,
    healthBuild: { version: packageVersion, revision: gitSha },
    streamHelper,
    updateLayout: {
      config,
      installed: path.join(root, "dispatch"),
      staging: path.join(root, "staging"),
      state: path.join(root, "update-state"),
    },
    updateIdentity: null,
    createSessions: createSessionCore,
  }).catch((error) => error);
  try {
    await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(1));
    socket.emit("secureConnect");
    await vi.waitFor(() =>
      expect(
        socket.write.mock.calls.some(([line]) =>
          String(line).includes('"pathResolve":true')
        )
      ).toBe(true)
    );

    const request = { path: "~/src/../app", projectRoot: true };
    socket.emit("data", resolve("folder", request));
    await vi.waitFor(() =>
      expect(
        socket.write.mock.calls.some(
          ([line]) =>
            String(line).includes('"id":"folder"') &&
            String(line).includes("/srv/app")
        )
      ).toBe(true)
    );
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnWorker.mock.calls[0]!;
    expect(command).toBe("/usr/bin/setpriv");
    expect(args.slice(0, 8)).toEqual([
      "--reuid=1000",
      "--regid=1001",
      "--init-groups",
      "--no-new-privs",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--",
    ]);
    // A login as the workload, whose HOME is its own: `~` is resolved there.
    expect(args.slice(-2)).toEqual(["runner-worker", "path.resolve"]);
    expect(options.env.HOME).toBe(root);
    // The worker reads the request as the agent sent it; the runner, not
    // Dispatch, expands `~` and resolves `..` and links.
    expect(
      JSON.parse((spawnWorker as unknown as { input: string }).input)
    ).toEqual(request);
    // No session binding chooses or narrows the folder.
    expect(bound.calls).toBe(0);
  } finally {
    socket.emit("close");
    await expect(running).resolves.toBe(end);
  }
});
