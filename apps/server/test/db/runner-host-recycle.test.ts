import { attachedHost } from "../runner-update-hold-fixtures.js";
import { localLaunchSettings } from "../../src/agents/acp/launch-env.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { AgentManager } from "../../src/agents/manager.js";
import {
  localRunnerFor,
  stopLocalRunners,
} from "../helpers/local-runner-child.js";
import {
  encodeMessage,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "@dispatch/runner-client/host-framing";
import type { RemoteRunnerService } from "../../src/agents/remote/service.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.resolve(here, "../../src/main.ts");
const adapter = path.resolve(here, "../helpers/recycle-acp-fixture.ts");
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
  child: () => logger,
} as unknown as FastifyBaseLogger;

const update = {
  runnerId: "r1",
  attemptId: "11111111-1111-4111-8111-111111111111",
  revision: "b".repeat(40),
  sha256: "c".repeat(64),
};
const oldRevision = "a".repeat(40);
let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(async () => {
  await stopLocalRunners();
  await teardownTestDb();
});

function listening(socketPath: string) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The recycler's periodic rescan would cover for a first pass, or a pass on
 * settlement, that did nothing; only tests that need it keep it.
 */
async function fixture({ periodicRescan = false } = {}) {
  const directory = mkdtempSync("/tmp/dr-recycle-");
  const state = path.join(directory, "s");
  const runnerState = path.join(directory, "r");
  vi.stubEnv(
    "DISPATCH_AGENT_HOST_COMMAND",
    JSON.stringify(["bun", main, "agent-host"])
  );
  const processes = new Map<
    string,
    { child: ChildProcess; exited: Promise<unknown> }
  >();
  const launches = new Map<string, Array<string | null>>();
  const hostPids = new Map<string, number>();
  const commands: Array<{ id: string; message: ClientMessage }> = [];
  const offeredSupport = new Set<string>();
  const holdReply = new Map<string, Promise<void>>();
  const holdStop = new Map<string, Promise<void>>();
  const holdReplay = new Map<string, Promise<void>>();
  const wrongSession = new Set<string>();
  const welcomedReplacement = new Set<string>();
  const swapping = new Set<string>();
  let online = true;
  const closing = Promise.withResolvers<void>();
  let closed = false;
  const waiting = new Set<() => void>();
  const changed = () => {
    for (const check of waiting) check();
  };
  /**
   * Resolves when the fixture sees `check` become true, with no deadline
   * but the test's.
   */
  function reached(check: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const look = () => {
        if (closed) reject(new Error(`closed before ${check}`));
        else if (check()) resolve();
        else return;
        waiting.delete(look);
      };
      waiting.add(look);
      look();
    });
  }
  const unlessClosing = (gate?: Promise<void>) =>
    gate && Promise.race([gate, closing.promise]);

  const hostDir = (id: string) => path.join(runnerState, id);
  const checkout = (id: string) => path.join(directory, "w", id);
  async function stop(id: string) {
    const host = processes.get(id);
    if (!host) return;
    host.child.kill();
    await host.exited;
    processes.delete(id);
  }

  const remote = {
    available: () => true,
    originFor: () => "https://example.test",
    connectionEpoch: () => (online ? 1 : undefined),
    lastConnectionEpoch: () => 1,
    permitsAgentMcp: () => true,
    selfUpdate: () =>
      online
        ? {
            advert: {
              revision: update.revision,
              installedSha256: update.sha256,
            },
          }
        : undefined,
    async call(_runner, op, input) {
      const id = input.session;
      const dir = hostDir(id);
      if (op === "session.launch") {
        const attempts = launches.get(id) ?? [];
        attempts.push(input.resume);
        launches.set(id, attempts);
        changed();
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        mkdirSync(checkout(id), { recursive: true });
        const launch = {
          agentId: id,
          engine: input.engine,
          model: input.model,
          effort: input.effort,
          resumeSessionId: input.resume,
          systemPrompt: input.systemText,
          personaContext: input.firstText,
          fullAccess: input.access === "full",
          ...(attempts.length > 1 &&
            wrongSession.has(id) && { resumeSessionId: "different-session" }),
          hostInstanceId: randomUUID(),
          cwd: checkout(id),
          bins: {
            claudeBin: "/bin/echo",
            codexBin: null,
            adapter: {
              bin: "bun",
              args: [adapter, path.join(dir, "attached")],
            },
          },
          env: {},
          pathPrefix: [],
        };
        writeFileSync(path.join(dir, "launch.json"), JSON.stringify(launch));
        const child = spawn("bun", [main, "agent-host", "--state", dir], {
          stdio: "ignore",
        });
        hostPids.set(id, child.pid!);
        processes.set(id, { child, exited: once(child, "exit") });
        while (!(await listening(path.join(dir, "host.sock")))) {
          if (closed || child.exitCode !== null || child.signalCode !== null)
            throw new Error("The host ended before it was listening.");
          await delay(25);
        }
        return {};
      }
      if (op === "session.alive")
        return { state: processes.has(id) ? "live" : "gone" };
      if (op === "session.stop") {
        swapping.add(id);
        changed();
        await unlessClosing(holdStop.get(id));
        await stop(id);
        return {};
      }
      if (op === "session.logs") return { text: "" };
      if (op === "checkout.read" || op === "git.context") return null;
      throw new Error("Unexpected runner operation " + op);
    },
    async openStream(_runner, op, { session: id }) {
      expect(op).toBe("session.attach");
      const dir = hostDir(id);

      const host = net.createConnection(path.join(dir, "host.sock"));
      const outbound = ndjsonDecoder<ClientMessage>();
      const inbound = ndjsonDecoder<HostMessage>();
      const link = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          for (const message of outbound(chunk)) {
            commands.push({ id, message });
            changed();
            host.write(encodeMessage(message));
          }
          callback();
        },
        destroy(error, callback) {
          host.destroy();
          callback(error);
        },
      });
      host.on("error", (error) => link.destroy(error));
      host.on("close", () => link.destroy());
      host.on("data", (chunk) => {
        for (const message of inbound(chunk)) {
          if (message.type === "welcome") {
            // The engine starts once attached, so the host's start-up welcome
            // is the last one: a later one would drop the recycler's lease.
            writeFileSync(path.join(dir, "attached"), "");
            if ((launches.get(id)?.length ?? 0) > 1 && message.running) {
              welcomedReplacement.add(id);
              changed();
            }
            message.hostBuild = {
              version: "1.7.28",
              revision:
                launches.get(id)?.length === 1 ? oldRevision : update.revision,
            };
            if (!offeredSupport.has(id)) delete message.quiesceSupported;
          }
          const pause =
            message.type === "quiesce_result"
              ? holdReply.get(id)
              : message.type === "replay_complete"
                ? holdReplay.get(id)
                : undefined;
          if (pause) {
            void unlessClosing(pause)!.then(() => {
              if (!link.destroyed) link.push(encodeMessage(message));
            });
          } else {
            link.push(encodeMessage(message));
          }
        }
      });
      return attachedHost(link, id);
    },
  } satisfies Partial<RemoteRunnerService>;
  const config = {
    host: "127.0.0.1",
    port: 51800,
    databaseUrl: "",
    authToken: "test",
    filesRoot: path.join(directory, "files"),
    dispatchBinDir: path.join(directory, "bin"),
    claudeBin: "/bin/echo",
    codexBin: null,
    opencodeBin: "/bin/echo",
    agentStateRoot: state,
    agentRuntime: "acp",
    acpAdapter: { bin: "bun", args: [adapter] },
    tls: null,
  } satisfies ConstructorParameters<typeof AgentManager>[2];
  const manager = new AgentManager(pool, logger, config, {
    remote: remote as unknown as RemoteRunnerService,
  });
  manager.attachLocalRunner(
    () => localRunnerFor(state, localLaunchSettings(config)).session
  );

  if (!periodicRescan) {
    const recycler = manager["hostRecycler"];
    const scan = recycler["scan"].bind(recycler);
    recycler["scan"] = (run) => {
      scan(run);
      clearTimeout(run.timer);
    };
  }
  const recycle = manager["recycleRunnerHost"].bind(manager);
  manager["recycleRunnerHost"] = (...args) =>
    // After the recycler has counted the result.
    recycle(...args).finally(() => setImmediate(changed));

  const localIds: string[] = [];
  let closure: Promise<void> | undefined;
  const close = () => (closure ??= teardown());
  async function teardown() {
    closed = true;
    closing.resolve();
    changed();
    // A restart under way would spawn into, and write to, what is removed.
    await manager.settleRunnerHostRecycling("r1");
    await Promise.all([...processes.keys()].map(stop));
    for (const id of localIds) {
      await manager.stopAgent(id, { force: true });
      // A local stop signals the host without awaiting its exit.
      const pid = hostPids.get(id);
      while (pid && isRunning(pid)) await delay(25);
    }
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
  // Also when the test times out before it reaches its own close.
  onTestFinished(close);
  return {
    manager,
    reached,
    close,
    launches,
    hostPids,
    commands,
    swapping,
    holdStop,
    holdReply,
    holdReplay,
    wrongSession,
    welcomedReplacement,
    checkout,
    offline: () => {
      online = false;
    },
    async start(
      id: string,
      options: { parent?: string; legacy?: boolean; local?: boolean } = {}
    ) {
      const cwd = checkout(id);
      if (options.local) {
        localIds.push(id);
        mkdirSync(cwd, { recursive: true });
      }
      if (!options.legacy) offeredSupport.add(id);
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, parent_agent_id, worktree_path, runner_id)
         VALUES ($1, $1, 'claude', 'stopped', $2, $3, $4, $5)`,
        [
          id,
          cwd,
          options.parent ?? null,
          options.local ? cwd : null,
          options.local ? "local" : "r1",
        ]
      );
      expect((await manager.startAgent(id)).status).toBe("running");
      if (options.local)
        hostPids.set(
          id,
          Number(readFileSync(path.join(state, id, "host.pid"), "utf8"))
        );
    },
  };
}

it("rolls idle hosts independently, preserves the queue and session, and leaves legacy and local hosts serving", async () => {
  // A settlement during a pass in flight is picked up by the rescan.
  const f = await fixture({ periodicRescan: true });
  const busy = "agt_recycle_busy";
  const idle = "agt_recycle_idle";
  const legacy = "agt_recycle_legacy";
  const local = "agt_recycle_local";
  const stop = Promise.withResolvers<void>();
  const replay = Promise.withResolvers<void>();
  try {
    await f.start(busy);
    await f.start(idle);
    await f.start(legacy, { legacy: true });
    await f.start(local, { local: true });
    const oldPid = f.hostPids.get(busy);
    const localPid = f.hostPids.get(local)!;
    const before = (await f.manager.getAgent(idle))!;
    const cancelSchedules = vi.fn(async () => {});
    f.manager.attachScheduleCancellation(cancelSchedules);
    const {
      rows: [{ host_journal_id: oldJournal }],
    } = await pool.query("SELECT host_journal_id FROM agents WHERE id = $1", [
      idle,
    ]);
    const active = f.manager.promptAgent(busy, "hold-until-signal");
    await active.accepted;
    f.holdStop.set(idle, stop.promise);
    f.manager.startRunnerHostRecycling(update);
    expect(f.manager.runnerHostRecycleProgress("r1")).toEqual({
      oldBuild: 3,
      recycled: 0,
      waiting: 1,
    });
    await f.reached(() => f.swapping.has(idle));
    expect(f.hostPids.get(busy)).toBe(oldPid);
    expect(f.launches.get(busy)).toEqual([null]);
    expect(await f.manager.getTerminalAccess(idle)).toEqual({ mode: "live" });
    const gap = f.manager.promptAgent(idle, "reply during restart");
    await f.manager.promptAgent(local, "local continues").settled;
    expect(() => process.kill(localPid, 0)).not.toThrow();
    expect(f.launches.has(local)).toBe(false);
    expect(
      f.commands.some(
        ({ id, message }) => id === idle && message.type === "prompt"
      )
    ).toBe(false);

    f.holdReplay.set(idle, replay.promise);
    stop.resolve();
    await f.reached(() => f.welcomedReplacement.has(idle));
    await expect(
      Promise.race([
        gap.accepted.then(() => "accepted"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 150)),
      ])
    ).resolves.toBe("waiting");
    expect(f.manager.runnerHostRecycleProgress("r1")?.recycled).toBe(0);
    expect(
      f.commands.some(
        ({ id, message }) => id === idle && message.type === "prompt"
      )
    ).toBe(false);
    replay.resolve();
    await gap.accepted;
    await gap.settled;
    expect(f.launches.get(idle)).toEqual([null, before.cliSessionId]);
    expect((await f.manager.getAgent(idle))?.cliSessionId).toBe(
      before.cliSessionId
    );
    const changed = await pool.query(
      "SELECT host_journal_id FROM agents WHERE id = $1",
      [idle]
    );
    expect(oldJournal).toBeTruthy();
    expect(changed.rows[0]?.host_journal_id).not.toBe(oldJournal);
    expect(
      f.commands.filter(
        ({ id, message }) => id === idle && message.type === "prompt"
      )
    ).toHaveLength(1);

    writeFileSync(path.join(f.checkout(busy), "finish-turn"), "");
    await active.settled;
    await f.reached(
      () => f.manager.runnerHostRecycleProgress("r1")?.recycled === 2
    );
    expect(f.manager.runnerHostRecycleProgress("r1")).toEqual({
      oldBuild: 1,
      recycled: 2,
      waiting: 1,
    });
    expect(f.hostPids.get(busy)).not.toBe(oldPid);
    expect(f.launches.get(busy)).toEqual([null, "sess_1"]);
    await f.manager.promptAgent(busy, "continue this conversation").settled;
    expect(f.launches.get(legacy)).toEqual([null]);
    expect(cancelSchedules).not.toHaveBeenCalled();
    expect(
      f.commands.some(
        ({ id, message }) => id === legacy && message.type === "quiesce"
      )
    ).toBe(false);
  } finally {
    stop.resolve();
    replay.resolve();
    await f.close();
  }
}, 25_000);

it("delivers a child's awaited reply once to the original parent session before recycling", async () => {
  // Nothing signals a child's stop: the rescan finds the parent eligible.
  const f = await fixture({ periodicRescan: true });
  const parent = "agt_waiting_parent";
  const child = "agt_reply_child";
  try {
    await f.start(parent);
    await f.start(child, { parent, legacy: true });
    const pid = f.hostPids.get(parent);
    f.manager.startRunnerHostRecycling(update);
    await f.reached(() =>
      f.commands.some(
        ({ id, message }) => id === parent && message.type === "release_quiesce"
      )
    );
    expect(f.hostPids.get(parent)).toBe(pid);
    const reply = f.manager.promptAgent(parent, "child result", {
      source: "chat",
      chatMessageId: randomUUID(),
      awaited: true,
    });
    await reply.accepted;
    await reply.settled;
    expect(f.hostPids.get(parent)).toBe(pid);
    await f.manager.stopAgent(child);
    await f.reached(
      () => f.manager.runnerHostRecycleProgress("r1")?.recycled === 1
    );
    expect(f.launches.get(parent)).toEqual([null, "sess_1"]);
    expect(
      f.commands.filter(
        ({ id, message }) =>
          id === parent &&
          message.type === "prompt" &&
          message.text.includes("child result")
      )
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 20_000);

it.each(["stop", "archive", "revoke", "cancel"] as const)(
  "%s wins during the lifecycle-locked eligibility check",
  async (action) => {
    const f = await fixture();
    const id = `agt_recycle_${action}`;
    const checking = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    try {
      await f.start(id);
      const getAgent = f.manager.getAgent.bind(f.manager);
      vi.spyOn(f.manager, "getAgent").mockImplementationOnce(
        async (agentId) => {
          checking.resolve();
          await proceed.promise;
          return getAgent(agentId);
        }
      );
      f.manager.startRunnerHostRecycling(update);
      await checking.promise;
      const terminal =
        action === "stop"
          ? f.manager.stopAgent(id)
          : action === "archive"
            ? f.manager.beginArchive(id)
            : undefined;
      if (action === "revoke") f.offline();
      if (action === "cancel") f.manager.stopRunnerHostRecycling("r1");
      proceed.resolve();
      const result = await terminal;
      if (action === "stop") expect(result?.status).toBe("stopped");
      if (action === "archive") expect(result?.status).toBe("archiving");
      if (action !== "stop")
        await f.reached(() =>
          f.commands.some(
            (entry) =>
              entry.id === id && entry.message.type === "release_quiesce"
          )
        );
      expect(f.launches.get(id)).toEqual([null]);
      expect(
        f.commands.some(
          (entry) => entry.id === id && entry.message.type === "shutdown"
        )
      ).toBe(false);
    } finally {
      proceed.resolve();
      await f.close();
    }
  }
);

it("does not hand queued work to a host that resumes a different session", async () => {
  const f = await fixture();
  const id = "agt_recycle_wrong_session";
  const stop = Promise.withResolvers<void>();
  try {
    await f.start(id);
    f.wrongSession.add(id);
    f.holdStop.set(id, stop.promise);
    f.manager.startRunnerHostRecycling(update);
    await f.reached(() => f.swapping.has(id));
    const queued = f.manager.promptAgent(id, "only for the previous session");
    const rejected = expect(queued.accepted).rejects.toThrow("before delivery");
    stop.resolve();
    await rejected;
    await f.manager.settleRunnerHostRecycling("r1");
    expect(await f.manager.getAgent(id)).toMatchObject({
      status: "error",
      cliSessionId: "sess_1",
    });
    expect(
      f.commands.some(
        (entry) => entry.id === id && entry.message.type === "prompt"
      )
    ).toBe(false);
  } finally {
    stop.resolve();
    await f.close();
  }
});

it("does not acquire a lease across an in-flight delivery or send around an acquired hold", async () => {
  const f = await fixture();
  const preparing = Promise.withResolvers<void>();
  const submit = Promise.withResolvers<boolean>();
  const lease = Promise.withResolvers<void>();
  const id = "agt_recycle_pickup_race";
  try {
    await f.start(id);
    const active = f.manager.promptAgent(id, "hold-until-signal", undefined, {
      async beforeSubmit() {
        preparing.resolve();
        return submit.promise;
      },
    });
    await preparing.promise;
    f.manager.startRunnerHostRecycling(update);
    await f.reached(
      () => f.manager.runnerHostRecycleProgress("r1")?.waiting === 1
    );
    expect(f.manager.runnerHostRecycleProgress("r1")).toEqual({
      oldBuild: 1,
      recycled: 0,
      waiting: 1,
    });
    expect(
      f.commands.some(
        (entry) => entry.id === id && entry.message.type === "quiesce"
      )
    ).toBe(false);
    submit.resolve(true);
    await active.accepted;
    f.holdReply.set(id, lease.promise);
    writeFileSync(path.join(f.checkout(id), "finish-turn"), "");
    await active.settled;
    await f.reached(() =>
      f.commands.some(
        (entry) => entry.id === id && entry.message.type === "quiesce"
      )
    );
    const submitted = Promise.withResolvers<void>();
    const queued = f.manager.promptAgent(id, "send to replacement", undefined, {
      async beforeSubmit() {
        submitted.resolve();
        return true;
      },
    });
    const outcome = await Promise.race([
      submitted.promise.then(() => "submitted"),
      new Promise((resolve) => setTimeout(() => resolve("held"), 150)),
    ]);
    expect(outcome).toBe("held");
    lease.resolve();
    await queued.settled;
    expect(f.launches.get(id)).toEqual([null, "sess_1"]);
    expect(
      f.commands.filter(
        (entry) => entry.id === id && entry.message.type === "prompt"
      )
    ).toHaveLength(2);
  } finally {
    submit.resolve(false);
    lease.resolve();
    await f.close();
  }
}, 15_000);

it.each(["stop", "archive"] as const)(
  "%s prevents a replacement after the old host accepted shutdown",
  async (action) => {
    const f = await fixture();
    const id = `agt_recycle_after_commit_${action}`;
    const cleanup = Promise.withResolvers<void>();
    try {
      await f.start(id);
      f.holdStop.set(id, cleanup.promise);
      f.manager.startRunnerHostRecycling(update);
      await f.reached(() => f.swapping.has(id));
      const terminal =
        action === "stop"
          ? f.manager.stopAgent(id)
          : f.manager.beginArchive(id);
      cleanup.resolve();
      expect((await terminal).status).toBe(
        action === "stop" ? "stopped" : "archiving"
      );
      expect(f.launches.get(id)).toEqual([null]);
    } finally {
      cleanup.resolve();
      await f.close();
    }
  }
);

it("logs a concrete runtime refusal once until its reason changes", async () => {
  const f = await fixture();
  const info = vi.spyOn(logger, "info");
  const runtime = f.manager["runtime"];
  const original = runtime.holdForRecycle;
  try {
    await f.start("agt_recycle_diagnostic");
    const host = runtime.runnerHosts?.("r1")[0];
    if (!host) throw new Error("No attached host");
    runtime.holdForRecycle = (_runner, _host, _epoch, refused) => {
      refused?.("delivery_in_progress");
      return null;
    };
    for (let i = 0; i < 2; i++)
      expect(
        await f.manager["recycleRunnerHost"](update, host, () => true)
      ).toBe(false);
    const entries = info.mock.calls.filter(
      ([fields]) =>
        typeof fields === "object" &&
        fields !== null &&
        "reason" in fields &&
        fields.reason === "delivery_in_progress"
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toMatchObject({
      runnerId: "r1",
      agentId: host.agentId,
      attemptId: update.attemptId,
      reason: "delivery_in_progress",
    });
  } finally {
    runtime.holdForRecycle = original;
    info.mockRestore();
    await f.close();
  }
});
