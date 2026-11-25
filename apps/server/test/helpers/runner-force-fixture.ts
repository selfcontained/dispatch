/**
 * A forced runner update without a runner: the real manager on Postgres, the
 * real ACP runtime, holds and coordinator, over scripted hosts that keep
 * their journal and prompt receipts across a relaunch as a runner's do.
 */
import { localLaunchSettings } from "../../src/agents/acp/launch-env.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { expect, vi } from "vitest";

import {
  encodeMessage,
  ndjsonDecoder,
  type ClientMessage,
  type HostMessage,
  type JournalEntry,
} from "@dispatch/runner-client/host-framing";
import type { PromptSource } from "../../src/agents/acp/prompt-source.js";
import { AgentManager } from "../../src/agents/manager.js";
import {
  RunnerUnavailable,
  type RemoteRunnerService,
  type RunnerUpdateEvent,
} from "../../src/agents/remote/service.js";
import {
  RunnerUpdateCoordinator,
  type RunnerUpdateRecord,
} from "../../src/agents/remote/update-coordinator.js";
import {
  RunnerUpdateHolds,
  type RunnerHoldState,
} from "../../src/agents/remote/update-hold.js";
import { identity, target } from "../runner-update-fixtures.js";
import { trackHoldWork } from "./hold-work.js";
import { localRunnerFor } from "./local-runner-child.js";

export const RUNNER = "r1";
const PLACE = `runner://${RUNNER}/@session`;

export const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  silent: () => {},
  level: "silent",
} as unknown as FastifyBaseLogger;

function socketPair(): [Duplex, Duplex] {
  let a!: Duplex;
  let b!: Duplex;
  const side = (other: () => Duplex) =>
    new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        if (!other().destroyed) other().push(chunk);
        done();
      },
      destroy(error, done) {
        queueMicrotask(() => other().destroy());
        done(error);
      },
    });
  a = side(() => b);
  b = side(() => a);
  return [a, b];
}

type Interrupt =
  /** The engine stops and reports the turn cancelled. */
  | "cancel"
  /** The turn finished just as the interrupt arrived. */
  | "completes"
  /** The engine never settles it. */
  | "ignores"
  /** No reply at all, until the test says. */
  | "silent"
  /** The engine dies of it. */
  | "crashes";

export type Host = {
  id: string;
  sessionId: string;
  alive: boolean;
  instanceId: string;
  /** A pre-phase-3 host has neither a lease nor receipts. */
  legacy: boolean;
  build: { version: string; revision: string };
  recyclable: boolean;
  openPrompt?: string;
  onInterrupt: Interrupt;
  stopFails: boolean;
  /** The channel drops before the stop's exit event is forwarded. */
  stopLosesExit: boolean;
  resumeFails: boolean;
  journal: JournalEntry[];
  turn: { seq: number; startedAt: string; source?: PromptSource } | null;
  receipts: Map<string, "claimed" | "accepted">;
  prompts: { id: string; text: string; source?: PromptSource }[];
  interrupts: number[];
  launches: { launchId?: string; resume: string | null }[];
  stops: number;
  /** Times the runner was asked whether it is alive. */
  asked: number;
  attachFails: boolean;
  socket?: Duplex;
  append(event: object): void;
  startTurn(text?: string, source?: PromptSource): void;
  settle(stopReason?: string): void;
};

