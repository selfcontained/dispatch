import { enrolledWorkspace } from "../../../packages/runner/src/workload/agents/remote/workspace-operations.js";
import { enrolledSessions } from "../../../packages/runner/src/workload/agents/remote/session-operations.js";
import { streamHelper } from "./helpers/stream-helper.js";
import { placementForRunner } from "../src/runners/placement.js";
import { sessionFromWire, type Req } from "@dispatch/runner-protocol/contract";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { text } from "node:stream/consumers";
import {
  chmod,
  link,
  readdir,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify from "fastify";
import { createSessionCore } from "@dispatch/runner/cli";
import { buildHostEnv } from "@dispatch/runner/host/host-env";
import { hostSearchPath } from "../../../packages/runner/src/host/host-search-path.js";
import {
  HOST_FILES,
  type HostLaunch,
} from "@dispatch/runner-client/host-framing";
import {
  issueAuthority,
  issueServer,
} from "../src/agents/remote/certificate-authority.js";
import { createAgentMcpToken, validateAgentMcpToken } from "../src/auth.js";
import { registerMcpRoutes } from "../src/routes/mcp.js";
import { assertAccessCeiling } from "../src/shared/access-ceiling.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SESSION_FILE_BYTES } from "../../../packages/runner/src/workload/agents/remote/protocol.js";
import {
  classifySessionIdentity,
  parseProcessStat,
  parseSessionIdentity,
  runnerStateLockError,
  socketInUse,
  type SessionIdentity,
  type SessionProcesses,
} from "../../../packages/runner/src/workload/agents/remote/session-processes.js";
import { readSessionFile } from "../src/files/session-file-io.js";
import { enterDirectory } from "../../../packages/runner/src/workload/agents/remote/workload-tools.js";
import { sessionFileCommand } from "../../../packages/runner/src/workload/agents/remote/session-files.js";
import {
  createSessionSupervisor,
  runnerStorageKey,
} from "../../../packages/runner/src/workload/agents/remote/session-supervisor.js";
import {
  createLinuxPrivsep,
  createRemoteWorkspacePreparation,
} from "../../../packages/runner/src/platform/linux-privsep/index.js";
import { storageKey } from "../../../packages/runner/src/platform/linux-privsep/layout.js";
import {
  startTerminalWorker,
  streamCommandOutput,
} from "../../../packages/runner/src/workload/agents/remote/runner.js";
import { FlowStreams } from "@dispatch/runner-client/v1/node";

import {
  observeGitCheckout,
  observeScratchCheckout,
} from "../../../packages/runner/src/workload/agents/checkout-inspection.js";

// An unprivileged test cannot chown to another account. When set, record the
// changes of ownership instead of making them.
const ownership = vi.hoisted(() => ({
  changes: undefined as [string, string, number, number][] | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const recorded =
    (name: "chown" | "lchown") =>
    async (file: string, uid: number, gid: number) => {
      if (ownership.changes) ownership.changes.push([name, file, uid, gid]);
      else await actual[name](file, uid, gid);
    };
  return { ...actual, chown: recorded("chown"), lchown: recorded("lchown") };
});

type Supervisor = Awaited<ReturnType<typeof createSessionSupervisor>>;

const marker = "DISPATCH_OWNED_00000000000000000000000000000000=1";
const identity = { pid: 100, start: "500", scope: "boot:namespace", marker };
const agentId = "agt_fixture";
const build = { version: "1.7.28", revision: "a".repeat(40) };
const instanceId = "01234567-89ab-4cde-8fab-0123456789ab";
const currentIdentity = {
  ...identity,
  handoffFormat: 2,
  sessionId: agentId,
  hostBuild: build,
  hostInstanceId: instanceId,
};
const reviewerId = "agt_reviewer";
const launch = () =>
  ({
    agentId,
    launch: { engine: "codex" },
  }) as const;
const sharedLaunch = (useWorktreeOf: string = agentId) => ({
  ...launch(),
  agentId: reviewerId,
  launch: { ...launch().launch, useWorktreeOf },
});

it("names session state as linux-privsep does, so paths never move", () => {
  for (const id of ["agt_abc123", "agt_", "AGT_x", "x/../y", "opaque", ""])
    expect(storageKey(id)).toBe(runnerStorageKey(id));
});

it("explains lock contention while retaining diagnostics for other flock failures", () => {
  expect(runnerStateLockError(11).message).toMatch(
    /Another runner daemon is already using this state directory.*Stop the other runner or configure a different state directory/
  );
  expect(runnerStateLockError(9).message).toBe(
    "Cannot lock runner session state (errno 9)."
  );
});

it.skipIf(process.platform !== "linux")(
  "verifies real kernel credentials for a pinned host socket",
  async () => {
    const dir = await mkdtemp("/tmp/runner-peer-");
    const module = fileURLToPath(
      new URL(
        "../../../packages/runner/src/workload/agents/remote/session-processes.ts",
        import.meta.url
      )
    );
    try {
      const { stdout } = await promisify(execFile)(
        "bun",
        [
          "-e",
          `
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { createSessionProcesses, parseProcessStat } from ${JSON.stringify(module)};
const root = ${JSON.stringify(dir)};
const hostSocket = root + "/host.sock";
const child = spawn(process.execPath, ["-e", \`
  require("node:net").createServer((socket) => socket.end())
    .listen(\${JSON.stringify(hostSocket)}, () => console.log("ready"));
\`], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
const exited = once(child, "exit");
try {
  await once(child.stdout, "data");
  const { start } = parseProcessStat(readFileSync("/proc/" + child.pid + "/stat", "utf8"));
  const scope = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + readlinkSync("/proc/self/ns/pid");
  const identity = { scope, pid: child.pid, start, marker: ${JSON.stringify(marker)} };
  const processes = createSessionProcesses(process.getuid(), async () => "");
  assert.equal(processes.socketMatchesHost(hostSocket, identity), true);
  assert.equal(processes.socketMatchesHost(hostSocket, { ...identity, start: "0" }), false);
  assert.equal(processes.socketMatchesHost(hostSocket, { ...identity, scope: "stale" }), false);

  const other = createServer((socket) => socket.end());
  other.listen(root + "/spoof.sock");
  await once(other, "listening");
  try {
    assert.equal(processes.socketMatchesHost(root + "/spoof.sock", identity), false);
    symlinkSync(hostSocket, root + "/link.sock");
    assert.throws(() => processes.socketMatchesHost(root + "/link.sock", identity));
    const otherUid = createSessionProcesses(process.getuid() + 1, async () => "");
    assert.equal(otherUid.socketMatchesHost(hostSocket, identity), false);
  } finally {
    other.close();
  }
  console.log("credentials verified");
} finally {
  child.kill("SIGKILL");
  await exited;
}
`,
        ],
        { timeout: 10_000 }
      );
      expect(stdout.trim()).toBe("credentials verified");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

/** The folder a host enters: never the launcher's, always the command's. */
function hostCwd([command, cwd]: [string[], string, ...unknown[]]) {
  expect(cwd).toBe("/");
  expect(command.at(-2)).toBe("--cwd");
  return command.at(-1);
}

describe("runner session supervision", () => {
  let root: string;
  let state: string;
  let record: string;
  let supervisor: Supervisor | undefined;
  let kernelHost: SessionIdentity | undefined;
  let kernelReviewer: SessionIdentity | undefined;
  let locked: boolean;

  const processes = {
    acquire: vi.fn(() => {
      if (locked) throw new Error("Already locked");
      locked = true;
      return () => {
        locked = false;
      };
    }),
    alive: vi.fn((record: SessionIdentity) =>
      [kernelHost, kernelReviewer].some(
        (host) =>
          host !== undefined &&
          record.scope === host.scope &&
          record.pid === host.pid &&
          record.start === host.start
      )
    ),
    stop: vi.fn(async (record: SessionIdentity) => {
      if (!processes.alive(record)) return;
      if (record.pid === kernelReviewer?.pid) kernelReviewer = undefined;
      if (record.pid === kernelHost?.pid) kernelHost = undefined;
    }),
    cleanup: vi.fn(async (_identity: SessionIdentity) => {}),
    cleanupLegacy: vi.fn(async (_marker: string) => {}),
    socketInUse: vi.fn<(socket: string) => boolean>(() => false),
    socketMatchesHost: vi.fn(() => true),
    spawn: vi.fn<SessionProcesses["spawn"]>(),
  } satisfies SessionProcesses;

  async function start(
    asWorkload: Parameters<
      typeof createSessionSupervisor
    >[0]["asWorkload"] = vi.fn(),
    workload?: Pick<
      Parameters<typeof createSessionSupervisor>[0],
      | "env"
      | "bins"
      | "hostCommand"
      | "mayStartProcess"
      | "build"
      | "uid"
      | "gid"
      | "bindingWritten"
      | "observeCheckout"
      | "forgetPreparedCheckout"
    >
  ) {
    supervisor = await createSessionSupervisor(
      {
        state,
        streamHelper,
        build,
        uid: process.getuid!(),
        gid: process.getgid!(),
        ca: path.join(state, "runner-ca.pem"),
        bins: { claudeBin: "", codexBin: "" },
        env: {},
        // The host enters its folder itself, after dropping privilege.
        hostCommand: (dir, cwd) => ["/test-host", "--state", dir, "--cwd", cwd],
        sessions: createSessionCore,
        asWorkload,
        observeCheckout: (dir, scratch) =>
          scratch ? observeScratchCheckout(dir) : observeGitCheckout(dir),
        ...workload,
      },
      processes
    );
    return supervisor;
  }

  async function startHost(
    runner: Supervisor,
    fixture: {
      agentId: string;
      launch: Partial<HostLaunch> & {
        launchId?: string;
        owner?: string;
        useWorktreeOf?: string;
      };
    }
  ) {
    const { agentId: id, launch: host } = fixture;
    if (host.useWorktreeOf) {
      const parent = host.useWorktreeOf;
      if (id !== parent && (await runner.isBound(parent)))
        await runner.checkoutDirectory(parent);
      const preparation = await createRemoteWorkspacePreparation({
        state,
        ids: {
          supervisor: process.getuid!(),
          uid: process.getuid!(),
          gid: process.getgid!(),
        },
        asWorkload: async (bin, args) =>
          execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        step: async (method) => {
          if (method === "workspace.git") return null;
          throw new Error("Unexpected " + method);
        },
      });
      await enrolledWorkspace(runner, preparation, () => {})[
        "workspace.prepare"
      ](
        {
          session: sessionFromWire(id),
          source: { session: sessionFromWire(parent) },
          copyIgnored: [],
          installDependencies: false,
        },
        { emit: () => {}, receiveBlob: async () => {} }
      );
    }
    return runner.launchSession({
      session: sessionFromWire(id),
      launchId: host.launchId ?? randomUUID(),
      engine: host.engine ?? "codex",
      model: host.model ?? null,
      effort: host.effort ?? null,
      owner: host.owner ?? null,
      access: host.fullAccess ? "full" : "default",
      resume: host.resumeSessionId ?? null,
      systemText: host.systemPrompt ?? null,
      firstText: host.personaContext ?? null,
      overflowNotice: null,
      env: {},
      mcp: host.mcp ? [{ ...host.mcp, name: host.mcp.name ?? "dispatch" }] : [],
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    processes.socketInUse.mockReturnValue(false);
    processes.socketMatchesHost.mockReturnValue(true);
    processes.spawn.mockImplementation(
      async (_command, _cwd, _env, _log, save) => {
        await save(identity);
        expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject(
          identity
        );
        kernelHost = identity;
      }
    );
    kernelHost = undefined;
    kernelReviewer = undefined;
    locked = false;
    root = await mkdtemp("/tmp/runner-supervisor-");
    state = path.join(await realpath(root), "state");
    record = path.join(state, "bindings", agentId + ".host");
  });

  afterEach(async () => {
    ownership.changes = undefined;
    supervisor?.close();
    supervisor = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("installs the repository stream helper byte for byte with executable mode", async () => {
    await start();
    const installed = path.join(state, "bin", "dispatch-stream");
    expect(await readFile(installed)).toEqual(
      await readFile(new URL("../../../bin/dispatch-stream", import.meta.url))
    );
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
  });

  it("finishes terminal readiness before the worker exits using only standard pipes", async () => {
    const child = startTerminalWorker(
      ["/usr/bin/env"],
      [
        "/bin/sh",
        "-c",
        'printf ready >&3; exec 3>&-; printf private >&2; read -r input; printf "%s" "$input"',
      ],
      process.env
    );
    const exit = once(child, "close");
    const output = text(child.stdout);
    try {
      expect(child.stdio).toHaveLength(3);
      expect(await text(child.stderr)).toBe("ready");
      expect(child.exitCode).toBeNull();
      child.stdin.end("terminal output\n");
      expect(await output).toBe("terminal output");
      expect(await exit).toEqual([0, null]);
    } finally {
      child.stdin.destroy();
      child.kill();
      await exit;
    }
  });

  function checkoutStreamPair() {
    const socket = new PassThrough();
    const peerSocket = new PassThrough();
    const streams = new FlowStreams(socket, (frame, flushed) =>
      queueMicrotask(() => {
        peer.handle(frame);
        flushed?.();
      })
    );
    const peer = new FlowStreams(peerSocket, (frame) =>
      queueMicrotask(() => streams.handle(frame))
    );
    streams.enable();
    peer.enable();
    return {
      streams,
      peer,
      close() {
        socket.destroy();
        peerSocket.destroy();
      },
    };
  }

  it("forwards stale status and empty stdout EOF after a terminal worker exits", async () => {
    const terminal = startTerminalWorker(
      ["/usr/bin/env"],
      ["/bin/sh", "-c", "printf ready >&3; exec 3>&-; read -r input"],
      process.env
    );
    const terminalExit = once(terminal, "close");
    const { streams, peer, close } = checkoutStreamPair();
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]);
    const started = path.join(root, "checkout-started");
    const release = path.join(root, "checkout-release");
    let work: ReturnType<typeof streamCommandOutput> | undefined;
    try {
      expect(terminal.stdio).toHaveLength(3);
      expect(await text(terminal.stderr)).toBe("ready");
      expect(terminal.exitCode).toBeNull();
      const visible = { stdout: "", stderr: "" };
      const output = Promise.all(
        (["stdout", "stderr"] as const).map((id) =>
          peer.receive(
            id,
            new Writable({
              write(chunk, _encoding, done) {
                visible[id] += chunk.toString();
                done();
              },
            }),
            signal
          )
        )
      );
      void output.catch(() => {});
      work = streamCommandOutput(
        [
          process.execPath,
          "-e",
          `const { closeSync, existsSync, writeFileSync, writeSync } = require("node:fs");
           const [started, release] = process.argv.slice(1);
           writeFileSync(started, "");
           const wait = setInterval(() => {
             if (!existsSync(release)) return;
             clearInterval(wait);
             const trailer = Buffer.alloc(8192);
             trailer.write(JSON.stringify({ code: "stale", error: "Guard changed." }));
             writeSync(2, trailer);
             closeSync(2);
             closeSync(1);
             process.exitCode = 1;
           }, 5);`,
          started,
          release,
        ],
        {},
        "",
        null,
        (name, source, active) =>
          streams.send(name, source, active, { stall: "blocked" }),
        signal
      );
      void work.catch(() => {});
      // Start the checkout worker while the terminal is alive, then let the
      // terminal exit before the checkout worker publishes its status and EOF.
      await expect
        .poll(async () => readFile(started, "utf8").catch(() => null))
        .toBe("");
      terminal.stdin.end("exit\n");
      expect(await terminalExit).toEqual([0, null]);
      await writeFile(release, "");
      await expect(work).rejects.toMatchObject({
        code: "stale",
        message: "Guard changed.",
      });
      await output;
      expect(visible).toEqual({ stdout: "", stderr: "" });
    } finally {
      abort.abort();
      close();
      terminal.stdin.destroy();
      terminal.kill();
      await terminalExit;
      await work?.catch(() => {});
    }
  });

  it("acknowledges the same session after cancelling exec with both transfers complete", async () => {
    const runner = await start();
    await startHost(runner, launch());
    const abort = new AbortController();
    const { streams, peer, close } = checkoutStreamPair();
    let pid: number | undefined;
    const outputDone = Promise.all([
      peer.receive(
        "stdout",
        new Writable({
          write(chunk, _encoding, done) {
            pid = Number(chunk.toString());
            done();
          },
        })
      ),
      peer.receive(
        "stderr",
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        })
      ),
    ]);
    const work = runner.withCommandCheckout(
      agentId,
      "effective",
      abort.signal,
      () =>
        streamCommandOutput(
          [
            process.execPath,
            "-e",
            `const { closeSync } = require("node:fs");
             process.stdout.write(String(process.pid), () => {
               closeSync(1);
               closeSync(2);
             });
             setInterval(() => {}, 1000);`,
          ],
          {},
          "",
          null,
          (name, source, active) =>
            streams.send(name, source, active, { stall: "blocked" }),
          abort.signal
        )
    );
    let settled = false;
    void work
      .catch(() => {})
      .finally(() => {
        settled = true;
      });
    try {
      const deadline = AbortSignal.timeout(1500);
      const timeout = new Promise<never>((_, reject) =>
        deadline.addEventListener("abort", () => reject(deadline.reason), {
          once: true,
        })
      );
      await Promise.race([outputDone, timeout]);
      expect(streams.has("stdout")).toBe(false);
      expect(streams.has("stderr")).toBe(false);
      abort.abort(new Error("Cancelled by test"));
      await expect(
        Promise.race([runner.alive(agentId), timeout])
      ).resolves.toBe(true);
      await expect(work).rejects.toBe(abort.signal.reason);
    } finally {
      abort.abort();
      close();
      if (pid && !settled) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The supervisor already stopped it.
        }
      }
      await work.catch(() => {});
    }
  });

  it("pauses exited-host cleanup while the update fence holds admission", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let admitting = true;
      const runner = await start(vi.fn(), {
        env: {},
        bins: { claudeBin: "", codexBin: "" },
        hostCommand: (dir) => ["/test-host", "--state", dir],
        mayStartProcess: () => admitting,
      });
      await startHost(runner, launch());
      kernelHost = undefined;
      admitting = false;
      await vi.advanceTimersByTimeAsync(15_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(processes.cleanup).not.toHaveBeenCalled();
      admitting = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(processes.cleanup).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the golden legacy binding but defers live handoff", async () => {
    const runner = await start();
    await startHost(runner, launch());
    const written = JSON.parse(await readFile(record, "utf8"));
    const hostDir = path.join(state, "hosts", agentId);
    const options = JSON.parse(
      await readFile(path.join(hostDir, "launch.json"), "utf8")
    );
    expect(written).toEqual({
      ...currentIdentity,
      hostInstanceId: options.hostInstanceId,
    });
    expect(
      classifySessionIdentity(parseSessionIdentity(JSON.stringify(identity)))
    ).toEqual({
      kind: "legacy",
      format: 1,
    });

    await writeFile(record, JSON.stringify(identity));
    runner.close();
    const recovered = await start();
    expect(await recovered.alive(agentId)).toBe(true);
    expect(
      await recovered.inspectHandoff({ reads: [1, 2], writes: 2 })
    ).toEqual({
      retained: [],
      requiresQuiescence: true,
      live: 1,
    });
    expect(processes.socketMatchesHost).not.toHaveBeenCalled();
  });

  it("recovers the golden current tree and fails closed on stale or spoofed identity", async () => {
    const runner = await start();
    await startHost(runner, launch());
    await writeFile(record, JSON.stringify(currentIdentity));
    runner.close();
    const recovered = await start();
    const socketPath = path.join(state, "hosts", agentId, "host.sock");
    const socket = createServer();
    socket.listen(socketPath);
    await once(socket, "listening");
    const inspect = () => recovered.inspectHandoff({ reads: [2], writes: 2 });
    try {
      expect(await inspect()).toEqual({
        retained: [{ sessionId: agentId, instanceId, build }],
        requiresQuiescence: false,
        live: 1,
      });
      expect(
        await recovered.inspectHandoff({ reads: [1], writes: 1 })
      ).toMatchObject({
        requiresQuiescence: true,
      });
      await writeFile(
        record,
        JSON.stringify({ ...currentIdentity, sessionId: "other" })
      );
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
        live: 1,
      });

      await writeFile(
        record,
        JSON.stringify({ ...currentIdentity, handoffFormat: 91 })
      );
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
        live: 1,
      });

      await writeFile(
        record,
        JSON.stringify({ ...currentIdentity, start: "501" })
      );
      processes.socketInUse.mockReturnValue(true);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
        live: 1,
      });
      processes.socketInUse.mockReturnValue(false);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: false,
        live: 0,
      });

      await writeFile(record, JSON.stringify(currentIdentity));
      processes.socketMatchesHost.mockReturnValue(false);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
        live: 1,
      });

      processes.socketMatchesHost.mockReturnValue(true);
      await chmod(record, 0o666);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
        live: 1,
      });
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });

  it("makes checkout ancestors group-readable while retaining private state", async () => {
    const sessions = path.join(state, "sessions");
    const legacyParent = path.join(sessions, agentId);
    const checkout = path.join(legacyParent, "checkout");
    const scratch = path.join(sessions, reviewerId);
    await mkdir(state, { mode: 0o711 });
    await mkdir(sessions, { mode: 0o711 });
    await mkdir(legacyParent, { mode: 0o711 });
    await mkdir(checkout, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });

    await start();

    for (const dir of [state, sessions, legacyParent]) {
      const entry = await stat(dir);
      expect(entry.mode & 0o777).toBe(0o751);
      expect(entry.uid).toBe(process.getuid!());
      expect(entry.gid).toBe(process.getgid!());
    }
    for (const dir of [checkout, scratch, path.join(state, "bindings")]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("takes MCP credentials from a single enrolled launch and the CA from enrollment", async () => {
    const runner = await start();
    const server = {
      name: "dispatch",
      url: "https://controller.invalid/mcp",
      token: "fixture",
      caPem: "frame CA",
    };
    const request: Req<"session.launch"> = {
      session: sessionFromWire(agentId),
      launchId: instanceId,
      engine: "codex",
      access: "default",
      model: null,
      effort: null,
      resume: null,
      systemText: null,
      firstText: null,
      overflowNotice: null,
      mcp: [server],
      env: {
        CONFORMANCE_LITERAL: "literal ; $HOME",
        CONFORMANCE_UNICODE: "café",
      },
      owner: null,
    };
    await expect(
      runner.launchSession({ ...request, mcp: [server, server] })
    ).rejects.toMatchObject({
      code: "invalid",
      message: "v1 carries one MCP server.",
    });
    for (const invalid of [
      { ...server, url: "http://controller.invalid/mcp" },
      { ...server, token: "" },
    ]) {
      await expect(
        runner.launchSession({ ...request, mcp: [invalid] })
      ).rejects.toThrow(
        "Remote service MCP requires HTTPS and a scoped token."
      );
    }
    expect(processes.spawn).not.toHaveBeenCalled();
    await expect(
      stat(path.join(state, "bindings", agentId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path.join(state, "runner-ca.pem"), "enrolled CA");
    await runner.launchSession(request);
    const dir = path.join(state, "hosts", agentId);
    const payload: HostLaunch = JSON.parse(
      await readFile(path.join(dir, "launch.json"), "utf8")
    );
    expect(payload.env).toMatchObject(request.env);
    expect(payload.mcp).toEqual({
      name: server.name,
      url: server.url,
      token: server.token,
    });
    expect(
      await readFile(payload.env.DISPATCH_LOCAL_CA_CERTIFICATE!, "utf8")
    ).toBe("enrolled CA");
    expect(processes.spawn).toHaveBeenCalledOnce();
  });

  it("answers operations for a missing session from this runner's records", async () => {
    const runner = await start();
    const terminalClosed = vi.fn();
    const { calls, opens } = enrolledSessions(runner, terminalClosed);
    const session = sessionFromWire(agentId);
    const bindings = path.join(state, "bindings");
    const before = await readdir(bindings);
    await expect(opens["session.attach"]({ session })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(calls["session.alive"]({ session })).resolves.toEqual({
      state: "gone",
    });
    await expect(
      calls["session.logs"]({ session, lines: 20 })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      calls["workspace.describe"]({ session })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      calls["workspace.select"]({ session, path: null })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(calls["workspace.observe"]({ session })).resolves.toEqual({
      ownership: "none",
      owner: null,
      borrowers: [],
      checkout: null,
    });
    await expect(calls["session.list"]({ owner: null })).resolves.toEqual({
      sessions: [],
    });
    await expect(
      calls["session.sample"]({ sessions: [session] })
    ).resolves.toEqual({ samples: [] });
    expect(await readdir(bindings)).toEqual(before);
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  it.each(["release", "discard"] as const)(
    "%s of a never-bound session fences a delayed launch across restart",
    async (operation) => {
      const runner = await start();
      const bindings = path.join(state, "bindings");
      const before = await readdir(bindings);
      const release = vi.fn(async () => {
        throw new Error("No working checkout");
      });
      const session = sessionFromWire(agentId);
      if (operation === "release") {
        await expect(
          enrolledWorkspace(runner, { call: release }, vi.fn())[
            "workspace.release"
          ]({ session, deleteBranch: false, originalBranch: null })
        ).resolves.toEqual({ removed: true });
      } else {
        await runner.discard(agentId);
      }
      runner.close();
      const restarted = await start();
      const calls = enrolledWorkspace(restarted, { call: release }, vi.fn());
      const context = { emit: vi.fn(), receiveBlob: vi.fn() };
      await expect(
        calls["workspace.resume"]({ session }, context)
      ).resolves.toBeNull();
      await expect(
        calls["workspace.prepare"](
          {
            session,
            source: { scratch: true },
            copyIgnored: [],
            installDependencies: false,
          },
          context
        )
      ).rejects.toMatchObject({ code: "conflict" });

      await expect(startHost(restarted, launch())).rejects.toThrow(
        "This runner session has been archived."
      );
      expect((await readdir(bindings)).sort()).toEqual(
        [...before, agentId + ".retired"].sort()
      );
      await expect(
        stat(path.join(state, "sessions", agentId))
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(processes.spawn).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    }
  );

  it("creates private scratch when launching an unprepared session", async () => {
    const runner = await start();
    await startHost(runner, launch());
    const cwd = path.join(state, "sessions", agentId);
    expect(await runner.checkoutDirectory(agentId)).toBe(cwd);
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it("rediscovers a session host and stops it under the original binding", async () => {
    const first = await start();
    await startHost(first, launch());
    expect((await stat(record)).mode & 0o777).toBe(0o600);

    first.close();
    const recovered = await start();
    expect(await recovered.alive(agentId)).toBe(true);
    expect(await recovered.liveDirectories()).toEqual([
      path.join(state, "hosts", agentId),
    ]);
    await expect(startHost(recovered, launch())).rejects.toThrow(
      "already has a host"
    );
    await expect(recovered.discard(agentId)).rejects.toThrow(
      "Stop the guest host"
    );
    expect(processes.spawn).toHaveBeenCalledTimes(1);

    await writeFile(path.join(state, "hosts", agentId, "host.pid"), "666\n");
    await recovered.stop(agentId, true);
    expect(processes.stop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(identity),
      true
    );
    expect(processes.cleanup).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(identity)
    );
    expect(await recovered.liveDirectories()).toEqual([]);
    await recovered.discard(agentId);
    await expect(
      stat(path.join(state, "hosts", agentId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(startHost(recovered, launch())).rejects.toThrow("archived");
  });

  it("delivers 1 MiB of first text and exposes Dispatch helpers on PATH", async () => {
    const command = launch();
    const context = "🙂".repeat((1024 * 1024) / 4);
    const runner = await start();
    await startHost(runner, {
      ...command,
      launch: { ...command.launch, personaContext: context },
    });

    const dir = path.join(state, "hosts", agentId);
    const file = path.join(dir, HOST_FILES.personaContext);
    const payload: HostLaunch = JSON.parse(
      await readFile(path.join(dir, HOST_FILES.launch), "utf8")
    );
    expect(payload.personaContext).toContain(JSON.stringify(file));
    expect(await readFile(file, "utf8")).toBe(context);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const env = buildHostEnv(payload, dir, hostSearchPath, {
      HOME: root,
      PATH: "/usr/bin:/bin",
    });
    const helper = path.join(payload.pathPrefix[0]!, "dispatch-stream");
    expect((await stat(helper)).mode & 0o777).toBe(0o755);
    const { stdout } = await promisify(execFile)(
      "dispatch-stream",
      ["--help"],
      { env }
    );
    expect(stdout).toContain("dispatch-stream start --playwright");
  });

  it("keeps shared files through stop/start, restart, update resume and reconciliation until discard", async () => {
    const command = launch();
    let runner = await start();
    await startHost(runner, command);
    const hostDir = path.join(state, "hosts", agentId);
    const files = path.join(hostDir, "files");
    const report = path.join(files, "nested", "report.md");
    await mkdir(path.dirname(report));
    await writeFile(report, "agent report");

    const journal = path.join(hostDir, HOST_FILES.journal);
    const journalId = path.join(hostDir, HOST_FILES.journalId);
    const receipts = path.join(hostDir, HOST_FILES.receipts);
    const retained = [
      [journal, "journal event"],
      [journalId, "journal id"],
      [receipts, "prompt receipt"],
    ] as const;
    for (const [file, contents] of retained) await writeFile(file, contents);
    await runner.stop(agentId, false);
    expect(await readFile(report, "utf8")).toBe("agent report");
    await startHost(runner, command);
    expect(await readFile(report, "utf8")).toBe("agent report");
    for (const [file, contents] of retained)
      expect(await readFile(file, "utf8")).toBe(contents);

    const sentinel = path.join(root, "outside");
    await writeFile(sentinel, "untouched");
    await rm(journal);
    await symlink(sentinel, journal);
    const staleFiles = Object.values(HOST_FILES).filter(
      (name) => name !== HOST_FILES.launch && name !== HOST_FILES.journal
    );
    for (const name of staleFiles)
      await writeFile(path.join(hostDir, name), "stale host state");
    await runner.stop(agentId, true);
    await startHost(runner, command);
    expect(await readFile(report, "utf8")).toBe("agent report");
    for (const name of [...staleFiles, "journal.jsonl"])
      await expect(stat(path.join(hostDir, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    expect((await readdir(hostDir)).sort()).toEqual(["files", "launch.json"]);

    runner.close();
    runner = await start(undefined, {
      build: { version: "1.7.29", revision: "b".repeat(40) },
    });
    expect(await runner.alive(agentId)).toBe(true);
    expect(await readFile(report, "utf8")).toBe("agent report");
    await runner.stop(agentId, true);
    const resume = {
      ...command,
      launch: {
        ...command.launch,
        resumeSessionId: "engine-session",
        launchId: "f95d6e6d-9c31-4d95-a3c0-4db17c260790",
      },
    };
    await startHost(runner, resume);
    expect(JSON.parse(await readFile(record, "utf8")).hostBuild.version).toBe(
      "1.7.29"
    );
    expect(await readFile(report, "utf8")).toBe("agent report");
    await startHost(runner, resume);
    expect(processes.spawn).toHaveBeenCalledTimes(4);
    await runner.stop(agentId, true);
    await startHost(runner, resume);
    expect(processes.spawn).toHaveBeenCalledTimes(5);
    expect(await readFile(report, "utf8")).toBe("agent report");

    await runner.stop(agentId, true);
    await runner.discard(agentId);
    await expect(stat(files)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["uid", "gid"] as const)(
    "hands only the files directory to a changed workload %s",
    async (changed) => {
      const command = launch();
      let runner = await start();
      await startHost(runner, command);
      const files = path.join(state, "hosts", agentId, "files");
      const sentinel = path.join(root, "outside");
      await writeFile(sentinel, "untouched");
      await mkdir(path.join(files, "nested"));
      await writeFile(path.join(files, "nested", "report.md"), "report");
      await symlink(sentinel, path.join(files, "planted"));
      await symlink(root, path.join(files, "planted-dir"));
      await link(sentinel, path.join(files, "hard-linked"));
      await chmod(files, 0o777);
      await runner.stop(agentId, true);
      runner.close();

      const owner = { uid: process.getuid!(), gid: process.getgid!() };
      const next = { ...owner, [changed]: owner[changed] + 1 };
      ownership.changes = [];
      runner = await start(undefined, {
        build,
        ...next,
      });
      await startHost(runner, command);

      // Nothing below files, and nothing a planted link points at.
      expect(
        ownership.changes.filter(
          ([, file]) => file.startsWith(files) || file === sentinel
        )
      ).toEqual([
        ["lchown", files, owner.uid, owner.gid],
        ["lchown", files, next.uid, next.gid],
      ]);
      expect((await stat(files)).mode & 0o777).toBe(0o700);
      expect(await readFile(sentinel, "utf8")).toBe("untouched");
      expect(await readFile(path.join(files, "planted"), "utf8")).toBe(
        "untouched"
      );
      expect(
        await readFile(path.join(files, "nested", "report.md"), "utf8")
      ).toBe("report");
    }
  );

  it("rejects a retry after launch was recorded but the receipt was lost", async () => {
    const first = await start();
    processes.spawn.mockImplementationOnce(
      async (_command, _cwd, _env, _log, save) => {
        await save(identity);
        kernelHost = identity;
        throw new Error("receipt lost");
      }
    );
    await expect(startHost(first, launch())).rejects.toThrow("receipt lost");
    first.close();

    const recovered = await start();
    await expect(startHost(recovered, launch())).rejects.toThrow(
      "already has a host"
    );
    expect(await recovered.alive(agentId)).toBe(true);
    expect(processes.spawn).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping launches and stops", async () => {
    const running = await start();
    const first = startHost(running, launch());
    const second = startHost(running, launch());
    const stopped = running.stop(agentId, false);
    await expect(second).rejects.toThrow("already has a host");
    await first;
    await stopped;
    expect(processes.spawn).toHaveBeenCalledTimes(1);
    expect(processes.stop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(identity),
      false
    );
  });

  it("preserves the bounded reader for startup file delivery", async () => {
    const dir = await realpath(root);
    const original = path.join(dir, "original.txt");
    await writeFile(original, "complete");
    expect(await readSessionFile(dir, "original.txt")).toEqual(
      Buffer.from("complete")
    );
    await symlink(original, path.join(dir, "symlink.txt"));
    await expect(readSessionFile(dir, "symlink.txt")).rejects.toThrow();
    await link(original, path.join(dir, "hardlink.txt"));
    await expect(readSessionFile(dir, "hardlink.txt")).rejects.toThrow(
      "Hard-linked"
    );
    const large = await open(path.join(dir, "large.txt"), "w");
    try {
      await large.truncate(MAX_SESSION_FILE_BYTES + 1);
    } finally {
      await large.close();
    }
    await expect(readSessionFile(dir, "large.txt")).rejects.toThrow("20 MiB");
  });

  it("passes file paths unchanged to the workload and propagates its OS denial", async () => {
    const runner = await start();
    const cwd = await realpath(root);
    const transfer = vi.fn(async () => "YWJj");
    const first = launch();
    await startHost(runner, first);
    const privateFile = path.join(state, "private.txt");
    await writeFile(privateFile, "supervisor only", { mode: 0o600 });
    const collect = (id: string, file: string) =>
      runner.withSessionFile(id, { path: file }, transfer);

    expect(await collect(agentId, "/tmp/shot.png")).toBe("YWJj");
    expect(transfer).toHaveBeenLastCalledWith("", "/tmp/shot.png");
    const foreign = path.join(state, "hosts", "other", "files", "input.txt");
    expect(await collect(agentId, foreign)).toBe("YWJj");
    expect(transfer).toHaveBeenLastCalledWith("", foreign);
    expect(await collect(agentId, "../input.txt")).toBe("YWJj");
    expect(transfer).toHaveBeenLastCalledWith(
      path.join(state, "sessions", agentId),
      "../input.txt"
    );

    transfer.mockRejectedValueOnce(
      new Error("Session file is unavailable (EACCES).")
    );
    await expect(collect(agentId, privateFile)).rejects.toThrow("EACCES");
    expect(transfer).toHaveBeenLastCalledWith("", privateFile);
    await expect(collect("unbound/session", privateFile)).rejects.toThrow(
      "unbound"
    );
    expect(transfer).toHaveBeenCalledTimes(4);
  });

  it("resolves delivered files inside the session files area", async () => {
    const runner = await start();
    const cwd = await realpath(root);
    const transfer = vi.fn(async () => "");
    const first = launch();
    await startHost(runner, first);
    const deliver = (name: string) =>
      runner.withSessionFile(agentId, { name }, async (root, name) => {
        await transfer(root, name);
        return path.join(root, name);
      });
    const destination = await deliver("résumé (1).pdf");
    expect(transfer).toHaveBeenLastCalledWith(
      path.dirname(destination),
      "résumé (1).pdf"
    );
    expect(path.basename(destination)).toBe("résumé (1).pdf");
    expect(path.basename(path.dirname(destination))).toBe("files");
    await expect(deliver("../escape")).rejects.toThrow("Invalid");
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  const helper = [
    "bun",
    "--no-env-file",
    fileURLToPath(new URL("../src/main.ts", import.meta.url)),
    "runner-session-file",
  ];

  it("runs file reads through setpriv with the workload UID and GID", () => {
    const [bin, args] = sessionFileCommand(
      1234,
      2345,
      helper,
      "stream",
      "",
      "/tmp/file"
    );
    expect(bin).toBe("/usr/bin/setpriv");
    expect(args).toEqual([
      "--reuid=1234",
      "--regid=2345",
      "--init-groups",
      "--no-new-privs",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--",
      ...helper,
      "stream",
      "",
      "/tmp/file",
    ]);
  });

  it("reads hard links, symlinks and a large file with the actual workload helper", async () => {
    const execute = promisify(execFile);
    const file = path.join(root, "ordinary");
    const hard = path.join(root, "hard");
    const soft = path.join(root, "soft");
    const contents = Buffer.alloc(21 * 1024 * 1024, 0xa6);
    await writeFile(file, contents);
    await link(file, hard);
    await symlink(hard, soft);
    const { stdout } = await execute(
      helper[0]!,
      [...helper.slice(1), "stream", "", soft],
      {
        encoding: "buffer",
        maxBuffer: contents.length + 1024,
        timeout: 15_000,
      }
    );
    expect(stdout.length).toBe(contents.length);
    expect(stdout.equals(contents)).toBe(true);
    await expect(
      execute(helper[0]!, [...helper.slice(1), "collect", "", soft], {
        timeout: 15_000,
      })
    ).rejects.toHaveProperty("stderr", "Session files are limited to 20 MiB.");
  });

  it.skipIf(process.platform !== "linux")(
    "writes a streamed file of any size with the workload helper and discards a short one",
    async () => {
      const contents = Buffer.alloc(21 * 1024 * 1024, 0x3c);
      const put = (name: string, size: number, bytes: Buffer) =>
        new Promise<number | null>((resolve, reject) => {
          const child = execFile(
            helper[0]!,
            [...helper.slice(1), "receive", root, `${size}:${name}`],
            { timeout: 15_000 }
          );
          child.once("error", reject);
          child.once("close", resolve);
          child.stdin!.end(bytes);
        });
      expect(await put("big.bin", contents.length, contents)).toBe(0);
      expect(
        (await readFile(path.join(root, "big.bin"))).equals(contents)
      ).toBe(true);
      expect(await put("short.bin", 10, Buffer.from("abc"))).not.toBe(0);
      await expect(readFile(path.join(root, "short.bin"))).rejects.toThrow();
    }
  );

  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "gets EACCES from the kernel for a root-owned file after dropping privileges",
    async () => {
      const execute = promisify(execFile);
      await chmod(root, 0o755);
      const publicFile = path.join(root, "public.txt");
      const privateFile = path.join(root, "private.txt");
      await writeFile(publicFile, "public", { mode: 0o644 });
      await writeFile(privateFile, "private", { mode: 0o600 });
      const collect = (file: string) => {
        const [bin, args] = sessionFileCommand(
          65534,
          65534,
          helper,
          "stream",
          "",
          file
        );
        return execute(bin, args, { timeout: 15_000 });
      };
      expect((await collect(publicFile)).stdout).toBe("public");
      await expect(collect(privateFile)).rejects.toMatchObject({
        stderr: "Session file is unavailable (EACCES).",
        stdout: "",
      });
    }
  );

  it("treats a recycled PID as stale and leaves an unrelated host running", async () => {
    const running = await start();
    await startHost(running, launch());
    const unrelated = { ...identity, start: "501" };
    kernelHost = unrelated;
    expect(await running.alive(agentId)).toBe(false);
    expect(await running.attach(agentId)).toBeNull();
    await running.stop(agentId, true);
    expect(kernelHost).toBe(unrelated);
  });

  it.each(["drains", "persists", "untracked"])(
    "checks the exact socket path when the socket %s after Stop",
    async (stateAfterStop) => {
      const running = await start();
      await startHost(running, launch());
      const recorded = parseSessionIdentity(await readFile(record, "utf8"));
      if (stateAfterStop === "untracked") await rm(record);

      const socket = path.join(state, "hosts", agentId, HOST_FILES.socket);
      const row = (pathname: string) =>
        `0000: 00000002 00000000 00010000 0001 01 12345 ${pathname}\n`;
      const otherRow = row(socket + ".other");
      const readUnix = vi.fn(() => row(socket) + otherRow);
      if (stateAfterStop === "drains")
        readUnix
          .mockImplementation(() => otherRow)
          .mockReturnValueOnce(row(socket) + otherRow);
      processes.socketInUse.mockImplementation((pathname) =>
        socketInUse(pathname, readUnix)
      );

      const stopped = running.stop(agentId, false);
      if (stateAfterStop === "drains") {
        await expect(stopped).resolves.toBeUndefined();
        expect(readUnix).toHaveBeenCalledTimes(2);
      } else {
        await expect(stopped).rejects.toThrow(
          "Runner cannot verify ownership of the existing guest host."
        );
      }
      expect(readUnix).toHaveBeenCalledWith("/proc/net/unix", "utf8");
      if (stateAfterStop === "untracked") {
        expect(readUnix).toHaveBeenCalledTimes(1);
        expect(processes.stop).not.toHaveBeenCalled();
        expect(processes.cleanup).not.toHaveBeenCalled();
      } else {
        expect(readUnix.mock.calls.length).toBeGreaterThan(1);
        expect(processes.stop).toHaveBeenCalledWith(recorded, false);
        expect(processes.cleanup).toHaveBeenCalledWith(recorded);
        expect(processes.cleanup).toHaveBeenCalledBefore(readUnix);
      }
    }
  );

  it("fences a legacy live socket and rejects a second supervisor", async () => {
    const running = await start();
    await expect(start()).rejects.toThrow("Already locked");
    const hostDir = path.join(state, "hosts", agentId);
    await mkdir(hostDir);
    await writeFile(path.join(hostDir, "host.pid"), "100\n");
    processes.socketInUse.mockReturnValue(true);
    await expect(startHost(running, launch())).rejects.toThrow(
      "cannot verify ownership"
    );
    await expect(running.stop(agentId, true)).rejects.toThrow(
      "cannot verify ownership"
    );
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(processes.stop).not.toHaveBeenCalled();
  });

  it("reuses an idle managed binding", async () => {
    const binding = "\0managed";
    const running = await start();
    const bindings = path.join(state, "bindings");
    await writeFile(path.join(bindings, agentId), binding, { mode: 0o600 });
    {
      await writeFile(path.join(bindings, agentId + ".owner"), marker, {
        mode: 0o600,
      });
      await writeFile(path.join(bindings, agentId + ".repository"), "null", {
        mode: 0o600,
      });
    }
    expect(await running.alive(agentId)).toBe(false);
    await startHost(running, launch());
    expect(await running.alive(agentId)).toBe(true);
    expect(processes.cleanupLegacy.mock.calls).toEqual([[marker]]);
  });

  it("serves contract line limits and typed lifecycle errors through enrolled handlers", async () => {
    const runner = await start();
    const fixture = launch();
    await startHost(runner, fixture);
    const { calls } = enrolledSessions(runner, () => {});
    const session = sessionFromWire(agentId);
    await writeFile(
      path.join(state, "bindings", "logs", agentId),
      "first\n" + "middle\n".repeat(1000) + "last\n"
    );
    expect(await calls["session.logs"]({ session, lines: 1 })).toEqual({
      text: "last",
    });
    expect(await calls["session.logs"]({ session, lines: 3 })).toEqual({
      text: "middle\nmiddle\nlast",
    });
    expect(await calls["session.logs"]({ session, lines: 0 })).toEqual({
      text: "",
    });
    await expect(calls["session.discard"]({ session })).rejects.toMatchObject({
      code: "busy",
    });
    await expect(
      startHost(runner, {
        ...fixture,
        launch: { ...fixture.launch, launchId: randomUUID() },
      })
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("reads a bounded UTF-8 tail from a large guest log", async () => {
    const running = await start();
    await startHost(running, launch());
    const log = await open(path.join(state, "bindings", "logs", agentId), "r+");
    const expected = "x".repeat(2044) + "✓";
    try {
      // A sparse offset beyond Node's whole-file read limit leaves the actual
      // disk usage small. The 2 KiB tail starts within the preceding emoji.
      await log.write("🚀" + expected, 2 ** 31, "utf8");
    } finally {
      await log.close();
    }
    expect(await running.log(agentId)).toBe(
      "Guest agent host log.\n" + expected
    );
  });

  it("leaves the durable record in place when cleanup fails", async () => {
    const running = await start();
    await startHost(running, launch());
    processes.cleanup.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(running.stop(agentId, true)).rejects.toThrow("cleanup failed");
    await expect(stat(record)).resolves.toBeDefined();
    await running.stop(agentId, true);
    await expect(stat(record)).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function proveServiceMcp(codex?: string) {
    const probeResult = path.join(root, "codex-probe-result");
    let workload: Parameters<typeof start>[3];
    if (codex) {
      const probe = path.join(root, "codex-mcp-probe.mjs");
      const fixture = await readFile(
        new URL("./helpers/codex-mcp-probe.mjs", import.meta.url),
        "utf8"
      );
      await writeFile(probe, "#!/usr/bin/env node\n" + fixture, {
        mode: 0o700,
      });
      // Let the adapter initialize offline without an OpenAI login. The
      // probe only issues an app-server tool call, so no model turn is sent.
      await writeFile(
        path.join(root, "config.toml"),
        'model_provider = "fixture"\n' +
          "[model_providers.fixture]\n" +
          'name = "Offline fixture"\n' +
          'base_url = "http://127.0.0.1:1/v1"\n'
      );
      const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
      workload = {
        bins: { claudeBin: "", codexBin: probe },
        hostCommand: (dir) => ["bun", main, "agent-host", "--state", dir],
        env: {
          HOME: root,
          CODEX_HOME: root,
          PATH: process.env.PATH,
          FIXTURE_CODEX_BIN: codex,
          FIXTURE_PROBE_RESULT: probeResult,
        },
      };
    }
    const running = await start(undefined, workload);
    const ca = issueAuthority("First launch fixture");
    const leaf = issueServer(ca, ["127.0.0.1"]);
    await writeFile(path.join(state, "runner-ca.pem"), ca.cert);
    const app = Fastify({ https: { cert: leaf.cert, key: leaf.key } });
    const secret = "isolated first launch fixture";
    const token = createAgentMcpToken(secret, reviewerId);
    let active = true;
    const addTemplate = vi.fn(
      async (
        input: { name: string; fullAccess: boolean },
        callerFullAccess: boolean
      ) => {
        assertAccessCeiling(input.fullAccess, callerFullAccess);
        return { id: "fixture-template", name: input.name };
      }
    );
    await registerMcpRoutes(app, {
      config: { authToken: secret },
      // The fixture session records no repository and has no project.
      pool: { query: async () => ({ rows: [] }) },
      providerPlans: async () => ({}),
      getBearerToken: (request) =>
        /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null,
      validateAgentMcpToken,
      agentManager: {
        getAgent: async (id: string) => ({
          id,
          cwd: "/fixture/proof",
          placement: placementForRunner("fixture"),
          parentAgentId: agentId,
          fullAccess: false,
        }),
        permitsRemoteAgentMcp: () => active,
      },
      jobService: { getActiveRunForAgent: async () => null },
      templateService: { addTemplate },
      mcpMethodNotAllowed: () => ({}),
    } as Parameters<typeof registerMcpRoutes>[1]);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    let host: ReturnType<typeof spawn> | undefined;
    try {
      // The author starts with MCP omitted. The restricted child gets its own
      // endpoint and credential even though it borrows the author's checkout.
      await startHost(running, launch());
      processes.spawn.mockImplementationOnce(
        async ([bin, ...args], cwd, env, log, save) => {
          if (codex) {
            host = spawn(bin!, args, {
              cwd,
              env,
              stdio: ["ignore", log, log],
            });
            await once(host, "spawn");
          }
          kernelReviewer = { ...identity, pid: host?.pid ?? 101 };
          await save(kernelReviewer);
        }
      );
      const child = sharedLaunch();
      const mcp = {
        name: "service",
        url: origin + "/api/mcp/" + reviewerId,
        token,
      };
      await startHost(running, {
        ...child,
        launch: { ...child.launch, mcp, fullAccess: false },
      });
      const dir = path.join(state, "hosts", reviewerId);
      const payload: HostLaunch = JSON.parse(
        await readFile(path.join(dir, "launch.json"), "utf8")
      );
      expect(payload.mcp).toEqual(mcp);
      expect(payload.fullAccess).toBe(false);
      expect(payload.env.DISPATCH_API_URL).toBe(origin);
      const caPath = payload.env.DISPATCH_LOCAL_CA_CERTIFICATE!;
      expect(await readFile(caPath, "utf8")).toBe(ca.cert);
      expect((await stat(caPath)).mode & 0o777).toBe(0o600);
      if (codex) {
        // Check that the tool returned and the real host completed its
        // session/new handoff with the adapter.
        await vi
          .waitFor(
            async () => {
              expect(await readFile(probeResult, "utf8")).toBe("ok");
              const session = JSON.parse(
                await readFile(path.join(dir, "session.json"), "utf8")
              );
              expect(session.sessionId).toEqual(expect.any(String));
            },
            { timeout: 15_000, interval: 50 }
          )
          .catch(async (error) => {
            const log = await running.log(reviewerId);
            throw new Error(log.replaceAll(token, "[fixture bearer]"), {
              cause: error,
            });
          });
      } else {
        const env = buildHostEnv(payload, dir, hostSearchPath, {
          HOME: root,
          PATH: process.env.PATH,
        });
        const request = async (url: string, fullAccess: boolean) => {
          const { stdout } = await promisify(execFile)(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
              const [url, fullAccess] = process.argv.slice(1);
              const response = await fetch(url, {
                method: "POST",
                headers: {
                  authorization: "Bearer " + process.env.FIXTURE_TOKEN,
                  accept: "application/json, text/event-stream",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0", id: 1, method: "tools/call",
                  params: { name: "create_template", arguments: {
                    name: "first launch", fullAccess: fullAccess === "true"
                  }},
                }),
              });
              console.log(response.status, await response.text());
            `,
              url,
              String(fullAccess),
            ],
            { env: { ...env, FIXTURE_TOKEN: token }, timeout: 5000 }
          );
          expect(stdout).not.toContain(token);
          return stdout;
        };
        expect(await request(mcp.url, false)).toContain("fixture-template");
        expect(await request(mcp.url, true)).toContain("restricted agent");
        expect(await request(origin + "/api/mcp/" + agentId, false)).toMatch(
          /^403 /
        );
        active = false;
        expect(await request(mcp.url, false)).toMatch(/^403 /);
      }
      expect(addTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "first launch", fullAccess: false }),
        false,
        expect.any(Function)
      );
    } finally {
      if (host?.pid && host.exitCode === null && host.signalCode === null) {
        const exited = once(host, "exit");
        const force = setTimeout(() => host?.kill("SIGKILL"), 3_000);
        host.kill("SIGTERM");
        try {
          await exited;
        } finally {
          clearTimeout(force);
        }
      }
      await app.close();
    }
  }

  it("uses workload trust for a session-bound TLS tool and denies escalation and revocation", async () => {
    await proveServiceMcp();
  }, 15_000);

  it.runIf(Boolean(process.env.DISPATCH_TEST_CODEX_BIN))(
    "calls the TLS tool on first launch through the production Codex adapter",
    async () => {
      await proveServiceMcp(process.env.DISPATCH_TEST_CODEX_BIN);
    },
    25_000
  );

  it("starts the reviewer in the author's checkout with independent state", async () => {
    const running = await start();
    const author = path.join(state, "sessions", agentId);
    const reviewerHost = path.join(state, "hosts", reviewerId);
    await startHost(running, launch());
    await writeFile(path.join(author, "uncommitted.txt"), "author's work");
    const reviewerIdentity = { ...identity, pid: 101 };
    processes.spawn.mockImplementationOnce(
      async (command, launcherCwd, _env, _log, save) => {
        expect(launcherCwd).toBe("/");
        const cwd = command.at(-1)!;
        expect(command.at(-3)).toBe(reviewerHost);
        expect(cwd).toBe(author);
        expect(await readFile(path.join(cwd, "uncommitted.txt"), "utf8")).toBe(
          "author's work"
        );
        await save(reviewerIdentity);
        kernelReviewer = reviewerIdentity;
      }
    );
    await startHost(running, sharedLaunch());
    expect(await running.alive(reviewerId)).toBe(true);
    expect(await running.checkoutDirectory(reviewerId)).toBe(author);
    const payload = JSON.parse(
      await readFile(path.join(reviewerHost, "launch.json"), "utf8")
    );
    expect(payload).toMatchObject({
      agentId: reviewerId,
      cwd: author,
      env: { DISPATCH_FILES_DIR: path.join(reviewerHost, "files") },
    });
    expect(payload).not.toHaveProperty("useWorktreeOf");
    expect(payload).not.toHaveProperty("mcp");
    await expect(
      stat(path.join(reviewerHost, "service-mcp-ca.pem"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(path.join(state, "sessions", reviewerId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(running.discard(reviewerId)).rejects.toThrow(
      "Stop the guest host"
    );
    await running.stop(reviewerId, true);
    await running.discard(reviewerId);
    expect(await running.alive(agentId)).toBe(true);
    expect(await readFile(path.join(author, "uncommitted.txt"), "utf8")).toBe(
      "author's work"
    );
  });

  it("retains the author checkout until all borrower state is discarded across restarts", async () => {
    const running = await start();
    await startHost(running, launch());
    await running.stop(agentId, true);
    // Even a failed spawn has reserved the binding. Only a successful
    // discard confirms that any partially started host is gone.
    processes.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(startHost(running, sharedLaunch())).rejects.toThrow(
      "spawn failed"
    );
    await expect(running.discard(agentId)).rejects.toThrow("still in use");
    running.close();

    const recovered = await start();
    const author = path.join(state, "sessions", agentId);
    expect(await recovered.checkoutDirectory(reviewerId)).toBe(author);
    await expect(recovered.checkoutDirectory(agentId)).rejects.toThrow(
      "archived"
    );
    await expect(
      startHost(recovered, { ...sharedLaunch(), agentId: "agt_new" })
    ).rejects.toThrow("archived");
    // A relaunch has no checkout selection; it uses the persisted borrower binding.
    processes.spawn.mockResolvedValueOnce();
    await startHost(recovered, { ...launch(), agentId: reviewerId });
    expect(hostCwd(processes.spawn.mock.calls.at(-1)!)).toBe(author);
    await expect(recovered.discard(agentId)).rejects.toThrow("still in use");
    await recovered.discard(reviewerId);
    await expect(stat(author)).resolves.toBeDefined();
    await recovered.discard(agentId);
    await recovered.discard(agentId);
    await expect(stat(author)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("observes ownership alone for an authorized removal: no checkout state is read (no Git status or fetch)", async () => {
    // The state read (Git status, and the fetch archive changes run).
    const observeCheckout = vi.fn(async () => {
      throw new Error("no checkout state is read");
    });
    const running = await start(vi.fn(), { observeCheckout });
    await startHost(running, launch());
    await running.stop(agentId, true);
    const { calls } = enrolledSessions(running, vi.fn());
    const session = sessionFromWire(agentId);
    expect(
      await calls["workspace.observe"]({ session, policy: "ownership" })
    ).toEqual({
      ownership: "owned",
      owner: agentId,
      borrowers: [],
      checkout: null,
    });
    expect(observeCheckout).not.toHaveBeenCalled();
    await expect(calls["workspace.observe"]({ session })).rejects.toThrow(
      "no checkout state is read"
    );
    expect(observeCheckout).toHaveBeenCalledOnce();
  });

  it("holds the owner checkout through a concurrent borrower launch", async () => {
    const running = await start();
    await startHost(running, launch());
    await running.stop(agentId, true);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    processes.spawn.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
    });
    const started = startHost(running, sharedLaunch());
    await entered.promise;
    const discarding = running.discard(agentId);
    finish.resolve();
    await started;
    await expect(discarding).rejects.toThrow("still in use");
  });

  it("rejects invalid, unbound and indirect self references", async () => {
    const running = await start();
    await expect(
      startHost(running, sharedLaunch(reviewerId))
    ).rejects.toThrow();
    await expect(startHost(running, sharedLaunch("bad\0id"))).rejects.toThrow();
    await expect(startHost(running, sharedLaunch())).rejects.toThrow(
      "No checkout is bound"
    );
    await startHost(running, launch());
    processes.spawn.mockResolvedValueOnce();
    await startHost(running, sharedLaunch());
    await expect(
      startHost(running, { ...sharedLaunch(reviewerId), agentId })
    ).rejects.toThrow();
    expect(processes.spawn).toHaveBeenCalledTimes(2);
  });

  it("discards a retired borrower host and binding without deleting its owner checkout", async () => {
    const runner = await start();
    await startHost(runner, launch());
    await runner.stop(agentId, true);
    processes.spawn.mockResolvedValueOnce();
    await startHost(runner, sharedLaunch());
    const checkout = await runner.checkoutDirectory(agentId);
    await writeFile(path.join(checkout, "owner-sentinel"), "keep");
    const host = path.join(state, "hosts", reviewerId);
    expect((await stat(host)).isDirectory()).toBe(true);
    await enrolledSessions(runner, () => {}).calls["session.retire"]({
      session: sessionFromWire(reviewerId),
    });
    await expect(stat(host)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runner.isBound(reviewerId)).toBe(false);
    await expect(
      readFile(path.join(state, "bindings", reviewerId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(checkout, "owner-sentinel"), "utf8")).toBe(
      "keep"
    );
    expect(await runner.isBound(agentId)).toBe(true);
  });

  it("retires an owned host and binding while retaining its decided checkout", async () => {
    const runner = await start();
    await startHost(runner, launch());
    await runner.stop(agentId, true);
    const checkout = await runner.checkoutDirectory(agentId);
    await writeFile(path.join(checkout, "retained-checkout"), "dirty bytes");
    const handler = enrolledSessions(runner, () => {}).calls["session.retire"];
    await handler({ session: sessionFromWire(agentId), checkoutPending: true });
    expect(await runner.isBound(agentId)).toBe(true);
    await expect(
      stat(path.join(state, "hosts", agentId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runner.observeWorkspace(agentId, "ownership")).toMatchObject({
      ownership: "owned",
    });
    for (let attempt = 0; attempt < 2; attempt++)
      await handler({
        session: sessionFromWire(agentId),
      });
    expect(
      await readFile(path.join(checkout, "retained-checkout"), "utf8")
    ).toBe("dirty bytes");
    expect(await runner.isBound(agentId)).toBe(false);
    await expect(
      stat(path.join(state, "hosts", agentId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(state, "bindings", agentId))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps owner metadata usable until its last borrower retires", async () => {
    const runner = await start();
    await startHost(runner, launch());
    await runner.stop(agentId, true);
    processes.spawn.mockResolvedValueOnce();
    await startHost(runner, sharedLaunch());
    await runner.stop(reviewerId, true);
    const checkout = await runner.checkoutDirectory(agentId);
    const handler = enrolledSessions(runner, () => {}).calls["session.retire"];
    await expect(
      handler({ session: sessionFromWire(agentId) })
    ).rejects.toMatchObject({
      code: "busy",
    });
    await expect(
      stat(path.join(state, "hosts", agentId))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runner.checkoutDirectory(reviewerId)).toBe(checkout);
    expect(await runner.isBound(agentId)).toBe(true);
    await handler({ session: sessionFromWire(reviewerId) });
    await handler({ session: sessionFromWire(agentId) });
    expect(await runner.isBound(agentId)).toBe(false);
    expect((await stat(checkout)).isDirectory()).toBe(true);
    expect(
      (await readdir(path.join(state, "bindings"))).filter(
        (name) => name.startsWith(agentId) && !name.endsWith(".retired")
      )
    ).toEqual([]);
  });

  it("retries preparation metadata cleanup after the active binding is gone", async () => {
    const forget = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary metadata failure"))
      .mockResolvedValue(undefined);
    const runner = await start(undefined, { forgetPreparedCheckout: forget });
    await startHost(runner, launch());
    await runner.stop(agentId, true);
    const checkout = await runner.checkoutDirectory(agentId);
    await writeFile(path.join(checkout, "kept"), "do not remove");
    const handler = enrolledSessions(runner, () => {}).calls["session.retire"];
    await expect(
      handler({ session: sessionFromWire(agentId) })
    ).rejects.toThrow("temporary metadata failure");
    expect(await runner.isBound(agentId)).toBe(false);
    await handler({ session: sessionFromWire(agentId) });
    expect(forget).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenLastCalledWith(agentId);
    expect(await readFile(path.join(checkout, "kept"), "utf8")).toBe(
      "do not remove"
    );
  });

  it("binds a nested managed reviewer directly to the durable checkout owner", async () => {
    const nested = "agt_nested";
    const running = await start();
    await startHost(running, launch());
    await running.stop(agentId, true);
    processes.spawn.mockResolvedValueOnce();
    await startHost(running, sharedLaunch());
    running.close();

    const recovered = await start();
    processes.spawn.mockResolvedValueOnce();
    await startHost(recovered, {
      ...sharedLaunch(reviewerId),
      agentId: nested,
    });
    await recovered.discard(reviewerId);
    const author = path.join(state, "sessions", agentId);
    expect(await recovered.checkoutDirectory(nested)).toBe(author);
    await expect(recovered.discard(agentId)).rejects.toThrow("still in use");
    await recovered.discard(nested);
    await recovered.discard(agentId);
    await expect(stat(author)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists moved and borrowed checkouts independently across restarts", async () => {
    const nested = "agt_nested";
    const independent = "agt_independent";
    const asWorkload = async (bin: string, args: string[]) =>
      bin === "realpath"
        ? (await realpath(args.at(-1)!)) + "\n"
        : execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    const runner = await start(asWorkload);
    const checkout = path.join(await realpath(root), "moved");
    const subdir = path.join(checkout, "src");
    await mkdir(subdir, { recursive: true });
    await asWorkload("git", ["-C", checkout, "init", "-b", "main"]);
    await asWorkload("git", [
      "-C",
      checkout,
      "config",
      "remote.origin.url",
      "https://secret@example.test/org/project.git",
    ]);
    await startHost(runner, launch());
    const select = (path: string) =>
      runner.sessionCheckout(agentId, { kind: "select", path });
    const owningDir = path.join(state, "sessions", agentId);
    const owningSubdir = path.join(owningDir, "subdirectory");
    await mkdir(owningSubdir);
    await expect(select(owningSubdir)).resolves.toMatchObject({
      path: owningSubdir,
    });

    // Any folder the workload account can use, as on the controller (T16).
    const ancestor = path.dirname(state);
    const alias = path.join(owningDir, "ancestor-link");
    await symlink(ancestor, alias);
    for (const folder of ["/", ancestor, alias, state])
      await expect(select(folder)).resolves.toMatchObject({ moved: true });
    // A subdirectory moves to its Git root, checked again as the workload.
    const sibling = path.join(ancestor, "sibling");
    await mkdir(sibling);
    await asWorkload("git", ["-C", ancestor, "init"]);
    await expect(select(sibling)).resolves.toMatchObject({ path: ancestor });
    await expect(select(path.join(ancestor, "missing"))).rejects.toThrow(
      "unavailable to the runner workload"
    );
    await rm(path.join(ancestor, ".git"), { recursive: true, force: true });
    await select(owningSubdir);
    await expect(runner.checkoutDirectory(agentId)).resolves.toBe(owningSubdir);

    await expect(
      runner.sessionCheckout(agentId, {
        kind: "select",
        path: subdir,
      })
    ).resolves.toEqual({
      path: checkout,
      moved: true,
      origin: "https://example.test/org/project.git",
      repositoryRoot: checkout,
      checkoutRoot: checkout,
      branch: "main",
    });
    processes.spawn.mockResolvedValueOnce();
    await startHost(runner, sharedLaunch());
    processes.spawn.mockResolvedValueOnce();
    await startHost(runner, { ...sharedLaunch(reviewerId), agentId: nested });
    processes.spawn.mockResolvedValueOnce();
    await startHost(runner, { ...launch(), agentId: independent });
    const independentDir = await runner.checkoutDirectory(independent);
    await expect(
      runner.sessionCheckout(agentId, {
        kind: "select",
        path: independentDir,
      })
    ).resolves.toMatchObject({ path: independentDir, moved: true });
    await select(subdir);

    await runner.stop(agentId, false);
    runner.close();
    const recovered = await start(asWorkload);
    await startHost(recovered, launch());
    expect(hostCwd(processes.spawn.mock.calls.at(-1)!)).toBe(checkout);
    await expect(recovered.checkoutDirectory(independent)).resolves.toBe(
      independentDir
    );
    await recovered.sessionCheckout(agentId, {
      kind: "select",
      path: null,
    });
    expect(await recovered.checkoutDirectory(agentId)).not.toBe(checkout);
    for (const borrower of [reviewerId, nested])
      await expect(recovered.checkoutDirectory(borrower)).resolves.toBe(
        checkout
      );
    processes.spawn.mockResolvedValueOnce();
    await startHost(recovered, {
      ...sharedLaunch(reviewerId),
      agentId: nested,
    });
    expect(hostCwd(processes.spawn.mock.calls.at(-1)!)).toBe(checkout);

    // The runner core's binding adapter (T19b) reads these same files and
    // answers the same folder for every session this build bound.
    const { bindings } = await createLinuxPrivsep({
      state: await realpath(state),
      ids: {
        supervisor: process.getuid!(),
        uid: process.getuid!(),
        gid: process.getgid!(),
      },
      asWorkload,
    });
    for (const id of [agentId, reviewerId, nested, independent]) {
      const bound = await bindings.get(id);
      expect(bound).not.toBeNull();
      expect(bound!.currentPath ?? bound!.path).toBe(
        await recovered.checkoutDirectory(id)
      );
    }
  });

  it("tells the core's binding store after each binding write, and never fails for it", async () => {
    const asWorkload = async (bin: string, args: string[]) =>
      bin === "realpath"
        ? (await realpath(args.at(-1)!)) + "\n"
        : execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    let store: Awaited<ReturnType<typeof createLinuxPrivsep>> | undefined;
    let fail = false;
    const told: string[] = [];
    const runner = await start(asWorkload, {
      async bindingWritten(id) {
        told.push(id);
        if (fail) throw new Error("store unavailable");
        await store?.bindings.get(id);
      },
    });
    store = await createLinuxPrivsep({
      state: await realpath(state),
      ids: {
        supervisor: process.getuid!(),
        uid: process.getuid!(),
        gid: process.getgid!(),
      },
      asWorkload,
    });
    // The record as written, not as a read would reconcile it.
    const record = async () => {
      const text = await readFile(
        path.join(
          await realpath(state),
          "bindings",
          ".bindings",
          createHash("sha256").update(agentId).digest("hex") + ".json"
        ),
        "utf8"
      ).catch(() => null);
      return text === null ? null : JSON.parse(text);
    };
    await startHost(runner, launch());
    expect(told).toEqual([agentId, agentId]);
    const owning = path.join(await realpath(state), "sessions", agentId);
    expect(await record()).toMatchObject({
      session: agentId,
      path: owning,
      currentPath: null,
      checkout: { ownership: "owned" },
    });
    const subdir = path.join(owning, "subdirectory");
    await mkdir(subdir);
    await runner.sessionCheckout(agentId, {
      kind: "select",
      path: subdir,
    });
    expect(await record()).toMatchObject({ currentPath: subdir });

    // A store that fails changes nothing the supervisor does.
    fail = true;
    await expect(
      runner.sessionCheckout(agentId, { kind: "select", path: null })
    ).resolves.toMatchObject({ moved: false });
    expect(
      await readFile(
        path.join(state, "bindings", `${agentId}.selected-cwd`),
        "utf8"
      )
    ).toBe("");
    expect(await record()).toMatchObject({ currentPath: subdir });
    // ...and the store's next read takes the files.
    fail = false;
    expect(await store.bindings.get(agentId)).toMatchObject({
      currentPath: null,
    });

    await runner.stop(agentId, false);
    await runner.discard(agentId);
    expect(await record()).toBeNull();
  });

  it("lets a managed session select any folder its account can use, like local", async () => {
    const asWorkload = async (bin: string, args: string[]) =>
      bin === "realpath"
        ? (await realpath(args.at(-1)!)) + "\n"
        : execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    const runner = await start(asWorkload);
    await startHost(runner, launch());
    const ownedCheckout = await runner.checkoutDirectory(agentId);
    await expect(
      runner.checkoutDirectory(agentId, "moved")
    ).rejects.toMatchObject({ code: "not_found" });
    const select = (path: string) =>
      runner.sessionCheckout(agentId, { kind: "select", path });
    const sessions = path.join(state, "sessions");
    const parent = path.join(sessions, "agt_sibling");
    const checkout = path.join(parent, "checkout");
    const nested = path.join(checkout, "src");
    const privateDir = path.join(parent, "private");
    await mkdir(parent, { mode: 0o751 });
    await chmod(parent, 0o751);
    await mkdir(nested, { recursive: true });
    await mkdir(privateDir);
    await symlink(path.join(state, "bindings"), path.join(checkout, "escape"));
    // A workload-writable parent could swap the checkout for a symlink.
    const loose = path.join(sessions, "agt_loose", "checkout");
    await mkdir(loose, { recursive: true });
    await chmod(path.dirname(loose), 0o755);
    const badKey = path.join(sessions, "not-a-key", "checkout");
    await mkdir(badKey, { recursive: true });

    await expect(select(checkout)).resolves.toEqual({
      path: checkout,
      moved: true,
      origin: null,
      repositoryRoot: null,
      checkoutRoot: null,
      branch: null,
    });
    await expect(select(nested)).resolves.toMatchObject({ path: nested });
    // No confinement (T16): what the workload account can use is accepted,
    // and what it cannot is refused.
    for (const folder of [parent, privateDir, loose, badKey, sessions, state])
      await expect(select(folder)).resolves.toMatchObject({ path: folder });
    await expect(select(path.join(checkout, "escape"))).resolves.toMatchObject({
      path: path.join(state, "bindings"),
    });
    await expect(select(path.join(parent, "missing"))).rejects.toThrow(
      "unavailable to the runner workload"
    );
    await select(nested);
    await expect(runner.checkoutDirectory(agentId)).resolves.toBe(nested);
    expect(await runner.checkoutDirectory(agentId, "current")).toBe(nested);
    expect(await runner.checkoutDirectory(agentId, "launch")).toBe(
      ownedCheckout
    );
    expect(await runner.checkoutDirectory(agentId, "moved")).toBe(nested);
    expect(await runner.checkoutDirectory(agentId, "owned")).toBe(
      ownedCheckout
    );
    for (const unknown of ["unknown", null, 1])
      await expect(
        runner.checkoutDirectory(agentId, unknown as never)
      ).rejects.toThrow("Invalid checkout read selector.");
  });

  describe("a folder an agent named (D7)", () => {
    const asWorkload = async (bin: string, args: string[]) =>
      bin === "realpath"
        ? (await realpath(args.at(-1)!)) + "\n"
        : execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    /** The files the core's privsep store writes for a named folder. */
    async function bindFolder(folder: string) {
      const bindings = path.join(state, "bindings");
      await writeFile(path.join(bindings, agentId), "\0folder");
      await writeFile(path.join(bindings, `${agentId}.cwd`), folder);
    }
    async function namedFolder() {
      const folder = await realpath(await mkdtemp(path.join(root, "named-")));
      await writeFile(path.join(folder, "keep.txt"), "the user's work\n");
      return folder;
    }
    const bytes = async (folder: string) =>
      Object.fromEntries(
        await Promise.all(
          (await readdir(folder)).map(async (name) => [
            name,
            await readFile(path.join(folder, name), "utf8"),
          ])
        )
      );

    it("starts the host in the folder, entered only by the workload", async () => {
      const runner = await start(asWorkload, {
        hostCommand: (dir, cwd) => ["/test-host", "--state", dir, "--cwd", cwd],
      });
      const folder = await namedFolder();
      await bindFolder(folder);
      await startHost(runner, launch());
      expect(processes.spawn).toHaveBeenCalledTimes(1);
      // The privileged launcher starts in `/`; the folder goes to the host
      // command, which enters it after dropping privilege.
      const [command, cwd] = processes.spawn.mock.calls[0]!;
      expect(cwd).toBe("/");
      expect(command.slice(-2)).toEqual(["--cwd", folder]);
      await expect(runner.checkoutDirectory(agentId)).resolves.toBe(folder);
    });

    it("starts a folder session's child in the same folder, owned by neither", async () => {
      const runner = await start(asWorkload);
      const folder = await namedFolder();
      await bindFolder(folder);
      await startHost(runner, launch());
      // The core's store bound the child to the parent's folder.
      const bindings = path.join(state, "bindings");
      await writeFile(path.join(bindings, reviewerId), "\0folder");
      await writeFile(path.join(bindings, `${reviewerId}.cwd`), folder);
      processes.spawn.mockImplementationOnce(
        async (command, _cwd, _env, _log, save) => {
          expect(command.at(-1)).toBe(folder);
          await save({ ...identity, pid: 101 });
        }
      );
      await startHost(runner, { ...launch(), agentId: reviewerId });
      const before = await bytes(folder);
      for (const id of [reviewerId, agentId])
        expect(await runner.observeWorkspace(id)).toEqual({
          ownership: "external",
          owner: null,
          borrowers: [],
          checkout: null,
        });
      // Either archives first; neither removes the folder or waits on the other.
      await runner.stop(agentId, true);
      await runner.discard(agentId);
      await runner.stop(reviewerId, true);
      await expect(
        runner.releaseWorkspace(reviewerId, async () => true)
      ).resolves.toBe(false);
      expect(await bytes(folder)).toEqual(before);
    });

    it("never runs the host in a folder swapped after it was authorized", async () => {
      // The runner's own composition, minus setpriv: enter, then the host.
      const runner = await start(asWorkload, {
        hostCommand: (_dir, cwd) => [...enterDirectory(cwd), "pwd", "-P"],
      });
      const folder = await namedFolder();
      const sealed = await namedFolder();
      await bindFolder(folder);
      let ran: { code: number; out: string } | undefined;
      processes.spawn.mockImplementationOnce(
        async (command, cwd, _env, _log, save) => {
          // Between authorization and the host: the folder becomes a link to a
          // directory the account cannot enter.
          await rm(folder, { recursive: true });
          await chmod(sealed, 0o000);
          await symlink(sealed, folder);
          ran = await promisify(execFile)(command[0]!, command.slice(1), {
            cwd,
          }).then(
            ({ stdout }) => ({ code: 0, out: stdout }),
            (error: { code: number; stderr: string }) => ({
              code: error.code,
              out: error.stderr,
            })
          );
          await save(identity);
        }
      );
      try {
        await startHost(runner, launch());
      } finally {
        await chmod(sealed, 0o755);
      }
      // Refused whoever runs it: it cannot enter, or it is not the folder.
      expect(ran).toEqual({
        code: 125,
        out: expect.stringContaining("unavailable to the runner workload"),
      });
    });

    it("is never the runner's checkout: observed external, kept by every release", async () => {
      const runner = await start(asWorkload);
      const folder = await namedFolder();
      await bindFolder(folder);
      await startHost(runner, launch());
      const before = await bytes(folder);
      expect(await runner.observeWorkspace(agentId)).toEqual({
        ownership: "external",
        owner: null,
        borrowers: [],
        checkout: null,
      });
      await runner.stop(agentId, true);
      await expect(
        runner.releaseWorkspace(agentId, async () => true)
      ).resolves.toBe(false);
      expect(await bytes(folder)).toEqual(before);
      await runner.discard(agentId);
      expect(await bytes(folder)).toEqual(before);
    });

    it("fails the launch when the folder no longer resolves where it was bound", async () => {
      const runner = await start(asWorkload);
      const folder = await namedFolder();
      const elsewhere = await namedFolder();
      await bindFolder(folder);
      // Swapped for a link after it was resolved.
      await rm(folder, { recursive: true });
      await symlink(elsewhere, folder);
      await expect(startHost(runner, launch())).rejects.toThrow(
        "The named folder changed since it was resolved."
      );
      // Gone altogether.
      await rm(folder);
      await expect(startHost(runner, launch())).rejects.toThrow(
        "unavailable to the runner workload"
      );
      expect(processes.spawn).not.toHaveBeenCalled();
    });

    it("releases a worktree the core prepared from a session or a folder", async () => {
      const runner = await start(asWorkload);
      const bindings = path.join(state, "bindings");
      await writeFile(path.join(bindings, agentId), "\0managed");
      // The privsep store's record for a worktree with no repository.
      await writeFile(path.join(bindings, `${agentId}.repository`), "{}");
      await mkdir(path.join(state, "sessions", agentId), { mode: 0o751 });
      const release = vi.fn(async () => true);
      await expect(runner.releaseWorkspace(agentId, release)).resolves.toBe(
        true
      );
      expect(release).toHaveBeenCalledWith();
      await expect(
        readFile(path.join(bindings, agentId))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("keeps the prepared-checkout rule for every other prepared session", async () => {
      const runner = await start(asWorkload, {
        resumePreparedCheckout: async () => ({
          path: "/tmp/elsewhere",
          checkoutRoot: "/tmp/elsewhere",
        }),
      } as never);
      const bindings = path.join(state, "bindings");
      await writeFile(path.join(bindings, agentId), "\0managed");
      await writeFile(path.join(bindings, `${agentId}.repository`), "null");
      await mkdir(path.join(state, "sessions", agentId), { mode: 0o751 });
      await chmod(path.join(state, "sessions", agentId), 0o751);
      await expect(startHost(runner, launch())).rejects.toThrow(
        "The prepared checkout binding changed."
      );
      expect(processes.spawn).not.toHaveBeenCalled();
    });
  });

  it("rejects symlink redirection of a legacy repository checkout", async () => {
    const running = await start();

    const author = path.join(state, "sessions", agentId);
    await mkdir(author);
    await symlink(root, path.join(author, "checkout"));
    await writeFile(path.join(state, "bindings", agentId), "\0managed");
    await writeFile(
      path.join(state, "bindings", agentId + ".repository"),
      "{}"
    );
    await expect(startHost(running, sharedLaunch())).rejects.toThrow(
      "checkout is unavailable"
    );
    await expect(running.checkoutDirectory(agentId)).rejects.toThrow(
      "checkout is unavailable"
    );
    expect(await running.isBound(reviewerId)).toBe(false);
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  it("borrows a pre-migration Git worktree and retries owner cleanup", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8" });

    const url = "https://github.com/fixture/project.git";
    const repository = {
      url,
      checkout: { kind: "new" as const, branch: "feature" },
    };
    const cache = path.join(
      state,
      "repositories",
      createHash("sha256").update(url).digest("hex")
    );
    const author = path.join(state, "sessions", agentId);
    const checkout = path.join(author, "checkout");
    const workload = vi.fn(async (bin, args) =>
      execFileSync(bin, args, { encoding: "utf8" })
    );
    const running = await start(workload);
    git("init", "--quiet", "--bare", cache);
    const seed = path.join(await realpath(root), "seed");
    git("init", "--quiet", seed);
    git(
      "-C",
      seed,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "seed"
    );
    git("-C", seed, "push", "--quiet", cache, "HEAD:refs/heads/feature");
    await mkdir(author);
    git(
      `--git-dir=${cache}`,
      "worktree",
      "add",
      "--quiet",
      checkout,
      "feature"
    );
    await writeFile(path.join(state, "bindings", agentId), "\0managed");
    await writeFile(
      path.join(state, "bindings", agentId + ".repository"),
      JSON.stringify(repository)
    );
    await writeFile(path.join(checkout, "uncommitted.txt"), "pending change");

    processes.spawn.mockResolvedValueOnce();
    await startHost(running, sharedLaunch());
    expect(hostCwd(processes.spawn.mock.calls[0]!)).toBe(checkout);
    expect(await running.checkoutDirectory(reviewerId)).toBe(checkout);
    expect((await stat(author)).mode & 0o777).toBe(0o751);
    expect(workload).not.toHaveBeenCalled();
    const legacyHead = git("-C", checkout, "rev-parse", "HEAD").trim();
    git(`--git-dir=${cache}`, "update-ref", "refs/heads/main", legacyHead);
    expect(await running.observeWorkspace(agentId)).toMatchObject({
      ownership: "owned",
      borrowers: [reviewerId],
      checkout: { unmerged: false, uncommittedFiles: ["?? uncommitted.txt"] },
    });
    await expect(running.discard(agentId)).rejects.toThrow("still in use");
    await running.discard(reviewerId);
    expect(await readFile(path.join(checkout, "uncommitted.txt"), "utf8")).toBe(
      "pending change"
    );

    workload.mockRejectedValueOnce(new Error("Git cleanup interrupted"));
    await expect(running.discard(agentId)).rejects.toThrow(
      "Git cleanup interrupted"
    );
    running.close();
    const recovered = await start(workload);
    await recovered.discard(agentId);
    expect(
      git(`--git-dir=${cache}`, "worktree", "list", "--porcelain")
    ).not.toContain(checkout);
    await expect(stat(author)).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("launch acknowledgements", () => {
    const LAUNCH = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";
    const OTHER_LAUNCH = "7a1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";
    const withId = (launchId?: string) => {
      const command = launch();
      return {
        ...command,
        launch: {
          ...command.launch,
          ...(launchId !== undefined && { launchId }),
        },
      };
    };
    const launchRecord = () =>
      readFile(path.join(state, "bindings", agentId + ".launch"), "utf8").then(
        (raw) => JSON.parse(raw),
        () => null
      );
    const hostOptions = async () =>
      JSON.parse(
        await readFile(
          path.join(state, "hosts", agentId, "launch.json"),
          "utf8"
        )
      );
    const sessionDirs = async () =>
      (
        await import("node:fs/promises").then(({ readdir }) =>
          readdir(path.join(state, "sessions"))
        )
      ).filter((entry) => !entry.startsWith("."));

    it("saves the launch ID and the spawning host before the host starts", async () => {
      const runner = await start();
      processes.spawn.mockImplementationOnce(
        async (_command, _cwd, _env, _log, save) => {
          const saved = await launchRecord();
          expect(saved).toEqual({
            launchId: LAUNCH,
            stage: "spawning",
            hostInstanceId: (await hostOptions()).hostInstanceId,
          });
          expect((await stat(record).catch(() => null)) === null).toBe(true);
          await save(identity);
          kernelHost = identity;
        }
      );
      await startHost(runner, withId(LAUNCH));
      expect(processes.spawn).toHaveBeenCalledTimes(1);
      // The ID never reaches the host's own launch file.
      expect(await hostOptions()).not.toHaveProperty("launchId");
      const mode =
        (await stat(path.join(state, "bindings", agentId + ".launch"))).mode &
        0o777;
      expect(mode).toBe(0o600);
    });

    it.each(["agt_fixture", "opaque/session"])(
      "lists the identity stored for current session %s",
      async (id) => {
        const runner = await start();
        const key = runnerStorageKey(id);
        const binding = path.join(state, "bindings", key);
        await writeFile(binding, "\0managed");
        await writeFile(
          binding + ".host",
          JSON.stringify({ ...currentIdentity, sessionId: id })
        );
        expect(
          (await runner.listSessions()).sessions.map((row) => row.session)
        ).toEqual([id]);
      }
    );

    it("omits a tracked host without a session ID even when its directory resembles an agent ID", async () => {
      const runner = await start();
      const binding = path.join(state, "bindings", agentId);
      await writeFile(binding, "\0managed");
      await writeFile(binding + ".host", JSON.stringify(identity));
      expect(await runner.listSessions()).toEqual({
        sessions: [],
      });
    });

    it("lists a bound launch and samples nonzero CPU for its busy host", async () => {
      const runner = await start();
      const child = spawn(
        process.execPath,
        ["-e", "console.log('ready'); for (;;) {}"],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      const exited = once(child, "exit");
      try {
        await once(child.stdout!, "data");
        processes.spawn.mockImplementationOnce(
          async (_command, _cwd, _env, _log, save) => {
            const busyHost = { ...identity, pid: child.pid! };
            await save(busyHost);
            kernelHost = busyHost;
          }
        );
        const command = withId(LAUNCH);
        await startHost(runner, {
          ...command,
          launch: { ...command.launch, owner: "controller-a" },
        });
        const session = sessionFromWire(agentId);
        expect(await runner.listSessions("controller-a")).toMatchObject({
          sessions: [
            {
              session,
              state: "live",
              launchId: LAUNCH,
              instanceId: expect.any(String),
              build,
            },
          ],
        });
        expect(await runner.listSessions("another-owner")).toEqual({
          sessions: [],
        });
        expect(await runner.sampleSessions("another-owner", [session])).toEqual(
          { samples: [] }
        );
        await expect
          .poll(
            async () =>
              (await runner.sampleSessions([session])).samples[0]?.cpuPercent
          )
          .toBeGreaterThan(0);
        const { samples } = await runner.sampleSessions([session]);
        expect(samples[0]?.rssBytes).toBeGreaterThan(0);
        expect(await runner.listSessions("controller-b")).toEqual({
          sessions: [],
        });
        expect(await runner.stop(agentId, true, LAUNCH, "controller-b")).toBe(
          false
        );
        expect(processes.stop).not.toHaveBeenCalled();
        await runner.stop(agentId, true, LAUNCH, "controller-a");
        expect(processes.stop).toHaveBeenCalledWith(
          expect.objectContaining({ pid: child.pid }),
          true
        );
        expect((await runner.listSessions()).sessions).toEqual([]);
      } finally {
        child.kill();
        await exited;
      }
    });

    it("ignores a stop for an older launch and stops the requested launch once", async () => {
      const runner = await start();
      await startHost(runner, withId(OTHER_LAUNCH));
      expect(await runner.stop(agentId, true, LAUNCH)).toBe(false);
      expect(processes.stop).not.toHaveBeenCalled();
      expect(await runner.stop(agentId, true, OTHER_LAUNCH)).toBeUndefined();
      await runner.stop(agentId, true, OTHER_LAUNCH);
      expect(processes.stop).toHaveBeenCalledTimes(1);
    });

    it("adopts its own host when the same launch waited at the lock queue", async () => {
      const runner = await start();
      const first = startHost(runner, withId(LAUNCH));
      const repeat = startHost(runner, withId(LAUNCH));
      const progress = vi.fn();
      const other = startHost(runner, withId(OTHER_LAUNCH));
      await first;
      await repeat;
      await expect(other).rejects.toThrow("already has a host");
      expect(processes.spawn).toHaveBeenCalledTimes(1);
      expect(await sessionDirs()).toEqual([agentId]);
      expect(await runner.alive(agentId)).toBe(true);
    });

    it("spawns once more when the supervisor stopped before the process gate opened", async () => {
      const first = await start();
      processes.spawn.mockImplementationOnce(
        async (_command, _cwd, _env, _log, save) => {
          await save(identity);
          // The gate never opened: the launcher shell exits on EOF.
          throw new Error("supervisor stopped");
        }
      );
      await expect(startHost(first, withId(LAUNCH))).rejects.toThrow(
        "supervisor stopped"
      );
      first.close();

      const recovered = await start();
      await startHost(recovered, withId(LAUNCH));
      expect(processes.spawn).toHaveBeenCalledTimes(2);
      expect(processes.cleanup).toHaveBeenCalledTimes(1);
      expect(await recovered.alive(agentId)).toBe(true);
      expect(await sessionDirs()).toEqual([agentId]);
      expect(await launchRecord()).toMatchObject({
        launchId: LAUNCH,
        stage: "spawning",
        hostInstanceId: (await hostOptions()).hostInstanceId,
      });
    });

    it.each(["after spawn", "after reply"])(
      "adopts the live host of the same launch %s across a supervisor restart",
      async (boundary) => {
        const first = await start();
        if (boundary === "after spawn")
          processes.spawn.mockImplementationOnce(
            async (_command, _cwd, _env, _log, save) => {
              await save(identity);
              kernelHost = identity;
              throw new Error("receipt lost");
            }
          );
        const sent = startHost(first, withId(LAUNCH));
        if (boundary === "after spawn")
          await expect(sent).rejects.toThrow("receipt lost");
        else await sent;
        const instance = (await hostOptions()).hostInstanceId;
        first.close();

        const recovered = await start();
        await startHost(recovered, withId(LAUNCH));
        expect(processes.spawn).toHaveBeenCalledTimes(1);
        expect(processes.cleanup).not.toHaveBeenCalled();
        expect((await hostOptions()).hostInstanceId).toBe(instance);
        expect(await sessionDirs()).toEqual([agentId]);

        // Another attempt for the same session keeps the existing conflict.
        await expect(
          startHost(recovered, withId(OTHER_LAUNCH))
        ).rejects.toThrow("already has a host");
        // So does a host that is not the one this attempt started.
        await writeFile(
          record,
          JSON.stringify({
            ...currentIdentity,
            hostInstanceId: "11111111-2222-4333-8444-555555555555",
          })
        );
        await expect(startHost(recovered, withId(LAUNCH))).rejects.toThrow(
          "already has a host"
        );
        expect(processes.spawn).toHaveBeenCalledTimes(1);
      }
    );

    it("does not adopt a legacy host record for the same launch", async () => {
      const runner = await start();
      await startHost(runner, withId(LAUNCH));
      await writeFile(record, JSON.stringify(identity));
      await expect(startHost(runner, withId(LAUNCH))).rejects.toThrow(
        "already has a host"
      );
    });

    it.each([
      ["not JSON", "{"],
      ["an unknown stage", { stage: "spawned" }],
      ["a malformed host instance", { hostInstanceId: 5 }],
    ])("treats a launch record with %s as a new launch", async (_, change) => {
      const runner = await start();
      await startHost(runner, withId(LAUNCH));
      kernelHost = undefined;
      // Otherwise an install of unknown result: this attempt would refuse.
      const recorded = {
        launchId: LAUNCH,
        stage: "preparing",
        dependencies: "started",
      };
      await writeFile(
        path.join(state, "bindings", agentId + ".launch"),
        typeof change === "string"
          ? change
          : JSON.stringify({ ...recorded, ...change })
      );
      await startHost(runner, withId(LAUNCH));
      expect(processes.spawn).toHaveBeenCalledTimes(2);
    });

    it("refuses only an install whose result is not on disk", async () => {
      const runner = await start();
      await startHost(runner, withId(LAUNCH));
      kernelHost = undefined;
      await writeFile(
        path.join(state, "bindings", agentId + ".launch"),
        JSON.stringify({
          launchId: LAUNCH,
          stage: "preparing",
          dependencies: "started",
        })
      );
      await expect(startHost(runner, withId(LAUNCH))).rejects.toThrow(
        "their result is unknown"
      );
      // The install finished just before the record could say so.
      await writeFile(
        path.join(state, "bindings", agentId + ".dependencies"),
        "done"
      );
      await startHost(runner, withId(LAUNCH));
      expect(processes.spawn).toHaveBeenCalledTimes(2);
    });

    it("discards the launch record with the session", async () => {
      const runner = await start();
      await startHost(runner, withId(LAUNCH));
      await runner.stop(agentId, true);
      await runner.discard(agentId);
      expect(await launchRecord()).toBeNull();
    });
  });
});
