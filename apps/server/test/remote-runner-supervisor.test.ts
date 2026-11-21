import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  chmod,
  link,
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
import { buildHostEnv } from "../src/agents/acp/host-env.js";
import type { HostLaunch } from "../src/agents/acp/host-protocol.js";
import { issueAuthority, issueServer } from "../src/agents/remote/x509.js";
import { createAgentMcpToken, validateAgentMcpToken } from "../src/auth.js";
import { registerMcpRoutes } from "../src/routes/mcp.js";
import { assertAccessCeiling } from "../src/shared/access-ceiling.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MANAGED_WORKSPACE,
  MAX_SESSION_FILE_BYTES,
} from "../src/agents/remote/protocol.js";
import {
  classifySessionIdentity,
  parseProcessStat,
  parseSessionIdentity,
  runnerStateLockError,
  type SessionIdentity,
  type SessionProcesses,
} from "../src/agents/remote/session-processes.js";
import { readSessionFile } from "../src/files/session-file.js";
import { createSessionSupervisor } from "../src/agents/remote/session-supervisor.js";

import {
  observeGitCheckout,
  observeScratchCheckout,
} from "../src/agents/checkout-inspection.js";

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
const launch = (workspace: string) =>
  ({
    kind: "launch",
    agentId,
    workspace,
    launch: { engine: "codex" },
  }) as const;