export async function forceWorld(pool: Pool) {
  // Short on purpose: each host binds host.sock under here, and unix socket paths
  // are capped (~104 bytes on macOS), which os.tmpdir() would overflow.
  const dir = await mkdtemp("/tmp/dr-force-");
  const hosts = new Map<string, Host>();
  const localAgents = new Map<string, number>();
  const saved = {
    records: [] as RunnerUpdateRecord[],
    holds: { holds: [], resuming: [] } as RunnerHoldState,
    /** Runs before a write lands; throwing fails the write. */
    beforeWrite: undefined as
      | undefined
      | ((next: RunnerUpdateRecord[]) => void),
    /** Runs once a write landed. */
    afterWrite: undefined as undefined | ((now: RunnerUpdateRecord[]) => void),
  };
  /** Every side effect, in the order the runner saw it. */
  const effects: string[] = [];
  let offset = 0;
  const now = () => Date.now() + offset;
  let epoch: number | undefined = 1;
  let connections = 1;
  let installed = { ...identity };
  let pending: string | undefined;
  const runner = {
    automatic: false,
    trust: true,
    holdStaging: false,
    incompatible: false,
    frames: [] as any[],
  };

  function host(id: string): Host {
    const existing = hosts.get(id);
    if (existing) return existing;
    const created: Host = {
      id,
      sessionId: `sess_${id}`,
      alive: false,
      instanceId: randomUUID(),
      legacy: false,
      recyclable: true,
      build: { version: installed.version, revision: installed.revision },
      onInterrupt: "cancel",
      stopFails: false,
      stopLosesExit: false,
      resumeFails: false,
      journal: [],
      turn: null,
      receipts: new Map(),
      prompts: [],
      interrupts: [],
      launches: [],
      stops: 0,
      asked: 0,
      attachFails: false,
      append(event) {
        const entry = {
          seq: created.journal.length + 1,
          at: new Date().toISOString(),
          event: { agentId: id, ...event },
        } as JournalEntry;
        created.journal.push(entry);
        if (created.socket && !created.socket.destroyed)
          created.socket.write(encodeMessage({ type: "event", ...entry }));
      },
      startTurn(text = "work", source) {
        created.turn = {
          seq: created.journal.length + 1,
          startedAt: new Date().toISOString(),
          ...(source && { source }),
        };
        created.append({
          type: "turn",
          state: "started",
          text,
          sessionId: created.sessionId,
          ...(source && { source }),
        });
      },
      settle(stopReason = "end_turn") {
        created.turn = null;
        created.append({ type: "turn", state: "settled", stopReason });
      },
    };
    hosts.set(id, created);
    return created;
  }

  function channel(h: Host) {
    const [ours, theirs] = socketPair();
    h.socket?.destroy();
    h.socket = theirs;
    const send = (message: HostMessage) => {
      if (!theirs.destroyed) theirs.write(encodeMessage(message));
    };
    const decode = ndjsonDecoder<ClientMessage>();
    theirs.on("data", (chunk) => {
      for (const message of decode(chunk)) {
        if (message.type === "hello") {
          send({
            type: "welcome",
            agentId: h.id,
            engine: "claude",
            sessionId: h.sessionId,
            resumed: h.launches.length > 1 && !h.resumeFails,
            running: true,
            turn: h.turn,
            journalSeq: h.journal.length,
            journalId: `journal_${h.id}`,
            interruptSupported: true,
            steeringSupported: true,
            ...(!h.legacy && {
              hostInstanceId: h.instanceId,
              hostBuild: h.build,
              quiesceSupported: h.recyclable,
              promptReceiptSupported: true as const,
            }),
          } as HostMessage);
          for (const entry of h.journal)
            if (entry.seq > message.fromSeq)
              send({ type: "event", ...entry } as HostMessage);
          send({ type: "replay_complete" });
        } else if (message.type === "prompt_receipt") {
          send({
            type: "prompt_receipt_result",
            id: message.id,
            journalId: message.journalId,
            state: h.receipts.get(message.id) ?? "unclaimed",
          });
        } else if (message.type === "prompt") {
          if (!h.legacy && h.receipts.get(message.id) === "claimed") {
            send({
              type: "error",
              id: message.id,
              message: "Prompt execution is unknown; do not resubmit.",
            });
            continue;
          }
          if (!h.legacy && h.receipts.get(message.id) === "accepted") {
            send({ type: "prompt_accepted", id: message.id });
            continue;
          }
          effects.push(`prompt:${h.id}:${message.text}`);
          h.prompts.push({
            id: message.id,
            text: message.text,
            source: message.source,
          });
          h.receipts.set(message.id, "accepted");
          h.startTurn(message.text, message.source);
          send({ type: "prompt_accepted", id: message.id });
          if (message.text !== h.openPrompt) h.settle();
        } else if (message.type === "steer") {
          h.prompts.push({
            id: message.id,
            text: message.text,
            source: message.source,
          });
          send({ type: "steer_result", id: message.id, outcome: "injected" });
          h.settle();
        } else if (message.type === "interrupt") {
          effects.push(`interrupt:${h.id}`);
          h.interrupts.push(message.turnSeq);
          if (h.onInterrupt === "silent") continue;
          const current = h.turn?.seq === message.turnSeq;
          if (current && h.onInterrupt === "crashes") {
            exit(h, false);
            continue;
          }
          if (current && h.onInterrupt === "completes") h.settle("end_turn");
          send({ type: "interrupt_result", id: message.id });
          if (current && h.onInterrupt === "cancel") h.settle("cancelled");
        } else if (message.type === "quiesce") {
          send({
            type: "quiesce_result",
            id: message.id,
            state: h.turn ? "busy" : "idle",
          });
        } else if (message.type === "shutdown" && "quiesceId" in message) {
          send({
            type: "quiesce_shutdown_result",
            id: message.quiesceId,
            accepted: !h.turn,
          });
          if (!h.turn) exit(h);
        } else if (message.type === "release_quiesce") {
          // The scripted host has no persistent quiesce lease.
        }
      }
    });
    return ours;
  }

  function exit(h: Host, expected = true) {
    if (!h.alive) return;
    h.turn = null;
    if (expected && h.stopLosesExit) {
      h.socket?.destroy();
      h.socket = undefined;
    }
    h.append({
      type: "exit",
      code: expected ? 0 : 1,
      signal: null,
      stderrTail: "",
      expected,
    });
    h.alive = false;
    const socket = h.socket;
    h.socket = undefined;
    setImmediate(() => socket?.destroy());
  }

  function controller(build = target) {
    let dead = false;
    const guard = () => {
      if (dead || epoch === undefined) throw new RunnerUnavailable("offline");
    };
    const channels = new Set<Duplex>();
    const remote = {
      available: () => !dead && epoch !== undefined,
      connectionEpoch: () => (dead ? undefined : epoch),
      isManagedWorkspace: () => true,
      originFor: () => "https://example.test",
      supportsSessionFiles: () => true,
      reconcilesLaunches: () => true,
      selfUpdate: () => service.selfUpdate(),
      async requestSession(
        _placement: unknown,
        operation: { kind: string; agentId: string; launch?: any }
      ) {
        guard();
        if (operation.kind === "sessionFile")
          return { value: "/runner/files/x" };
        const h = host(operation.agentId);
        switch (operation.kind) {
          case "launch": {
            const { launchId, resumeSessionId } = operation.launch;
            h.launches.push({ launchId, resume: resumeSessionId ?? null });
            effects.push(`launch:${h.id}`);
            if (!h.alive) {
              h.instanceId = randomUUID();
              h.build = {
                version: installed.version,
                revision: installed.revision,
              };
            }
            h.alive = true;
            return { value: true };
          }
          case "attach": {
            if (!h.alive) throw new RunnerUnavailable("no host");
            if (h.attachFails) throw new Error("attach failed");
            const socket = channel(h);
            channels.add(socket);
            return { value: true, channel: socket };
          }
          case "alive":
            h.asked++;
            return { value: h.alive };
          case "stop":
            h.stops++;
            if (h.stopFails) throw new RunnerUnavailable("stop failed");
            effects.push(`stop:${h.id}`);
            exit(h);
            return { value: true };
          case "log":
            return { value: "" };
          default:
            return { value: true };
        }
      },
    } as unknown as RemoteRunnerService;

    const holds = new RunnerUpdateHolds({
      store: {
        read: async () => structuredClone(saved.holds),
        async write(state) {
          if (dead) throw new Error("controller stopped");
          saved.holds = structuredClone(state);
        },
      },
      logger,
      now,
    });
    const work = trackHoldWork(holds);
    const config = {
      host: "127.0.0.1",
      port: 6767,
      databaseUrl: "",
      authToken: "test-token",
      filesRoot: path.join(dir, "files"),
      dispatchBinDir: path.join(dir, "bin"),
      codexBin: "/bin/echo",
      claudeBin: "/bin/echo",
      opencodeBin: "/bin/opencode",
      agentStateRoot: path.join(dir, "agents"),
      agentRuntime: "acp",
      acpAdapter: {
        bin: "bun",
        args: [
          fileURLToPath(new URL("./recycle-acp-fixture.ts", import.meta.url)),
        ],
      },
      tls: null,
    } satisfies ConstructorParameters<typeof AgentManager>[2];
    const manager = new AgentManager(pool, logger, config, { remote, holds });
    manager.attachLocalRunner(
      () =>
        localRunnerFor(config.agentStateRoot, localLaunchSettings(config))
          .session
    );
    let receive: ((event: RunnerUpdateEvent) => unknown) | undefined;
    let connected: ((runnerId: string) => unknown) | undefined;
    const frame = (value: object) => {
      guard();
      runner.frames.push(value);
      return { epoch: epoch! };
    };
    const status = (value: object) =>
      setImmediate(() => {
        if (dead || epoch === undefined) return;
        receive?.({
          runnerId: RUNNER,
          epoch,
          status: {
            type: "update_status",
            installed: {
              version: installed.version,
              revision: installed.revision,
              sha256: installed.sha256,
            },
            ...value,
          },
        } as RunnerUpdateEvent);
      });
    const service = {
      isRegistered: () => true,
      automaticUpdates: () => runner.automatic,
      async setAutomaticUpdates(_id: string, automatic: boolean) {
        runner.automatic = automatic;
      },
      connectedRunnerIds: () => (epoch === undefined ? [] : [RUNNER]),
      connectionEpoch: remote.connectionEpoch,
      selfUpdate: () =>
        dead || epoch === undefined
          ? undefined
          : {
              epoch,
              advert: {
                protocol: 1,
                os: "linux",
                arch: "x64",
                version: installed.version,
                revision: installed.revision,
                installedSha256: installed.sha256,
                handoff: { reads: [1, 2], writes: 2 },
                ...(pending && { pendingAttemptId: pending }),
              },
            },
      onConnectionChange(listener: (runnerId: string) => unknown) {
        connected = listener;
        return () => (connected = undefined);
      },
      onUpdateStatus(listener: (event: RunnerUpdateEvent) => unknown) {
        receive = listener;
        return () => (receive = undefined);
      },
      offerUpdate(_runner: string, attemptId: string) {
        if (!runner.holdStaging)
          status({ attemptId, phase: "deferred", reason: "ready" });
        return frame({ type: "offer", attemptId });
      },
      fenceUpdate(_runner: string, attemptId: string, retainSessions: boolean) {
        const live = [...hosts.values()].filter((h) => h.alive);
        const retained = live
          .filter((h) => !h.legacy)
          .map((h) => ({ sessionId: h.id, instanceId: h.instanceId }));
        status({
          attemptId,
          phase: "deferred",
          retained,
          ...(retainSessions && runner.incompatible
            ? { reason: "incompatible_handoff", requiresQuiescence: true }
            : !retainSessions && live.length
              ? { reason: "operations_pending" }
              : { reason: "fence_ready" }),
        });
        return frame({ type: "fence", attemptId, retainSessions });
      },
      activateUpdate(_runner: string, attemptId: string) {
        effects.push("activate");
        return frame({ type: "activate", attemptId });
      },
      confirmUpdate(_runner: string, attemptId: string) {
        pending = undefined;
        status({ attemptId, phase: "confirmed" });
        return frame({ type: "confirm", attemptId });
      },
      cancelUpdate(_runner: string, attemptId: string) {
        if (pending === attemptId) pending = undefined;
        status({ attemptId, phase: "deferred", reason: "cancelled" });
        return frame({ type: "cancel", attemptId });
      },
    };
    const coordinator = new RunnerUpdateCoordinator({
      service: service as never,
      holds,
      agents: manager,
      artifacts: () =>
        ({
          updateEnabled: runner.trust,
          getUpdate: async () => ({
            manifest: { sha256: target.sha256, version: build.version },
          }),
        }) as never,
      build: { version: build.version, revision: build.revision },
      logger,
      now,
      store: {
        read: async () => structuredClone(saved.records),
        async write(records) {
          if (dead) throw new Error("controller stopped");
          saved.beforeWrite?.(records);
          saved.records = structuredClone(records);
          saved.afterWrite?.(records);
        },
      },
    });
    return {
      manager,
      holds,
      work,
      coordinator,
      status,
      reconnected: () => connected?.(RUNNER),
      disconnect() {
        for (const socket of channels) socket.destroy();
        channels.clear();
      },
      kill() {
        if (dead) return;
        dead = true;
        coordinator.close();
        holds.close();
        work.abandon();
        for (const socket of channels) socket.destroy();
        channels.clear();
      },
    };
  }

  let current = controller();
  const made: string[] = [];
  await current.holds.load();
  await current.coordinator.load();
  current.holds.start();
  await current.coordinator.start();

  const runtime = () => (current.manager as any).runtime;
  const recorded = async () => {
    for (const id of made) await runtime().runnerTurn(id);
  };

  const api = {
    hosts,
    saved,
    effects,
    runner,
    recorded,
    get manager() {
      return current.manager;
    },
    get coordinator() {
      return current.coordinator;
    },
    get holds() {
      return current.holds;
    },
    advance(ms: number) {
      offset += ms;
    },
    async agent(options: { legacy?: boolean; recyclable?: boolean } = {}) {
      const agent = await current.manager.createAgent(
        { cwd: PLACE },
        {
          beforeLaunch: async (id) => {
            host(id).legacy = options.legacy === true;
            host(id).recyclable = options.recyclable ?? true;
          },
        }
      );
      made.push(agent.id);
      const h = host(agent.id);
      await vi.waitFor(async () => {
        expect((await current.manager.getAgent(agent.id))?.status).toBe(
          "running"
        );
        expect(h.turn).toBeNull();
        expect(runtime().isBusy(agent.id)).toBe(false);
      });
      await recorded();
      h.prompts.length = 0;
      return h;
    },
    async localAgent() {
      const cwd = path.join(dir, "local");
      await mkdir(cwd, { recursive: true });
      vi.stubEnv(
        "DISPATCH_AGENT_HOST_COMMAND",
        JSON.stringify([
          "bun",
          fileURLToPath(new URL("../../src/main.ts", import.meta.url)),
          "agent-host",
        ])
      );
      const id = `agt_local_${randomUUID().slice(0, 12)}`;
      await pool.query(
        `INSERT INTO agents (id, name, type, status, cwd, worktree_path)
         VALUES ($1, $1, 'claude', 'stopped', $2, $2)`,
        [id, cwd]
      );
      const agent = await current.manager.startAgent(id);
      const hostDir = path.join(dir, "agents", id);
      const pidFile = path.join(hostDir, "host.pid");
      const pid = Number(await readFile(pidFile, "utf8"));
      localAgents.set(id, pid);
      return {
        async assertContinues(marker: string) {
          await current.manager.promptAgent(id, marker).settled;
          const journal = await readFile(
            path.join(hostDir, "journal.jsonl"),
            "utf8"
          );
          const events = journal
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).event);
          expect(
            events.filter(
              (event) =>
                event?.type === "turn" &&
                event.state === "started" &&
                event.text === marker
            )
          ).toHaveLength(1);
          expect(Number(await readFile(pidFile, "utf8"))).toBe(pid);
          expect(await current.manager.getAgent(id)).toMatchObject({
            status: "running",
            cliSessionId: agent.cliSessionId,
          });
        },
      };
    },
    /** An open turn Dispatch has recorded. */
    async working(h: Host, source?: PromptSource) {
      h.startTurn("work", source);
      await vi.waitFor(() => expect(runtime().hasOpenTurn(h.id)).toBe(true));
      await recorded();
      return h.turn!.seq;
    },
    prompt(h: Host, text: string) {
      const { accepted, settled } = runtime().prompt(h.id, text, {
        source: "system",
        text,
      });
      settled.catch(() => {});
      accepted.catch(() => {});
      return { accepted: accepted as Promise<void> };
    },
    attempt: () => saved.records[0]?.attempt,
    entry: (id: string) =>
      saved.records[0]?.attempt.drain?.agents.find((e) => e.id === id),
    view: () => current.coordinator.view(RUNNER),
    /** Tick until true, without moving the clock. */
    async until(check: () => unknown, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await check())) {
        if (Date.now() > deadline)
          throw new Error(
            `not reached: ${check}\nview ${JSON.stringify(
              current.coordinator.view(RUNNER)
            )}\neffects ${effects.join(", ")}`
          );
        await current.coordinator.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    activated: () => api.until(() => effects.includes("activate")),
    /** The updater swaps, and the trial is confirmed. */
    swap() {
      installed = {
        ...installed,
        version: target.version,
        revision: target.revision,
        sha256: target.sha256,
      };
      current.status({
        attemptId: api.attempt()!.id,
        phase: "activating",
        reason: "trial",
        retained: api.attempt()!.retained ?? [],
      });
    },
    rollBack() {
      installed = { ...identity };
      api.report("rolled_back", "boot_failed");
    },
    report(phase: string, reason?: string) {
      current.status({
        attemptId: api.attempt()!.id,
        phase,
        ...(reason && { reason }),
      });
    },
    disconnect() {
      epoch = undefined;
      current.disconnect();
    },
    reconnect(pendingAttempt?: string) {
      pending = pendingAttempt;
      epoch = ++connections;
      current.reconnected();
    },
    crash: () => current.kill(),
    /** A new Dispatch process, as server.ts starts one. */
    async restart({
      olderBuild = false,
      readAttempts,
    }: {
      olderBuild?: boolean;
      readAttempts?: () => Promise<RunnerUpdateRecord[]>;
    } = {}) {
      current.kill();
      if (readAttempts) saved.records = await readAttempts();
      current = controller(olderBuild ? identity : target);
      await current.holds.load();
      await current.coordinator.load();
      await current.manager.restoreRunningAgents();
      await current.manager.reconcileAgentStatuses();
      current.holds.start();
      await current.coordinator.start();
    },
    async close() {
      saved.beforeWrite = saved.afterWrite = undefined;
      // Let the pass in flight finish before its hosts go away.
      current.coordinator.close();
      await current.coordinator.tick();
      for (const hold of saved.holds.holds)
        await current.holds.release(hold.runnerId, hold.attemptId, "cancelled");
      await current.work.settled();
      await current.manager.settleRunnerHostRecycling(RUNNER);
      for (const [id, pid] of localAgents) {
        await current.manager.stopAgent(id, { force: true });
        await vi.waitFor(() => {
          expect(() => process.kill(pid, 0)).toThrow();
        });
      }
      if (localAgents.size) vi.unstubAllEnvs();
      await recorded().catch(() => {});
      current.kill();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return api;
}
