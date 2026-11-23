import { withTestWorkspaceRunner } from "../helpers/test-workspace-runner.js";
/**
 * Launches, starts and stops for agents on a runner held for an update:
 * held before anything is attempted, persisted across a controller restart,
 * cancelled by a stop, re-held after a fence refusal, run once on release.
 * Agents on other runners and local agents are untouched.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import type { RemoteRunnerService } from "../../src/agents/remote/service.js";
import type { AgentRuntime, RuntimeLaunch } from "../../src/agents/runtime.js";
import { trackHoldWork } from "../helpers/hold-work.js";
import { setupTestDb, teardownTestDb, runTestMigrations } from "./setup.js";

vi.mock("../../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));
// Local agents create a worktree; keep git off the host.
vi.mock("../../src/shared/git/worktree.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/shared/git/worktree.js")
  >("../../src/shared/git/worktree.js");
  return {
    ...actual,
    createGitWorktree: vi.fn(async () => ({
      worktreePath: "/tmp",
      branchName: "main",
    })),
  };
});
vi.mock("../../src/agents/workspace-prep.js", () => ({
  installWorkspaceDependencies: vi.fn(async () => {}),
}));

const { AgentManager: HostAgentManager } =
  await import("../../src/agents/manager.js");
const AgentManager = withTestWorkspaceRunner(HostAgentManager);
type Manager = InstanceType<typeof AgentManager>;
const { deleteAgentDirect } = await import("../../src/agents/archive.js");
const { createInertRuntime } = await import("../../src/agents/runtime.js");
const { RunnerUpdateFenced } =
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
const HELD = "runner://r1/@session";
const OTHER = "runner://r2/@session";

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

/** Runner requests; a test may refuse the next one of a kind as fenced. */
const refuseNext = new Map<string, () => Promise<void>>();
const requestSession = vi.fn(
  async (_placement: unknown, operation: { kind: string }) => {
    const refusal = refuseNext.get(operation.kind);
    if (refusal) {
      refuseNext.delete(operation.kind);
      await refusal();
      throw new RunnerUpdateFenced("The runner is updating.");
    }
    return {
      value: operation.kind === "sessionFile" ? "/runner/files/x" : true,
    };
  }
);
const remote = {
  available: () => true,
  isManagedWorkspace: () => true,
  originFor: () => "https://example.test",
  supportsSessionFiles: () => true,
  requestSession,
  // files.put goes through the same request seam, so refusals still apply.
  putFile: async (placement: unknown, agentId: string, name: string) =>
    (
      await requestSession(placement, {
        agentId,
        kind: "sessionFile",
        operation: { kind: "deliver", name },
      } as never)
    ).value,
} as unknown as RemoteRunnerService;

async function openHolds(boundMs?: number) {
  const holds = new RunnerUpdateHolds({
    store: fileRunnerHoldStore(holdsFile),
    logger: noopLogger,
    ...(boundMs ? { boundMs } : {}),
  });
  opened.push(holds);
  work.set(holds, trackHoldWork(holds));
  await holds.load();
  holds.start();
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
  });
}

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
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  refuseNext.clear();
  requestSession.mockClear();
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

