import { rootCertificates } from "node:tls";
import { streamHelper } from "./helpers/stream-helper.js";
import { embeddedBuild } from "../src/agents/build-identity.js";
import { gitSha, packageVersion } from "../src/generated/runtime-assets.js";
/*
 * The Linux runner's checkout.write: the write is made by a worker the
 * supervisor starts under the workload's own uid/gid (setpriv, no new
 * privileges, no capabilities), in the directory the supervisor's own
 * binding names. Nothing in the request chooses the directory, and a
 * request for another session starts nothing.
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
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/session-processes.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../packages/runner/src/workload/agents/remote/session-processes.js")
    >()),
    createSessionProcesses: () => ({ acquire: () => () => {} }),
  })
);
// The supervisor's own binding resolution, standing in for its files.
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/session-supervisor.js",
  async (original) => {
    const real =
      await original<
        typeof import("../../../packages/runner/src/workload/agents/remote/session-supervisor.js")
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
            _checkout: string,
            _signal: AbortSignal,
            run: (cwd: string) => Promise<T>
          ) {
            if (_agentId !== "fixture") return null;
            bound.calls += 1;
            return run(bound.cwd);
          },
        });
      },
    };
  }
);

import { createSessionCore } from "@dispatch/runner/cli";
import { runRemoteRunner } from "../../../packages/runner/src/workload/agents/remote/runner.js";

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

let root: string;
let config: string;

beforeEach(async () => {
  vi.resetAllMocks();
  bound.calls = 0;
  root = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-write-"));
  config = path.join(root, "runner.json");
  const key = path.join(root, "key");
  await writeFile(key, rootCertificates[0]!, { mode: 0o600 });
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
      child.stdout.end(JSON.stringify({ data: { digest: "d".repeat(64) } }));
      child.stderr.end();
      setImmediate(() => child.emit("exit", 0, null));
    });
    return child;
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = (session: string, id: number) =>
  Buffer.from(
    JSON.stringify({
      id,
      op: "checkout.write",
      input: {
        target: { session, checkout: "current" },
        path: ".agents/personas/x.md",
        data: "# x",
        expectedDigest: null,
      },
    }) + "\n"
  );
it("writes as the workload, in the directory its own binding names", async () => {
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

    // Another session's target: nothing starts.
    socket.emit("data", write("someone-else", 1));
    await vi.waitFor(() =>
      expect(
        socket.write.mock.calls.some(([line]) =>
          String(line).includes('"id":1')
        )
      ).toBe(true)
    );
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(bound.calls).toBe(0);

    socket.emit("data", write("fixture", 2));
    await vi.waitFor(() =>
      expect(
        socket.write.mock.calls.some(
          ([line]) =>
            String(line).includes('"id":2') && String(line).includes("dddd")
        )
      ).toBe(true)
    );
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    const [command, args] = spawnWorker.mock.calls[0]!;
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
    // The worker's directory is the binding's, the last argument.
    expect(args.slice(-3)).toEqual(["runner-worker", "write", bound.cwd]);
    // The worker reads only the write itself: no target, no directory.
    expect(
      JSON.parse((spawnWorker as unknown as { input: string }).input)
    ).toEqual({
      path: ".agents/personas/x.md",
      data: "# x",
      expectedDigest: null,
    });
  } finally {
    socket.emit("close");
    await expect(running).resolves.toBe(end);
  }
});