const sharedLaunch = (
  useWorktreeOf: string = agentId,
  workspace = MANAGED_WORKSPACE
) => ({
  ...launch(workspace),
  agentId: reviewerId,
  launch: { ...launch(workspace).launch, useWorktreeOf },
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
      new URL("../src/agents/remote/session-processes.ts", import.meta.url)
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
    socketInUse: vi.fn(() => false),
    socketMatchesHost: vi.fn(() => true),
    spawn: vi.fn<SessionProcesses["spawn"]>(),
  } satisfies SessionProcesses;

  async function start(
    workspaces: string[],
    asWorkload: Parameters<
      typeof createSessionSupervisor
    >[0]["asWorkload"] = vi.fn(),
    prepareDependencies?: (cwd: string) => Promise<boolean>,
    workload?: Pick<
      Parameters<typeof createSessionSupervisor>[0],
      "env" | "bins" | "hostCommand"
    >
  ) {
    supervisor = await createSessionSupervisor(
      {
        state,
        build,
        uid: process.getuid!(),
        gid: process.getgid!(),
        ca: path.join(state, "runner-ca.pem"),
        bins: { claudeBin: "", codexBin: "" },
        env: {},
        workspaces: new Set(workspaces),
        hostCommand: (dir) => ["/test-host", "--state", dir],
        asWorkload,
        observeCheckout: (dir, scratch) =>
          scratch ? observeScratchCheckout(dir) : observeGitCheckout(dir),
        prepareDependencies,
        ...workload,
      },
      processes
    );
    return supervisor;
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
    supervisor?.close();
    supervisor = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("recovers the golden legacy binding but defers live handoff", async () => {
    const runner = await start([]);
    await runner.launch(launch(MANAGED_WORKSPACE), root);
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
    const recovered = await start([]);
    expect(await recovered.alive(agentId, MANAGED_WORKSPACE)).toBe(true);
    expect(
      await recovered.inspectHandoff({ reads: [1, 2], writes: 2 })
    ).toEqual({
      retained: [],
      requiresQuiescence: true,
    });
    expect(processes.socketMatchesHost).not.toHaveBeenCalled();
  });

  it("recovers the golden current tree and fails closed on stale or spoofed identity", async () => {
    const runner = await start([]);
    await runner.launch(launch(MANAGED_WORKSPACE), root);
    await writeFile(record, JSON.stringify(currentIdentity));
    runner.close();
    const recovered = await start([]);
    const socketPath = path.join(state, "hosts", agentId, "host.sock");
    const socket = createServer();
    socket.listen(socketPath);
    await once(socket, "listening");
    const inspect = () => recovered.inspectHandoff({ reads: [2], writes: 2 });
    try {
      expect(await inspect()).toEqual({
        retained: [{ sessionId: agentId, instanceId, build }],
        requiresQuiescence: false,
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
      });

      await writeFile(
        record,
        JSON.stringify({ ...currentIdentity, handoffFormat: 91 })
      );
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
      });

      await writeFile(
        record,
        JSON.stringify({ ...currentIdentity, start: "501" })
      );
      processes.socketInUse.mockReturnValue(true);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
      });
      processes.socketInUse.mockReturnValue(false);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: false,
      });

      await writeFile(record, JSON.stringify(currentIdentity));
      processes.socketMatchesHost.mockReturnValue(false);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
      });

      processes.socketMatchesHost.mockReturnValue(true);
      await chmod(record, 0o666);
      expect(await inspect()).toEqual({
        retained: [],
        requiresQuiescence: true,
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

    await start([]);

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

  it("prepares managed scratch and reports request-scoped progress before starting the host", async () => {
    const runner = await start([]);
    const progress = vi.fn();
    const command = launch(MANAGED_WORKSPACE);
    await runner.launch(
      {
        ...command,
        launch: { ...command.launch, prepareWorkspace: true },
      },
      undefined,
      progress
    );
    const cwd = path.join(state, "sessions", agentId);
    expect(await runner.checkoutDirectory(agentId, MANAGED_WORKSPACE)).toBe(
      cwd
    );
    expect((await stat(cwd)).isDirectory()).toBe(true);
    expect(progress.mock.calls).toEqual([
      [{ phase: "workspace" }],
      [{ phase: "ready" }],
    ]);
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
      expect(processes.stop).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(identity),
        true
      );
      expect(processes.cleanup).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(identity)
      );
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
    expect(processes.stop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(identity),
      false
    );
  });

  it("bounds collection and rejects symlinks and hard links on disk", async () => {
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

  it("collects only from the bound session, including when the configured checkout contains runner state", async () => {
    const runner = await start(["configured"]);
    const cwd = await realpath(root);
    const transfer = vi.fn(async () => "YWJj");
    const first = launch("configured");
    await runner.launch(first, cwd);
    kernelHost = undefined;
    const other = "agt_other";
    record = path.join(state, "bindings", other + ".host");
    await runner.launch({ ...first, agentId: other }, cwd);
    const own = path.join(state, "hosts", agentId, "files", "input.txt");
    const foreign = path.join(state, "hosts", other, "files", "input.txt");
    const collect = (id: string, file: string, workspace = first.workspace) =>
      runner.sessionFile(
        id,
        workspace,
        { kind: "collect", path: file },
        transfer,
        cwd
      );
    expect(await collect(agentId, own)).toBe("YWJj");
    expect(await collect(agentId, "generated/report.txt")).toBe("YWJj");
    expect(transfer).toHaveBeenNthCalledWith(
      1,
      "collect",
      path.dirname(own),
      "input.txt"
    );
    expect(transfer).toHaveBeenNthCalledWith(
      2,
      "collect",
      cwd,
      "generated/report.txt"
    );
    for (const [id, file] of [
      [agentId, foreign],
      [other, own],
      [agentId, "../input.txt"],
      ["unbound/session", own],
    ] as const)
      await expect(collect(id, file)).rejects.toThrow();
    expect(transfer).toHaveBeenCalledTimes(2);
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

  it.each([
    {
      config: ["configured", "other"],
      workspace: "configured",
      binding: "configured",
    },
    { config: [], workspace: "@session", binding: "\0managed" },
  ])(
    "reuses an idle legacy $workspace binding",
    async ({ config, workspace, binding }) => {
      const running = await start(config);
      const bindings = path.join(state, "bindings");
      await writeFile(path.join(bindings, agentId), binding, { mode: 0o600 });
      if (config.length === 0) {
        await writeFile(path.join(bindings, agentId + ".owner"), marker, {
          mode: 0o600,
        });
        await writeFile(path.join(bindings, agentId + ".repository"), "null", {
          mode: 0o600,
        });
      }
      expect(await running.alive(agentId, workspace)).toBe(false);
      await running.launch(launch(workspace), root);
      expect(await running.alive(agentId, workspace)).toBe(true);
      expect(processes.cleanupLegacy.mock.calls).toEqual(
        config.length ? [] : [[marker]]
      );
    }
  );

  it("reads a bounded UTF-8 tail from a large guest log", async () => {
    const running = await start(["configured"]);
    await running.launch(launch("configured"), root);
    const log = await open(path.join(state, "bindings", "logs", agentId), "r+");
    const expected = "x".repeat(2044) + "✓";
    try {
      // A sparse offset beyond Node's whole-file read limit leaves the actual
      // disk usage small. The 2 KiB tail starts within the preceding emoji.
      await log.write("🚀" + expected, 2 ** 31, "utf8");
    } finally {
      await log.close();
    }
    expect(await running.log(agentId, "configured")).toBe(
      "Guest agent host log.\n" + expected
    );
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
    const running = await start([], undefined, undefined, workload);
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
      providerPlans: async () => ({}),
      getBearerToken: (request) =>
        /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null,
      validateAgentMcpToken,
      agentManager: {
        getAgent: async (id: string) => ({
          id,
          cwd: "runner://fixture/proof",
          parentAgentId: agentId,
          fullAccess: false,
        }),
        permitsRemoteAgentMcp: () => active,
        remoteRepoOperation: () => undefined,
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
      await running.launch(launch(MANAGED_WORKSPACE), undefined);
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
      await running.launch(
        {
          ...child,
          launch: { ...child.launch, mcp, fullAccess: false },
        },
        undefined
      );
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
            const log = await running.log(reviewerId, MANAGED_WORKSPACE);
            throw new Error(log.replaceAll(token, "[fixture bearer]"), {
              cause: error,
            });
          });
      } else {
        const env = buildHostEnv(payload, dir, {
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
        false
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
    const running = await start([]);
    const author = path.join(state, "sessions", agentId);
    const reviewerHost = path.join(state, "hosts", reviewerId);
    await running.launch(launch(MANAGED_WORKSPACE), undefined);
    await writeFile(path.join(author, "uncommitted.txt"), "author's work");
    const reviewerIdentity = { ...identity, pid: 101 };
    processes.spawn.mockImplementationOnce(
      async (command, cwd, _env, _log, save) => {
        expect(command.at(-1)).toBe(reviewerHost);
        expect(cwd).toBe(author);
        expect(await readFile(path.join(cwd, "uncommitted.txt"), "utf8")).toBe(
          "author's work"
        );
        await save(reviewerIdentity);
        kernelReviewer = reviewerIdentity;
      }
    );
    await running.launch(sharedLaunch(), undefined);
    expect(await running.alive(reviewerId, MANAGED_WORKSPACE)).toBe(true);
    expect(await running.checkoutDirectory(reviewerId, MANAGED_WORKSPACE)).toBe(
      author
    );
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
    await expect(
      running.discard(reviewerId, MANAGED_WORKSPACE)
    ).rejects.toThrow("Stop the guest host");
    await running.stop(reviewerId, MANAGED_WORKSPACE, true);
    await running.discard(reviewerId, MANAGED_WORKSPACE);
    expect(await running.alive(agentId, MANAGED_WORKSPACE)).toBe(true);
    expect(await readFile(path.join(author, "uncommitted.txt"), "utf8")).toBe(
      "author's work"
    );
  });

  it("retains the author checkout until all borrower state is discarded across restarts", async () => {
    const workspace = MANAGED_WORKSPACE;
    const running = await start([]);
    await running.launch(launch(workspace), undefined);
    await running.stop(agentId, workspace, true);
    // Even a failed spawn has reserved the binding. Only a successful
    // discard confirms that any partially started host is gone.
    processes.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(running.launch(sharedLaunch(), undefined)).rejects.toThrow(
      "spawn failed"
    );
    await expect(running.discard(agentId, workspace)).rejects.toThrow(
      "still in use"
    );
    running.close();

    const recovered = await start([]);
    const author = path.join(state, "sessions", agentId);
    expect(await recovered.checkoutDirectory(reviewerId, workspace)).toBe(
      author
    );
    await expect(
      recovered.checkoutDirectory(agentId, workspace)
    ).rejects.toThrow("archived");
    await expect(
      recovered.launch({ ...sharedLaunch(), agentId: "agt_new" }, undefined)
    ).rejects.toThrow("archived");
    await expect(
      recovered.launch({ ...launch(workspace), agentId: reviewerId }, undefined)
    ).rejects.toThrow("not bound");
    await expect(recovered.discard(agentId, workspace)).rejects.toThrow(
      "still in use"
    );
    await recovered.discard(reviewerId, workspace);
    await expect(stat(author)).resolves.toBeDefined();
    await recovered.discard(agentId, workspace);
    await recovered.discard(agentId, workspace);
    await expect(stat(author)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["owner-first", "borrower-first", "changed-after-observation"])(
    "conditionally releases a scratch checkout: %s",
    async (order) => {
      const workspace = MANAGED_WORKSPACE;
      const running = await start([]);
      await running.launch(launch(workspace), undefined);
      processes.spawn.mockResolvedValueOnce();
      await running.launch(sharedLaunch(), undefined);
      await running.stop(agentId, workspace, true);
      const observation = await running.checkoutRelease(agentId, workspace, {
        kind: "observe",
      });
      expect(observation).toMatchObject({
        ownership: "owned",
        owner: agentId,
        borrowers: [reviewerId],
      });
      expect(
        await running.checkoutRelease(reviewerId, workspace, {
          kind: "observe",
        })
      ).toMatchObject({ ownership: "borrowed", owner: agentId });
      if (typeof observation === "string" || !observation.checkout)
        throw new Error("Missing fixture checkout observation");
      const ownerRelease = {
        kind: "release",
        expectedState: observation.checkout.stateId,
      } as const;
      const borrowerRelease = { kind: "release", expectedState: null } as const;
      if (order !== "borrower-first") {
        expect(
          await running.checkoutRelease(agentId, workspace, ownerRelease)
        ).toBe("inUse");
        expect(await stat(observation.checkout.path)).toBeDefined();
      }
      expect(
        await running.checkoutRelease(reviewerId, workspace, borrowerRelease)
      ).toBe("released");
      if (order === "changed-after-observation")
        await writeFile(
          path.join(observation.checkout.path, "new.txt"),
          "work"
        );
      running.close();
      const recovered = await start([]);
      const expected =
        order === "changed-after-observation" ? "retained" : "released";
      expect(
        await recovered.checkoutRelease(agentId, workspace, ownerRelease)
      ).toBe(expected);
      expect(
        await recovered.checkoutRelease(agentId, workspace, ownerRelease)
      ).toBe(expected);
      if (expected === "retained") {
        await expect(recovered.discard(agentId, workspace)).rejects.toThrow(
          "retained"
        );
        expect(
          await readFile(
            path.join(observation.checkout.path, "new.txt"),
            "utf8"
          )
        ).toBe("work");
      } else {
        await expect(stat(observation.checkout.path)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  );

  it("holds the owner checkout through a concurrent borrower launch", async () => {
    const workspace = MANAGED_WORKSPACE;
    const running = await start([]);
    await running.launch(launch(workspace), undefined);
    await running.stop(agentId, workspace, true);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    processes.spawn.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
    });
    const started = running.launch(sharedLaunch(), undefined);
    await entered.promise;
    const discarding = running.discard(agentId, workspace);
    finish.resolve();
    await started;
    await expect(discarding).rejects.toThrow("still in use");
  });

  it("rejects invalid, unbound and indirect self references", async () => {
    const running = await start([]);
    await expect(
      running.launch(sharedLaunch(reviewerId), undefined)
    ).rejects.toThrow("Invalid author");
    await expect(
      running.launch(sharedLaunch("bad\0id"), undefined)
    ).rejects.toThrow("Invalid author");
    await expect(running.launch(sharedLaunch(), undefined)).rejects.toThrow(
      "does not own"
    );
    await running.launch(launch(MANAGED_WORKSPACE), undefined);
    processes.spawn.mockResolvedValueOnce();
    await running.launch(sharedLaunch(), undefined);
    await expect(
      running.launch({ ...sharedLaunch(reviewerId), agentId }, undefined)
    ).rejects.toThrow("Invalid author");
    expect(processes.spawn).toHaveBeenCalledTimes(2);
  });

  it("binds a nested managed reviewer directly to the durable checkout owner", async () => {
    const workspace = MANAGED_WORKSPACE;
    const nested = "agt_nested";
    const running = await start([]);
    await running.launch(launch(workspace), undefined);
    await running.stop(agentId, workspace, true);
    processes.spawn.mockResolvedValueOnce();
    await running.launch(sharedLaunch(), undefined);
    running.close();

    const recovered = await start([]);
    processes.spawn.mockResolvedValueOnce();
    await recovered.launch(
      { ...sharedLaunch(reviewerId), agentId: nested },
      undefined
    );
    await recovered.discard(reviewerId, workspace);
    const author = path.join(state, "sessions", agentId);
    expect(await recovered.checkoutDirectory(nested, workspace)).toBe(author);
    await expect(recovered.discard(agentId, workspace)).rejects.toThrow(
      "still in use"
    );
    await recovered.discard(nested, workspace);
    await recovered.discard(agentId, workspace);
    await expect(stat(author)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists moved and borrowed checkouts independently across restarts", async () => {
    const workspace = MANAGED_WORKSPACE;
    const nested = "agt_nested";
    const independent = "agt_independent";
    const asWorkload = async (bin: string, args: string[]) =>
      bin === "realpath"
        ? (await realpath(args.at(-1)!)) + "\n"
        : execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    const runner = await start([], asWorkload);
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
    await runner.launch(launch(workspace), undefined);
    const select = (path: string) =>
      runner.sessionCheckout(agentId, workspace, { kind: "select", path });
    const owningDir = path.join(state, "sessions", agentId);
    const owningSubdir = path.join(owningDir, "subdirectory");
    await mkdir(owningSubdir);
    await expect(select(owningSubdir)).resolves.toMatchObject({
      path: owningSubdir,
    });

    const ancestor = path.dirname(state);
    const alias = path.join(owningDir, "ancestor-link");
    await symlink(ancestor, alias);
    for (const forbidden of [
      "/",
      ancestor,
      alias,
      state,
      path.join(state, "sessions"),
    ])
      await expect(select(forbidden)).rejects.toThrow(
        "outside the bound runner checkout"
      );

    // A harmless-looking sibling of the storage can resolve to a Git root
    // that contains it. Confirm authorization is repeated on that root.
    const sibling = path.join(ancestor, "sibling");
    await mkdir(sibling);
    await asWorkload("git", ["-C", ancestor, "init"]);
    await expect(select(sibling)).rejects.toThrow(
      "outside the bound runner checkout"
    );
    await expect(runner.checkoutDirectory(agentId, workspace)).resolves.toBe(
      owningSubdir
    );

    await expect(
      runner.sessionCheckout(agentId, workspace, {
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
    await runner.launch(sharedLaunch(), undefined);
    processes.spawn.mockResolvedValueOnce();
    await runner.launch(
      { ...sharedLaunch(reviewerId), agentId: nested },
      undefined
    );
    processes.spawn.mockResolvedValueOnce();
    await runner.launch(
      { ...launch(workspace), agentId: independent },
      undefined
    );
    const independentDir = await runner.checkoutDirectory(
      independent,
      workspace
    );
    await expect(
      runner.sessionCheckout(agentId, workspace, {
        kind: "select",
        path: independentDir,
      })
    ).rejects.toThrow("outside the bound runner checkout");

    await runner.stop(agentId, workspace, false);
    runner.close();
    const recovered = await start([], asWorkload);
    await recovered.launch(launch(workspace), undefined);
    expect(processes.spawn.mock.calls.at(-1)?.[1]).toBe(checkout);
    await expect(
      recovered.checkoutDirectory(independent, workspace)
    ).resolves.toBe(independentDir);
    await recovered.sessionCheckout(agentId, workspace, {
      kind: "select",
      path: null,
    });
    expect(await recovered.checkoutDirectory(agentId, workspace)).not.toBe(
      checkout
    );
    for (const borrower of [reviewerId, nested])
      await expect(
        recovered.checkoutDirectory(borrower, workspace)
      ).resolves.toBe(checkout);
    processes.spawn.mockResolvedValueOnce();
    await recovered.launch(
      { ...sharedLaunch(reviewerId), agentId: nested },
      undefined
    );
    expect(processes.spawn.mock.calls.at(-1)?.[1]).toBe(checkout);
  });

  it("lets a managed session select another session's checkout like local", async () => {
    const workspace = MANAGED_WORKSPACE;
    const asWorkload = async (bin: string, args: string[]) =>
      bin === "realpath"
        ? (await realpath(args.at(-1)!)) + "\n"
        : execFileSync(bin, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    const runner = await start([], asWorkload);
    await runner.launch(launch(workspace), undefined);
    const select = (path: string) =>
      runner.sessionCheckout(agentId, workspace, { kind: "select", path });
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
    for (const forbidden of [
      parent,
      privateDir,
      path.join(checkout, "escape"),
      loose,
      badKey,
      path.join(state, "bindings"),
      sessions,
      state,
    ])
      await expect(select(forbidden)).rejects.toThrow(
        "outside the bound runner checkout"
      );
    await expect(runner.checkoutDirectory(agentId, workspace)).resolves.toBe(
      nested
    );
  });

  it("shares a configured workspace with separate host state and no folder cleanup", async () => {
    const running = await start(["configured", "other"]);
    await running.launch(launch("configured"), root);
    const configured = await realpath(root);
    const file = path.join(configured, "work.txt");
    await writeFile(file, "configured work");
    processes.spawn.mockResolvedValueOnce();
    await running.launch(sharedLaunch(agentId, "configured"), root);
    expect(processes.spawn.mock.calls.at(-1)?.[0].at(-1)).toBe(
      path.join(state, "hosts", reviewerId)
    );
    expect(processes.spawn.mock.calls.at(-1)?.[1]).toBe(configured);
    expect(await running.checkoutDirectory(reviewerId, "configured")).toBe(
      configured
    );
    await expect(
      running.launch(sharedLaunch(agentId, "other"), root)
    ).rejects.toThrow("not bound");
    const alternate = path.join(configured, "alternate");
    await mkdir(alternate);
    const redirected = path.join(configured, "redirected");
    await symlink(alternate, redirected);
    await expect(
      running.launch(sharedLaunch(agentId, "configured"), redirected)
    ).rejects.toThrow("different configured directory");
    await running.stop(agentId, "configured", true);
    await running.discard(agentId, "configured");
    expect(await running.checkoutDirectory(reviewerId, "configured")).toBe(
      configured
    );
    await running.discard(reviewerId, "configured");
    expect(await readFile(file, "utf8")).toBe("configured work");
  });

  it("recovers a pre-upgrade configured author's cwd from trusted configuration", async () => {
    const workspace = "configured";
    const running = await start([workspace]);
    await writeFile(path.join(state, "bindings", agentId), workspace);
    await expect(running.checkoutDirectory(agentId, workspace)).rejects.toThrow(
      "unavailable"
    );
    const configured = await realpath(root);
    processes.spawn.mockResolvedValueOnce();
    await running.launch(sharedLaunch(agentId, workspace), root);
    expect(await running.checkoutDirectory(agentId, workspace)).toBe(
      configured
    );
    expect(await running.checkoutDirectory(reviewerId, workspace)).toBe(
      configured
    );

    const legacyInspectId = "agt_legacyinspect";
    await writeFile(path.join(state, "bindings", legacyInspectId), workspace);
    expect(
      await running.checkoutDirectory(legacyInspectId, workspace, root)
    ).toBe(configured);
  });

  it("rejects symlink redirection of a legacy repository checkout", async () => {
    const running = await start([]);
    const workspace = MANAGED_WORKSPACE;
    const author = path.join(state, "sessions", agentId);
    await mkdir(author);
    await symlink(root, path.join(author, "checkout"));
    await writeFile(path.join(state, "bindings", agentId), "\0managed");
    await writeFile(
      path.join(state, "bindings", agentId + ".repository"),
      "{}"
    );
    await expect(running.launch(sharedLaunch(), undefined)).rejects.toThrow(
      "checkout is unavailable"
    );
    await expect(running.checkoutDirectory(agentId, workspace)).rejects.toThrow(
      "checkout is unavailable"
    );
    expect(await running.isBound(reviewerId, workspace)).toBe(false);
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  it("borrows a pre-migration Git worktree and retries owner cleanup", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8" });
    const workspace = MANAGED_WORKSPACE;
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
    const running = await start([], workload);
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
    await running.launch(sharedLaunch(), undefined);
    expect(processes.spawn.mock.calls[0]?.[1]).toBe(checkout);
    expect(await running.checkoutDirectory(reviewerId, workspace)).toBe(
      checkout
    );
    expect((await stat(author)).mode & 0o777).toBe(0o751);
    expect(workload).not.toHaveBeenCalled();
    const legacyHead = git("-C", checkout, "rev-parse", "HEAD").trim();
    git(`--git-dir=${cache}`, "update-ref", "refs/heads/main", legacyHead);
    expect(
      await running.checkoutRelease(agentId, workspace, { kind: "observe" })
    ).toMatchObject({
      ownership: "owned",
      borrowers: [reviewerId],
      checkout: { unmerged: false, uncommittedFiles: ["uncommitted.txt"] },
    });
    await expect(running.discard(agentId, workspace)).rejects.toThrow(
      "still in use"
    );
    await running.discard(reviewerId, workspace);
    expect(await readFile(path.join(checkout, "uncommitted.txt"), "utf8")).toBe(
      "pending change"
    );

    workload.mockRejectedValueOnce(new Error("Git cleanup interrupted"));
    await expect(running.discard(agentId, workspace)).rejects.toThrow(
      "Git cleanup interrupted"
    );
    running.close();
    const recovered = await start([], workload);
    await recovered.discard(agentId, workspace);
    expect(
      git(`--git-dir=${cache}`, "worktree", "list", "--porcelain")
    ).not.toContain(checkout);
    await expect(stat(author)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records review bases and retries dependency preparation in the same checkout", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8" });
    const workspace = MANAGED_WORKSPACE;
    const url = "https://github.com/fixture/project.git";
    const seed = path.join(await realpath(root), "seed");
    git("init", "--quiet", "--initial-branch=trunk", seed);
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
    git("-C", seed, "branch", "release");
    const prepareDependencies = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const running = await start(
      [],
      async (bin, args) =>
        execFileSync(
          bin,
          args.some((arg) => arg === "ls-remote" || arg === "fetch")
            ? args.map((arg) => (arg === url ? seed : arg))
            : args,
          { encoding: "utf8" }
        ),
      prepareDependencies
    );

    for (const [branch, base] of [
      ["explicit-base", "release"],
      ["default-base", undefined],
    ] as const) {
      const id = `review-${branch}`;
      const command = {
        ...launch(workspace),
        agentId: id,
        launch: {
          ...launch(workspace).launch,
          prepareWorkspace: true as const,
          repository: { url, checkout: { kind: "new" as const, branch, base } },
        },
      };
      const startCheckout = async () => {
        processes.spawn.mockResolvedValueOnce();
        const progress = vi.fn();
        await running.launch(command, undefined, progress);
        return progress.mock.calls.map(([step]) => step);
      };
      const steps = await startCheckout();
      const cwd = await running.checkoutDirectory(id, workspace);
      expect((await stat(path.dirname(cwd))).mode & 0o777).toBe(0o751);
      expect(prepareDependencies).toHaveBeenLastCalledWith(cwd);
      if (base) {
        expect(steps).toContainEqual({
          phase: "dependencies",
          status: "failed",
        });
        expect(await startCheckout()).toContainEqual({
          phase: "dependencies",
          status: "done",
        });
        expect(await running.checkoutDirectory(id, workspace)).toBe(cwd);
        expect(await startCheckout()).toEqual([
          { phase: "workspace" },
          { phase: "ready" },
        ]);
        expect(prepareDependencies).toHaveBeenCalledTimes(2);
      }
      const config = git(
        "-C",
        cwd,
        "config",
        "--get-regexp",
        `^branch\\.${branch}\\.`
      );
      expect(config.trim()).toBe(
        `branch.${branch}.dispatchreviewbase ${base ?? "trunk"}`
      );
    }
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
