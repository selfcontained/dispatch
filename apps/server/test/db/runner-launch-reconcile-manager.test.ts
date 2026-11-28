import {
  enrolledTarget,
  seedEnrolledProject,
  managerEnrolledRunner,
} from "../helpers/manager-enrolled-runner.js";
import { withTestWorkspaceRunner } from "../helpers/test-workspace-runner.js";
/**
 * Launch acknowledgements across a runner update: each attempt carries one
 * launch ID wherever it is held, refused or driven again; a launch released
 * before a controller restart is driven again with that ID; and a launch for
 * a held runner that is momentarily offline is admitted from what the runner
 * last advertised, then checked against the reconnected runner on release.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import {
  RunnerCallError,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { RemoteRunnerService } from "../../src/agents/remote/service.js";
import type { AgentRuntime, RuntimeLaunch } from "../../src/agents/runtime.js";
import { trackHoldWork } from "../helpers/hold-work.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

vi.mock(
  "../../../../packages/runner/src/workload/shared/lib/run-command.js",
  () => import("../../src/shared/lib/run-command.js")
);
vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));
// Local agents create a worktree; keep git off the host.
vi.mock(
  "../../../../packages/runner/src/workload/shared/git/worktree.js",
  async () => {
    const actual = await vi.importActual<
      typeof import("../../../../packages/runner/src/workload/shared/git/worktree.js")
    >("../../../../packages/runner/src/workload/shared/git/worktree.js");
    return {
      ...actual,
      createGitWorktree: vi.fn(async () => ({
        worktreePath: "/tmp",
        branchName: "main",
      })),
    };
  }
);
vi.mock(
  "../../../../packages/runner/src/workload/agents/workspace-prep.js",
  () => ({
    installWorkspaceDependencies: vi.fn(async () => {}),
  })
);

const { AgentManager: HostAgentManager } =
  await import("../../src/agents/manager.js");
const AgentManager = withTestWorkspaceRunner(HostAgentManager);
const { createInertRuntime } = await import("../../src/agents/runtime.js");
const { RunnerUpdateFenced, RunnerUnavailable } =
  await import("../../src/agents/remote/service.js");
const { RunnerUpdateHolds, fileRunnerHoldStore } =
  await import("../../src/agents/remote/update-hold.js");

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
  silent: () => {},
  level: "silent",
} as unknown as import("fastify").FastifyBaseLogger;

const testConfig = (root: string) =>
  ({
    host: "127.0.0.1",
    port: 6767,
    databaseUrl: "",
    authToken: "test-token",
    filesRoot: path.join(root, "files"),
    dispatchBinDir: path.join(root, "bin"),
    codexBin: "/bin/echo",
    claudeBin: "/bin/echo",
    opencodeBin: "/bin/opencode",
    agentStateRoot: path.join(root, "agents"),
    agentRuntime: "acp",
    tls: null,
  }) satisfies import("../../src/config.js").AppConfig;

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const HELD = enrolledTarget("r1");
const OTHER = enrolledTarget("r2");

let pool: Pool;
let dir: string;
let holdsFile: string;
let opened: InstanceType<typeof RunnerUpdateHolds>[] = [];
let work = new Map<
  InstanceType<typeof RunnerUpdateHolds>,
  ReturnType<typeof trackHoldWork>
>();

function spyRuntime() {
  let sessions = 0;
  return {
    ...createInertRuntime(),
    tracksProcesses: () => true,
    launch: vi.fn(async (input: RuntimeLaunch) => ({
      sessionId: input.resumeSessionId ?? `sess_${++sessions}`,
      resumed: input.resumeSessionId !== null,
    })),
    attach: vi.fn(async () => false),
    isAlive: vi.fn(async () => false),
    prompt: vi.fn(() => ({
      accepted: Promise.resolve(),
      settled: Promise.resolve(),
    })),
    stop: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    readLogTail: vi.fn(async () => ""),
    listHosted: vi.fn(async () => []),
    onEvent: () => () => {},
  } satisfies AgentRuntime;
}
type Spy = ReturnType<typeof spyRuntime>;

let servedCheckout: string | undefined;
const peer = { online: true, seen: true };
const { remote, call } = managerEnrolledRunner({
  online: () => peer.online,
  seen: () => peer.seen,
  checkout: () => servedCheckout,
});

async function openHolds() {
  const holds = new RunnerUpdateHolds({
    store: fileRunnerHoldStore(holdsFile),
    logger: noopLogger,
  });
  opened.push(holds);
  work.set(holds, trackHoldWork(holds));
  await holds.load();
  return holds;
}

function managerOn(
  holds: InstanceType<typeof RunnerUpdateHolds>,
  runtime: Spy
) {
  return new AgentManager(pool, noopLogger, testConfig(dir), {
    runtime,
    remote,
    holds,
    recoveredLaunchPollMs: 10,
    // Beyond the test, so only a reconnect can end the wait.
    recoveredLaunchWaitMs: 120_000,
  });
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const launchIdsFor = (runtime: Spy, id: string) =>
  launchesFor(runtime, id).map(([input]) => input.launchId);
const heldFile = async () => {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(holdsFile, "utf8"));
};

const launchesFor = (runtime: Spy, id: string) =>
  runtime.launch.mock.calls.filter(([input]) => input.agentId === id);
const promptsFor = (runtime: Spy, id: string) =>
  runtime.prompt.mock.calls
    .filter(([agentId]) => agentId === id)
    .map(([, text]) => text);
const statusOf = async (id: string) =>
  (await pool.query("SELECT status FROM agents WHERE id = $1", [id])).rows[0]
    ?.status;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await seedEnrolledProject(pool);
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  Object.assign(peer, { online: true, seen: true });
  call.mockClear();
  vi.mocked(remote.lastConnectionEpoch).mockClear();
  vi.mocked(remote.available).mockImplementation(() => peer.online);
  await pool.query("DELETE FROM blocks");
  await pool.query("DELETE FROM files");
  await pool.query("DELETE FROM agents");
  dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-hold-manager-"));
  holdsFile = path.join(dir, "holds.json");
});
afterEach(async () => {
  vi.useRealTimers();
  for (const holds of opened.splice(0)) holds.close();
  // A released launch saves its outcome after the agent already reads running.
  for (const tracked of work.values()) await tracked.settled();
  work.clear();
  await rm(dir, { recursive: true, force: true });
});

describe("launch IDs", () => {
  it("sends one ID per runner attempt, keeps it while held, and none for a local agent", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    holds.start();
    await holds.begin("r1", ATTEMPT);
    const held = await manager.createAgent({ ...HELD, initialPrompt: "a" });
    const other = await manager.createAgent({ ...OTHER });
    const local = await manager.createAgent({ cwd: "/tmp" });
    expect(holds.counts("r1").launches).toBe(1);
    const heldId = holds.current("r1")!.launches[0]!.launchId;
    expect(heldId).toMatch(UUID);

    expect(launchIdsFor(runtime, other.id)).toHaveLength(1);
    expect(launchIdsFor(runtime, other.id)[0]).toMatch(UUID);
    expect(launchesFor(runtime, local.id)).toHaveLength(1);
    expect(launchesFor(runtime, local.id)[0]![0]).not.toHaveProperty(
      "launchId"
    );

    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(held.id)).toBe("running");
    expect(launchIdsFor(runtime, held.id)).toEqual([heldId]);
    // Settled: nothing left to drive after a restart.
    expect(await heldFile()).not.toHaveProperty("resuming");

    // A new Start is a new attempt with a new ID.
    await manager.stopAgent(other.id);
    await manager.startAgent(other.id);
    const otherIds = launchIdsFor(runtime, other.id);
    expect(otherIds).toHaveLength(2);
    expect(otherIds[1]).toMatch(UUID);
    expect(otherIds[1]).not.toBe(otherIds[0]);
  });

  it("holds a repeat the fence refused under the same ID and runs it once", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    // The reply was lost; the runtime's repeat met a fenced runner.
    runtime.launch.mockImplementationOnce(async () => {
      await holds.begin("r1", ATTEMPT);
      throw new RunnerUpdateFenced("The runner is updating.");
    });
    const manager = managerOn(holds, runtime);
    holds.start();
    const agent = await manager.createAgent({ ...HELD, initialPrompt: "x" });
    expect(holds.counts("r1").launches).toBe(1);
    const [first] = launchIdsFor(runtime, agent.id);
    expect(holds.current("r1")!.launches[0]!.launchId).toBe(first);

    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchIdsFor(runtime, agent.id)).toEqual([first, first]);
  });

  it("keeps the ID of a held start", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    holds.start();
    const agent = await manager.createAgent({ ...HELD });
    expect(await statusOf(agent.id)).toBe("running");
    await manager.stopAgent(agent.id);
    await holds.begin("r1", ATTEMPT);
    await manager.startAgent(agent.id);
    const heldId = holds.current("r1")!.launches[0]!.launchId;
    expect(heldId).toMatch(UUID);
    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchIdsFor(runtime, agent.id).at(-1)).toBe(heldId);
  });
});

describe("a launch released before a controller restart", () => {
  async function releasedThenRestarted(options: { offline?: boolean } = {}) {
    const first = await openHolds();
    const before = spyRuntime();
    // Released, then the controller stops before the runner answers.
    const reached = Promise.withResolvers<void>();
    before.launch.mockImplementation(() => {
      reached.resolve();
      return new Promise(() => {});
    });
    const manager = managerOn(first, before);
    first.start();
    await first.begin("r1", ATTEMPT);
    const agent = await manager.createAgent({
      ...HELD,
      initialPrompt: "after restart",
    });
    expect(first.counts("r1").launches).toBe(1);
    const launchId = first.current("r1")!.launches[0]!.launchId;
    await first.release("r1", ATTEMPT, "committed");
    await reached.promise;
    expect(launchIdsFor(before, agent.id)).toEqual([launchId]);
    expect((await heldFile()).resuming).toEqual([
      expect.objectContaining({ agentId: agent.id, launchId, runnerId: "r1" }),
    ]);
    first.close();
    work.get(first)!.abandon();

    peer.online = !options.offline;
    const holds = await openHolds();
    const runtime = spyRuntime();
    const restarted = managerOn(holds, runtime);
    await pool.query(
      "UPDATE agents SET updated_at = NOW() - interval '1 hour' WHERE id = $1",
      [agent.id]
    );
    return { agent, launchId, holds, runtime, restarted, before };
  }

  it("drives the same attempt again, once, and never fails it after the grace", async () => {
    const { agent, launchId, holds, runtime, restarted, before } =
      await releasedThenRestarted();
    const { lost } = await restarted.restoreRunningAgents();
    expect(lost).not.toContain(agent.id);
    await restarted.reconcileAgentStatuses();
    expect(await statusOf(agent.id)).toBe("creating");

    holds.start();
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchIdsFor(runtime, agent.id)).toEqual([launchId]);
    expect(launchIdsFor(before, agent.id)).toEqual([launchId]);
    expect(
      promptsFor(runtime, agent.id).filter((p) => p.includes("after restart"))
    ).toHaveLength(1);
    expect(await heldFile()).not.toHaveProperty("resuming");
    expect(holds.hasLaunch(agent.id)).toBe(false);
  });

  it("waits for the runner to reconnect before driving it", async () => {
    const { agent, launchId, holds, runtime } = await releasedThenRestarted({
      offline: true,
    });
    const polledAgain = Promise.withResolvers<void>();
    let polls = 0;
    vi.mocked(remote.available).mockImplementation(() => {
      if (++polls === 2) polledAgain.resolve();
      return peer.online;
    });
    holds.start();
    await polledAgain.promise;
    expect(launchesFor(runtime, agent.id)).toHaveLength(0);
    peer.online = true;
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchIdsFor(runtime, agent.id)).toEqual([launchId]);
  });

  it("is not driven when the agent was stopped meanwhile", async () => {
    const { agent, holds, runtime } = await releasedThenRestarted();
    await pool.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [
      agent.id,
    ]);
    holds.start();
    await work.get(holds)!.settled();
    expect(await heldFile()).not.toHaveProperty("resuming");
    expect(launchesFor(runtime, agent.id)).toHaveLength(0);
  });
});

describe("a new launch while a held runner is between supervisors", () => {
  it("is admitted from what the runner last advertised, held, and run on release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    holds.start();
    await holds.begin("r1", ATTEMPT);
    peer.online = false;
    const agent = await manager.createAgent({
      ...HELD,
      initialPrompt: "while offline",
    });
    expect(holds.counts("r1").launches).toBe(1);
    expect(await statusOf(agent.id)).toBe("creating");
    expect(launchesFor(runtime, agent.id)).toHaveLength(0);
    expect(
      (
        await pool.query("SELECT runner_id FROM agents WHERE id = $1", [
          agent.id,
        ])
      ).rows[0]?.runner_id
    ).toBe("r1");

    peer.online = true;
    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchesFor(runtime, agent.id)).toHaveLength(1);
  });

  it("is refused as before without a hold, or for a runner never seen", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    holds.start();
    peer.online = false;
    await expect(manager.createAgent({ ...HELD })).rejects.toThrow();
    expect(remote.lastConnectionEpoch).not.toHaveBeenCalled();

    await holds.begin("r1", ATTEMPT);
    peer.seen = false;
    await expect(manager.createAgent({ ...HELD })).rejects.toThrow();
    // The runner held is r1; r2 offline is refused as ever.
    peer.seen = true;
    await expect(manager.createAgent({ ...OTHER })).rejects.toThrow();
    expect(runtime.launch).not.toHaveBeenCalled();
    expect(holds.counts("r1").launches).toBe(0);
  });
});

describe("durable agent stop", () => {
  it.each([
    {
      cwd: "/tmp",
      target: null,
      error: new RunnerCallError({ code: "unavailable", message: "offline" }),
      superseded: false,
    },
    {
      ...HELD,
      target: "r1",
      error: new RunnerUnavailable("offline"),
      superseded: true,
    },
  ])(
    "replays the same launch after restarting Dispatch ($cwd)",
    async ({ cwd, target, error, superseded }) => {
      const holds = await openHolds();
      const firstRuntime = spyRuntime();
      const first = managerOn(holds, firstRuntime);
      const agent = await first.createAgent(target ? HELD : { cwd });
      await pool.query("UPDATE agents SET host_launch_id = $2 WHERE id = $1", [
        agent.id,
        ATTEMPT,
      ]);
      firstRuntime.stop.mockRejectedValueOnce(error);
      expect((await first.stopAgent(agent.id, { force: true })).status).toBe(
        "stopped"
      );

      if (superseded) {
        await pool.query(
          "UPDATE agents SET status = 'running', host_launch_id = 'newer-launch' WHERE id = $1",
          [agent.id]
        );
      }
      const restarted = Object.assign(spyRuntime(), {
        retryStop: vi.fn(async () => {}),
      });
      if (superseded) restarted.attach.mockResolvedValue(true);
      const manager = managerOn(holds, restarted);
      await manager.reconcileAgentStatuses();
      await vi.waitFor(async () => {
        const { rowCount } = await pool.query(
          "SELECT 1 FROM pending_agent_stops WHERE agent_id = $1",
          [agent.id]
        );
        expect(rowCount).toBe(0);
      });
      expect(restarted.retryStop).toHaveBeenCalledExactlyOnceWith(
        agent.id,
        true,
        target,
        ATTEMPT
      );
      expect(restarted.stop).not.toHaveBeenCalled();
      expect(await statusOf(agent.id)).toBe(superseded ? "running" : "stopped");
    }
  );
});

describe("the create-time icon warm-up on a runner (T15c)", () => {
  it("remembers the launch checkout's icon under its project's repository", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    holds.start();
    const checkout = await mkdtemp(path.join(dir, "checkout-"));
    await writeFile(path.join(checkout, "favicon.svg"), "<svg/>");
    const repository = `https://github.com/acme/warm-${Date.now()}`;
    const projectId = (
      await pool.query<{ id: string }>(
        "INSERT INTO projects (id, name, repo_root, color, repository) VALUES (gen_random_uuid(), 'warm', NULL, '#336699', $1) RETURNING id",
        [repository]
      )
    ).rows[0]!.id;
    servedCheckout = checkout;
    const agent = await manager.createAgent({ ...OTHER, projectId });
    await vi.waitFor(async () =>
      expect(await statusOf(agent.id)).toBe("running")
    );
    const rows = async () =>
      (
        await pool.query<{ cwd: string; icon_path: string | null }>(
          "SELECT cwd, icon_path FROM directory_icons WHERE cwd = $1 OR cwd = $2",
          [repository, agent.cwd]
        )
      ).rows;
    await vi.waitFor(async () =>
      expect(await rows()).toEqual([
        { cwd: repository, icon_path: "favicon.svg" },
      ])
    );
    servedCheckout = undefined;
  });

  it("caches a local folder's icon at create even when the launch then fails (main)", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    runtime.launch.mockRejectedValueOnce(new Error("host failed to start"));
    const manager = managerOn(holds, runtime);
    // This harness's fixture child serves no checkout reads: it answers them
    // as a child that cannot be reached, so they run in process.
    const fixture = (
      manager as unknown as { localRunnerChild: () => Runner }
    ).localRunnerChild();
    manager.attachLocalRunner(
      () =>
        ({
          ...fixture,
          connection: fixture.connection,
          call: (op: string, request: unknown, options: unknown) =>
            op.startsWith("checkout.")
              ? Promise.reject(
                  new RunnerCallError({ code: "unavailable", message: op })
                )
              : fixture.call(op as never, request as never, options as never),
        }) as unknown as Runner
    );
    holds.start();
    const folder = await mkdtemp(path.join(dir, "failing-"));
    await writeFile(path.join(folder, "favicon.svg"), "<svg/>");
    await expect(
      manager.createAgent({ cwd: folder, useWorktree: false })
    ).rejects.toThrow("host failed to start");
    expect(
      (
        await pool.query(
          "SELECT cwd, icon_path FROM directory_icons WHERE cwd = $1",
          [folder]
        )
      ).rows
    ).toEqual([{ cwd: folder, icon_path: "favicon.svg" }]);
  });
});