describe("launches on a runner held for an update", () => {
  it("holds only the held runner's launch and runs it once on release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    await holds.begin("r1", ATTEMPT);

    const held = await manager.createAgent({
      cwd: HELD,
      initialPrompt: "held work",
    });
    const other = await manager.createAgent({
      cwd: OTHER,
      initialPrompt: "other work",
    });
    const local = await manager.createAgent({
      cwd: "/tmp",
      initialPrompt: "local work",
    });

    expect(launchesFor(runtime, held.id)).toHaveLength(0);
    expect(await statusOf(held.id)).toBe("creating");
    expect(holds.counts("r1").launches).toBe(1);
    expect(launchesFor(runtime, other.id)).toHaveLength(1);
    expect(launchesFor(runtime, local.id)).toHaveLength(1);
    expect(await statusOf(other.id)).toBe("running");
    expect(await statusOf(local.id)).toBe("running");

    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(held.id)).toBe("running");
    expect(launchesFor(runtime, held.id)).toEqual([
      [
        expect.objectContaining({
          placement: { runner: "r1", workspace: "@session" },
          resumeSessionId: null,
        }),
      ],
    ]);
    expect(
      promptsFor(runtime, held.id).filter((p) => p.includes("held work"))
    ).toHaveLength(1);
    expect(holds.counts("r1").launches).toBe(0);
  });

  it("keeps a held launch across a controller restart and runs it once", async () => {
    const first = await openHolds();
    const before = spyRuntime();
    const manager = managerOn(first, before);
    await first.begin("r1", ATTEMPT);
    const held = await manager.createAgent({
      cwd: HELD,
      initialPrompt: "survives restart",
    });
    expect(launchesFor(before, held.id)).toHaveLength(0);
    first.close();

    // A new process: no host anywhere, and a launch older than the grace.
    const holds = await openHolds();
    const runtime = spyRuntime();
    const restarted = managerOn(holds, runtime);
    await pool.query(
      "UPDATE agents SET updated_at = NOW() - interval '1 hour' WHERE id = $1",
      [held.id]
    );
    const { lost } = await restarted.restoreRunningAgents();
    expect(lost).not.toContain(held.id);
    await restarted.reconcileAgentStatuses();
    expect(await statusOf(held.id)).toBe("creating");
    expect(runtime.attach).not.toHaveBeenCalledWith(held.id);

    await holds.release("r1", ATTEMPT, "rolled_back");
    await work.get(holds)!.settled();
    expect(await statusOf(held.id)).toBe("running");
    expect(launchesFor(runtime, held.id)).toHaveLength(1);
    expect(launchesFor(before, held.id)).toHaveLength(0);
    expect(
      promptsFor(runtime, held.id).filter((p) => p.includes("survives restart"))
    ).toHaveLength(1);
  });

  it("lets a stop during the hold cancel the launch", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    await holds.begin("r1", ATTEMPT);
    const held = await manager.createAgent({ cwd: HELD });

    const stopped = await manager.stopAgent(held.id);
    expect(stopped.status).toBe("stopped");
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(holds.counts("r1").launches).toBe(0);

    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(launchesFor(runtime, held.id)).toHaveLength(0);
    expect(await statusOf(held.id)).toBe("stopped");
  });

  it("drops a held launch whose agent was archived before release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    await holds.begin("r1", ATTEMPT);
    const held = await manager.createAgent({ cwd: HELD });
    // A cancellation that did not go through this manager: the row decides.
    await pool.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [
      held.id,
    ]);
    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(launchesFor(runtime, held.id)).toHaveLength(0);
  });

  it("re-holds a launch the fence refused instead of failing it", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    runtime.launch.mockImplementationOnce(async () => {
      // The fence closed after the launch left Dispatch.
      await holds.begin("r1", ATTEMPT);
      throw new RunnerUpdateFenced("The runner is updating.");
    });
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({
      cwd: HELD,
      initialPrompt: "refused once",
    });
    expect(await statusOf(agent.id)).toBe("creating");
    expect(holds.counts("r1").launches).toBe(1);

    await holds.release("r1", ATTEMPT, "fence_released");
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchesFor(runtime, agent.id)).toHaveLength(2);
    expect(
      promptsFor(runtime, agent.id).filter((p) => p.includes("refused once"))
    ).toHaveLength(1);
  });

  it("fails any other launch error under a hold, as before", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    runtime.launch.mockImplementationOnce(async () => {
      await holds.begin("r1", ATTEMPT);
      throw new Error("engine missing");
    });
    const manager = managerOn(holds, runtime);
    await expect(manager.createAgent({ cwd: HELD })).rejects.toThrow(
      "engine missing"
    );
    expect(holds.counts("r1").launches).toBe(0);
  });

  it("drops a held start whose agent was stopped before release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    await manager.stopAgent(agent.id);
    await holds.begin("r1", ATTEMPT);
    await manager.startAgent(agent.id);
    await pool.query("UPDATE agents SET status = 'stopped' WHERE id = $1", [
      agent.id,
    ]);
    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(launchesFor(runtime, agent.id)).toHaveLength(1);
    expect(await statusOf(agent.id)).toBe("stopped");
  });

  it("resumes a held start behind a stop already in its lifecycle", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    await manager.stopAgent(agent.id);
    await holds.begin("r1", ATTEMPT);
    await manager.startAgent(agent.id);
    // A stop that holds the agent's lifecycle across the release.
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let proceed!: () => void;
    manager.attachScheduleCancellation(async () => {
      entered();
      await new Promise<void>((resolve) => {
        proceed = resolve;
      });
    });
    const stop = manager.stopAgent(agent.id);
    await inside;
    const serialize = vi.spyOn(manager as any, "serializeLifecycle");
    await holds.release("r1", ATTEMPT, "committed");
    // Queued behind the stop before the stop may finish.
    expect(serialize).toHaveBeenCalledWith(agent.id, expect.any(Function));
    proceed();
    await stop;
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("stopped");
    expect(launchesFor(runtime, agent.id)).toHaveLength(1);
  });

  it("fails a fence refusal with no hold on, as any launch error", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    runtime.launch.mockRejectedValueOnce(
      new RunnerUpdateFenced("The runner is updating.")
    );
    const manager = managerOn(holds, runtime);
    await expect(manager.createAgent({ cwd: HELD })).rejects.toThrow(
      "The runner is updating."
    );
  });

  it("re-holds a start the fence refused instead of failing it", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    await manager.stopAgent(agent.id);
    runtime.launch.mockImplementationOnce(async () => {
      await holds.begin("r1", ATTEMPT);
      throw new RunnerUpdateFenced("The runner is updating.");
    });
    expect((await manager.startAgent(agent.id)).status).toBe("creating");
    expect(holds.counts("r1").launches).toBe(1);
    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchesFor(runtime, agent.id)).toHaveLength(3);
  });

  it("lets an archive during the hold cancel the launch", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    await holds.begin("r1", ATTEMPT);
    const held = await manager.createAgent({ cwd: HELD });
    await manager.beginArchive(held.id);
    expect(holds.counts("r1").launches).toBe(0);
    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(launchesFor(runtime, held.id)).toHaveLength(0);
  });

  it("holds an archive's runner teardown until release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const held = await manager.createAgent({ cwd: HELD });
    await holds.begin("r1", ATTEMPT);
    await manager.beginArchive(held.id);
    let done = false;
    const archive = manager
      .executeArchive(held.id, {
        onPhaseChange: () => {},
        onComplete: () => {},
        onError: () => {},
      })
      .then(() => {
        done = true;
      });
    await Promise.race([work.get(holds)!.blocked, archive]);
    expect(done).toBe(false);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(holds.counts("r1").stops).toBe(1);
    await holds.release("r1", ATTEMPT, "committed");
    await archive;
    expect(runtime.stop).toHaveBeenCalledWith(held.id, true);
  });

  it("names the runner path in prompt text and continues past a file it cannot put", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    const notes = path.join(dir, "notes.txt");
    const gone = path.join(dir, "gone.png");
    await writeFile(notes, "hello");
    await writeFile(gone, "png");
    const put = vi
      .spyOn(remote, "putFile")
      .mockImplementation(async (_placement, _agentId, name) => {
        if (name === "gone.png")
          throw new Error("Session file is unavailable (ENOENT).");
        return `/runner/files/${name}`;
      });
    onTestFinished(() => put.mockRestore());
    const prepared = await manager["preparePromptFiles"](
      agent.id,
      [
        {
          path: notes,
          mimeType: "text/plain",
          runnerName: "notes.txt",
        },
        {
          path: gone,
          mimeType: "image/png",
          runnerName: "gone.png",
        },
      ],
      `- file: ${notes} (text/plain)\n- file: ${gone} (image/png)`
    );
    expect(prepared).toEqual({
      images: [],
      text: `- file: /runner/files/notes.txt (text/plain)\n- file: ${gone} (image/png)`,
    });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("puts family references once per digest and recipient, and retries failed puts", async () => {
    const manager = managerOn(await openHolds(), spyRuntime());
    const parent = await manager.createAgent({ cwd: HELD });
    const child = await manager.createAgent({ cwd: HELD });
    const source = path.join(dir, "report.txt");
    const runnerFiles = await mkdtemp(path.join(dir, "runner-"));
    await writeFile(source, "first report");
    const put = vi
      .spyOn(remote, "putFile")
      .mockImplementation(async (_placement, agentId, name, file) => {
        const destination = path.join(runnerFiles, `${agentId}-${name}`);
        await writeFile(destination, await file.read());
        return destination;
      });
    onTestFinished(() => put.mockRestore());
    const deliver = (agent = parent) =>
      manager.deliverSessionFile(agent, source, "report.txt", "reference");

    const [first, repeat] = await Promise.all([deliver(), deliver()]);
    expect(repeat).toBe(first);
    expect(await readFile(first, "utf8")).toBe("first report");
    expect(put).toHaveBeenCalledTimes(1);
    expect(await deliver(child)).not.toBe(first);
    expect(put).toHaveBeenCalledTimes(2);

    await writeFile(source, "updated report");
    put.mockRejectedValueOnce(new Error("Put interrupted"));
    await expect(deliver()).rejects.toThrow("Put interrupted");
    const updated = await deliver();
    expect(updated).not.toBe(first);
    expect(await readFile(updated, "utf8")).toBe("updated report");
    expect(await readFile(first, "utf8")).toBe("first report");
    expect(put).toHaveBeenCalledTimes(4);
  });

  it("waits out a fence that refuses a new host's files, then delivers them once", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    refuseNext.set("sessionFile", () =>
      holds.begin("r1", ATTEMPT).then(() => {})
    );
    let created = false;
    const creating = manager
      .createAgent({
        cwd: HELD,
        initialPrompt: "read it",
        initialFiles: [
          {
            fileName: "notes.txt",
            buffer: Buffer.from("hello"),
            source: "user",
            mimeType: "text/plain",
          },
        ],
      })
      .then((agent) => {
        created = true;
        return agent;
      });
    await Promise.race([work.get(holds)!.blocked, creating]);
    expect(holds.isHeld("r1")).toBe(true);
    expect(created).toBe(false);
    expect(runtime.stop).not.toHaveBeenCalled();
    await holds.release("r1", ATTEMPT, "committed");
    const agent = await creating;
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchesFor(runtime, agent.id)).toHaveLength(1);
    expect(
      requestSession.mock.calls.filter(([, op]) => op.kind === "sessionFile")
    ).toHaveLength(2);
    expect(
      promptsFor(runtime, agent.id).filter((p) => p.includes("read it"))
    ).toHaveLength(1);
  });

  it("holds a start and runs it with the saved session on release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    await manager.stopAgent(agent.id);
    await holds.begin("r1", ATTEMPT);

    const started = await manager.startAgent(agent.id);
    expect(started.status).toBe("creating");
    expect(launchesFor(runtime, agent.id)).toHaveLength(1);

    await holds.release("r1", ATTEMPT, "committed");
    await work.get(holds)!.settled();
    expect(await statusOf(agent.id)).toBe("running");
    expect(launchesFor(runtime, agent.id).at(-1)).toEqual([
      expect.objectContaining({ resumeSessionId: "sess_1" }),
    ]);
  });

  it("holds a stop without touching the agent until release", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const held = await manager.createAgent({ cwd: HELD });
    const other = await manager.createAgent({ cwd: OTHER });
    await holds.begin("r1", ATTEMPT);

    let done = false;
    const stopping = manager.stopAgent(held.id).then(() => {
      done = true;
    });
    await manager.stopAgent(other.id);
    expect(runtime.stop).toHaveBeenCalledWith(other.id, false);
    await Promise.race([work.get(holds)!.blocked, stopping]);
    expect(done).toBe(false);
    expect(runtime.stop).not.toHaveBeenCalledWith(held.id, false);
    expect(await statusOf(held.id)).toBe("running");
    expect(holds.counts("r1").stops).toBe(1);

    await holds.release("r1", ATTEMPT, "committed");
    await stopping;
    expect(runtime.stop).toHaveBeenCalledWith(held.id, false);
    expect(await statusOf(held.id)).toBe("stopped");
  });

  it.each(["archiving", "stopped", "deleted"] as const)(
    "leaves an agent that became %s alone after a held stop",
    async (status) => {
      const holds = await openHolds();
      const runtime = spyRuntime();
      const manager = managerOn(holds, runtime);
      const agent = await manager.createAgent({ cwd: HELD });
      await holds.begin("r1", ATTEMPT);
      const stopping = manager.stopAgent(agent.id);
      const outcome = stopping.catch((err: Error) => err);
      await Promise.race([work.get(holds)!.blocked, outcome]);
      expect(holds.counts("r1").stops).toBe(1);
      if (status === "archiving") await manager.beginArchive(agent.id, "keep");
      else if (status === "deleted")
        await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
          agent.id,
        ]);
      else
        await pool.query(
          "UPDATE agents SET status = 'stopped', last_error = 'newer' WHERE id = $1",
          [agent.id]
        );
      const before = (
        await pool.query("SELECT * FROM agents WHERE id = $1", [agent.id])
      ).rows[0];
      const queries = vi.spyOn(pool, "query");
      try {
        await holds.release("r1", ATTEMPT, "committed");
        if (status === "deleted")
          expect(await outcome).toMatchObject({ message: "Agent not found." });
        else expect(await outcome).toMatchObject({ status });
        expect(
          queries.mock.calls.some(
            ([sql]) => typeof sql === "string" && sql.includes("UPDATE agents")
          )
        ).toBe(false);
      } finally {
        queries.mockRestore();
      }
      expect(
        (await pool.query("SELECT * FROM agents WHERE id = $1", [agent.id]))
          .rows[0]
      ).toEqual(before);
      expect(runtime.stop).not.toHaveBeenCalled();
    }
  );

  it("does not mark an archiving agent stopped if a late launch hold exists", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    await holds.begin("r1", ATTEMPT);
    await manager.beginArchive(agent.id, "keep");
    await holds.holdLaunch("r1", {
      agentId: agent.id,
      kind: "start",
      launchId: ATTEMPT,
    });
    expect(await manager.stopAgent(agent.id)).toMatchObject({
      status: "archiving",
    });
    expect(await statusOf(agent.id)).toBe("archiving");
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("publishes stopping then stopped with no hold", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    const statuses: string[] = [];
    manager.onAgentUpdated((row) => {
      if (row.id === agent.id) statuses.push(row.status);
    });
    expect(await manager.stopAgent(agent.id)).toMatchObject({
      status: "stopped",
    });
    expect(statuses).toEqual(["stopping", "stopped"]);
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith(agent.id, false);
  });

  it("does not claim stopping if archive won after the post-hold read", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    const query = pool.query.bind(pool);
    const intercepted = vi.spyOn(pool, "query").mockImplementation((async (
      sql: string,
      values?: unknown[]
    ) => {
      if (values?.[0] === agent.id && values[1] === "stopping")
        await manager.beginArchive(agent.id, "keep");
      return query(sql, values);
    }) as typeof pool.query);
    try {
      expect(await manager.stopAgent(agent.id)).toMatchObject({
        status: "archiving",
      });
      expect(runtime.stop).not.toHaveBeenCalled();
    } finally {
      intercepted.mockRestore();
    }
  });

  it.each([false, true])(
    "preserves an archive claimed during runtime.stop (stop failed=%s)",
    async (fails) => {
      const holds = await openHolds();
      const runtime = spyRuntime();
      const manager = managerOn(holds, runtime);
      const agent = await manager.createAgent({ cwd: HELD });
      runtime.stop.mockImplementationOnce(async () => {
        await manager.beginArchive(agent.id, "keep");
        if (fails) throw new Error("stop failed");
      });
      expect(await manager.stopAgent(agent.id)).toMatchObject({
        status: "archiving",
      });
      expect(await statusOf(agent.id)).toBe("archiving");
    }
  );

  it("skips archive teardown if the agent was deleted during the hold", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    await holds.begin("r1", ATTEMPT);
    await manager.beginArchive(agent.id, "keep");
    const archiving = manager.executeArchive(agent.id, {
      onPhaseChange: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    });
    await Promise.race([work.get(holds)!.blocked, archiving]);
    expect(holds.counts("r1").stops).toBe(1);
    await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
      agent.id,
    ]);
    await holds.release("r1", ATTEMPT, "committed");
    await archiving;
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.discard).not.toHaveBeenCalled();
  });

  it("retries a refused stop hook once the drain is only waiting", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    refuseNext.set("checkoutCommand", async () => {
      await holds.begin("r1", ATTEMPT);
    });
    const stopping = manager.stopAgent(agent.id);
    await Promise.race([work.get(holds)!.blocked, stopping]);
    holds.setStopPhase("r1", ATTEMPT, "draining");
    expect(await stopping).toMatchObject({ status: "stopped" });
    expect(holds.isHeld("r1")).toBe(true);
  });

  it("skips retrying the refused stop hook after archive takes over", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const agent = await manager.createAgent({ cwd: HELD });
    refuseNext.set("checkoutCommand", async () => {
      await holds.begin("r1", ATTEMPT);
    });
    const stopping = manager.stopAgent(agent.id);
    await Promise.race([work.get(holds)!.blocked, stopping]);
    expect(holds.isHeld("r1")).toBe(true);
    await manager.beginArchive(agent.id, "keep");
    await holds.release("r1", ATTEMPT, "committed");
    expect(await stopping).toMatchObject({ status: "archiving" });
    const hookReads = requestSession.mock.calls
      .map(
        ([, operation]) =>
          operation as { kind: string; operation?: { checkout: string } }
      )
      .filter(({ kind }) => kind === "checkoutCommand")
      .map(({ operation }) => operation?.checkout);
    expect(hookReads.filter((checkout) => checkout === "launch")).toHaveLength(
      1
    );
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["a stop", (manager: Manager, id: string) => manager.stopAgent(id)],
    [
      "an archive",
      async (manager: Manager, id: string) => {
        await manager.beginArchive(id, "keep");
        await manager.executeArchive(id, {
          onPhaseChange: () => {},
          onComplete: () => {},
          onError: () => {},
        });
      },
    ],
    [
      "a cascade",
      (manager: Manager, id: string) =>
        deleteAgentDirect((manager as any).archiveDeps(), id),
    ],
  ] as const)(
    "finishes the hook of %s that the fence landed in",
    async (_case, end) => {
      const holds = await openHolds();
      const runtime = spyRuntime();
      const manager = managerOn(holds, runtime);
      const agent = await manager.createAgent({ cwd: HELD });
      // The hold begins at `ready`, the fence straight after it.
      refuseNext.set("checkoutCommand", async () => {
        await holds.begin("r1", ATTEMPT);
      });
      const hookRequests = () =>
        requestSession.mock.calls
          .map(([, operation]) => operation as any)
          .filter(({ kind }) => kind === "checkoutCommand")
          .map(({ operation }) => operation.checkout);
      const ending = end(manager, agent.id);
      await Promise.race([work.get(holds)!.blocked, ending]);
      expect(holds.isHeld("r1")).toBe(true);
      expect(hookRequests()).toEqual(["launch"]);
      await holds.release("r1", ATTEMPT, "committed");
      await ending;
      expect(hookRequests()).toEqual(["launch", "launch", "moved"]);
    }
  );

  it("runs held launches at the bound when the hold is never released", async () => {
    const holds = await openHolds(300);
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const expired = Promise.withResolvers<string>();
    holds.onRelease(({ outcome }) => expired.resolve(outcome));
    // Otherwise the bound races the launch it is meant to hold.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await holds.begin("r1", ATTEMPT);
    const held = await manager.createAgent({ cwd: HELD });
    expect(launchesFor(runtime, held.id)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    expect(await expired.promise).toBe("expired");
    await work.get(holds)!.settled();
    expect(await statusOf(held.id)).toBe("running");
    expect(holds.isHeld("r1")).toBe(false);
    expect(launchesFor(runtime, held.id)).toHaveLength(1);
  });

  it("reports an update hold only for agents on the held runner", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const held = await manager.createAgent({ cwd: HELD });
    const other = await manager.createAgent({ cwd: OTHER });
    const local = await manager.createAgent({ cwd: "/tmp" });
    // A recorded path need not encode the runner.
    await pool.query("UPDATE agents SET cwd = '/checkout' WHERE id = $1", [
      held.id,
    ]);
    expect((await manager.getAgent(held.id))?.placement).toEqual({
      runner: "r1",
    });
    expect((await manager.getAgent(local.id))?.placement).toEqual({
      runner: "local",
    });
    await holds.begin("r1", ATTEMPT);
    expect(await manager.isUpdateHeld(held.id)).toBe(true);
    expect(await manager.isUpdateHeld(other.id)).toBe(false);
    expect(await manager.isUpdateHeld(local.id)).toBe(false);
  });
});

