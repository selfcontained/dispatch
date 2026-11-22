import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agents/manager.js";
import {
  encodeMessage,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
} from "../../src/agents/acp/host-protocol.js";
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
const placement = "runner://r1/proof";
let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(async () => teardownTestDb());

async function fixture() {
  const directory = mkdtempSync("/tmp/dr-recycle-");
  const state = path.join(directory, "s");
  const runnerState = path.join(directory, "r");
  vi.stubEnv(
    "DISPATCH_AGENT_HOST_COMMAND",
    JSON.stringify(["bun", main, "agent-host"])
  );
  vi.stubEnv("DISPATCH_ACP_ADAPTER_COMMAND", JSON.stringify(["bun", adapter]));
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
    isManagedWorkspace: () => false,
    selfUpdate: () =>
      online
        ? {
            advert: {
              revision: update.revision,
              installedSha256: update.sha256,
            },
          }
        : undefined,
    async requestSession(_placement, operation) {
      const id = operation.agentId;
      const dir = hostDir(id);
      if (operation.kind === "launch") {
        const attempts = launches.get(id) ?? [];
        attempts.push(operation.launch.resumeSessionId);
        launches.set(id, attempts);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        mkdirSync(checkout(id), { recursive: true });
        const launch = {
          ...operation.launch,
          ...(attempts.length > 1 &&
            wrongSession.has(id) && { resumeSessionId: "different-session" }),
          hostInstanceId: randomUUID(),
          cwd: checkout(id),
          bins: {
            claudeBin: "/bin/echo",
            codexBin: null,
            adapter: { bin: "bun", args: [adapter] },
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
        await vi.waitFor(
          () => expect(existsSync(path.join(dir, "session.json"))).toBe(true),
          { timeout: 5_000 }
        );
        return { value: true };
      }
      if (operation.kind === "alive") return { value: processes.has(id) };
      if (operation.kind === "stop") {
        swapping.add(id);
        await holdStop.get(id);
        await stop(id);
        return { value: true };
      }
      if (operation.kind !== "attach") return { value: "null" };

      const host = net.createConnection(path.join(dir, "host.sock"));
      const outbound = ndjsonDecoder<ClientMessage>();
      const inbound = ndjsonDecoder<HostMessage>();
      const link = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          for (const message of outbound(chunk)) {
            commands.push({ id, message });
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
            if ((launches.get(id)?.length ?? 0) > 1 && message.running)
              welcomedReplacement.add(id);
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
            void pause.then(() => {
              if (!link.destroyed) link.push(encodeMessage(message));
            });
          } else {
            link.push(encodeMessage(message));
          }
        }
      });
      return { value: true, channel: link };
    },
  } satisfies Partial<RemoteRunnerService>;
  const manager = new AgentManager(
    pool,
    logger,
    {
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
      tls: null,
    },
    { remote: remote as unknown as RemoteRunnerService }
  );

  const localIds: string[] = [];
  return {
    manager,
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
      const cwd = options.local ? checkout(id) : placement;
      if (options.local) {
        localIds.push(id);
        mkdirSync(cwd, { recursive: true });
      }
      if (!options.legacy) offeredSupport.add(id);
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, parent_agent_id, worktree_path)
         VALUES ($1, $1, 'claude', 'stopped', $2, $3, $4)`,
        [id, cwd, options.parent ?? null, options.local ? cwd : null]
      );
      expect((await manager.startAgent(id)).status).toBe("running");
      if (options.local)
        hostPids.set(
          id,
          Number(readFileSync(path.join(state, id, "host.pid"), "utf8"))
        );
    },
    async close() {
      manager.stopRunnerHostRecycling("r1");
      await Promise.all([...processes.keys()].map(stop));
      for (const id of localIds) await manager.stopAgent(id, { force: true });
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("rolls idle hosts independently, preserves the queue and session, and leaves legacy and local hosts serving", async () => {
  const f = await fixture();
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
    await vi.waitFor(() => expect(f.swapping.has(idle)).toBe(true), {
      timeout: 4_000,
    });
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
    await vi.waitFor(() => expect(f.welcomedReplacement.has(idle)).toBe(true));
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
    await vi.waitFor(
      () =>
        expect(f.manager.runnerHostRecycleProgress("r1")).toEqual({
          oldBuild: 1,
          recycled: 2,
          waiting: 1,
        }),
      { timeout: 7_000 }
    );
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
  const f = await fixture();
  const parent = "agt_waiting_parent";
  const child = "agt_reply_child";
  try {
    await f.start(parent);
    await f.start(child, { parent, legacy: true });
    const pid = f.hostPids.get(parent);
    f.manager.startRunnerHostRecycling(update);
    await vi.waitFor(() =>
      expect(
        f.commands.some(
          ({ id, message }) =>
            id === parent && message.type === "release_quiesce"
        )
      ).toBe(true)
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
    await vi.waitFor(
      () => expect(f.launches.get(parent)).toEqual([null, "sess_1"]),
      { timeout: 7_000 }
    );
    await vi.waitFor(() =>
      expect(f.manager.runnerHostRecycleProgress("r1")?.recycled).toBe(1)
    );
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
        await vi.waitFor(() =>
          expect(
            f.commands.some(
              (entry) =>
                entry.id === id && entry.message.type === "release_quiesce"
            )
          ).toBe(true)
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
    await vi.waitFor(() => expect(f.swapping.has(id)).toBe(true));
    const queued = f.manager.promptAgent(id, "only for the previous session");
    const rejected = expect(queued.accepted).rejects.toThrow("before delivery");
    stop.resolve();
    await rejected;
    await vi.waitFor(async () =>
      expect(await f.manager.getAgent(id)).toMatchObject({
        status: "error",
        cliSessionId: "sess_1",
      })
    );
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
    await vi.waitFor(() =>
      expect(f.manager.runnerHostRecycleProgress("r1")).toEqual({
        oldBuild: 1,
        recycled: 0,
        waiting: 1,
      })
    );
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
    await vi.waitFor(
      () =>
        expect(
          f.commands.some(
            (entry) => entry.id === id && entry.message.type === "quiesce"
          )
        ).toBe(true),
      { timeout: 3_000 }
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
      await vi.waitFor(() => expect(f.swapping.has(id)).toBe(true));
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