describe("runner drain resume receipts", () => {
  it("protects the receipt at boot and never restarts a user-stopped, archived or deleted agent", async () => {
    const holds = await openHolds();
    const runtime = spyRuntime();
    const manager = managerOn(holds, runtime);
    const [resume, stopped, archived, deleted] = await Promise.all(
      Array.from({ length: 4 }, () => manager.createAgent({ cwd: HELD }))
    );
    const entries = await manager.updateResumeSnapshot([
      resume.id,
      stopped.id,
      archived.id,
      deleted.id,
    ]);
    await holds.begin("r1", ATTEMPT, { draining: true });
    const afterRestart = managerOn(holds, runtime);
    afterRestart.setRunnerDrainReceipt(
      "r1",
      entries.map(({ id }) => id)
    );
    expect((await afterRestart.restoreRunningAgents()).lost).toEqual([]);
    await afterRestart.reconcileAgentStatuses();
    expect(await statusOf(resume.id)).toBe("running");
    Object.assign(runtime, { runnerHostAlive: vi.fn(async () => false) });
    await afterRestart.stopAgent(stopped.id);
    await afterRestart.beginArchive(archived.id);
    await pool.query("UPDATE agents SET deleted_at = NOW() WHERE id = $1", [
      deleted.id,
    ]);
    runtime.launch.mockClear();
    for (const entry of entries)
      await afterRestart.resumeRunnerDrainHost("r1", ATTEMPT, entry);
    for (const entry of entries)
      await afterRestart.resumeRunnerDrainHost("r1", ATTEMPT, entry);
    expect(runtime.launch.mock.calls).toEqual([
      [
        expect.objectContaining({
          agentId: resume.id,
          launchId: ATTEMPT,
          resumeSessionId: resume.cliSessionId,
          requireResume: true,
        }),
      ],
    ]);
    expect(await statusOf(stopped.id)).toBe("stopped");
    expect(await statusOf(archived.id)).toBe("archiving");
    expect(await afterRestart.getAgent(deleted.id)).toBeNull();
    expect(holds.isHeld("r1")).toBe(true);
  });
});
